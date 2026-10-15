import {createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {identity} from './catalog.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Ids of items the bridge creates carry a mark that OpenAI's hex ids never
// contain, so the gateway can recognize Claude's items in requests for GPT.
export const uid = prefix => `${prefix}_claude${randomUUID().replaceAll('-', '')}`;
export const isBridgeId = id => typeof id === 'string' && /^[a-z]+_claude[0-9a-f]{32}$/.test(id);

export function validateRequestOptions(body) {
  const unsupported=[];
  if(body.tool_choice!=null&&body.tool_choice!=='auto'&&!(body.tool_choice==='none'&&!body.tools?.length))unsupported.push('tool_choice other than auto');
  const format=body.text?.format;
  if(format&&!['text','json_schema','json_object'].includes(format.type))unsupported.push(`text.format ${format.type}`);
  if(format?.type==='json_schema'&&(!format.schema||typeof format.schema!=='object'))unsupported.push('text.format json_schema without a schema');
  if(body.max_output_tokens!=null)unsupported.push('max_output_tokens');
  if(unsupported.length)throw Object.assign(new Error('Unsupported request constraint: '+unsupported.join(', ')+'. The bridge will not silently ignore it.'),{statusCode:400});
}

// Claude Code enforces this natively with --json-schema and returns the
// validated value in result.structured_output. Its validator rejects the
// desktop's draft 2020-12 $schema tag, which does not change validation here.
export function outputSchema(body) {
  const format=body.text?.format;
  if(format?.type==='json_schema'){const {$schema,...schema}=format.schema;return schema;}
  if(format?.type==='json_object')return {type:'object'};
  return null;
}

// A checkpoint belongs to the bridge, not to one model, so a thread can switch
// between Claude models and still continue from it.
export function sealCheckpoint(summary, token) {
  const iv=randomBytes(12), key=createHash('sha256').update(token).digest();
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  const bytes=Buffer.concat([cipher.update(JSON.stringify({version:2,summary}),'utf8'),cipher.final()]);
  return 'claude-bridge-v1:'+Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64url');
}
export function openCheckpoint(value, token) {
  if(!value.startsWith('claude-bridge-v1:'))throw new Error('This checkpoint was created by another provider. Start a new Claude task.');
  const bytes=Buffer.from(value.slice('claude-bridge-v1:'.length),'base64url');
  const decipher=createDecipheriv('aes-256-gcm',createHash('sha256').update(token).digest(),bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  const data=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
  if(![1,2].includes(data.version)||typeof data.summary!=='string')throw new Error('Invalid compaction checkpoint.');
  return data.summary;
}

// A checkpoint sealed under another bridge token, as after a reinstall that
// deleted the data folder, cannot be opened. The thread goes on from the
// messages kept after it instead of failing on every request.
export function checkpointText(value, token) {
  try {return '<context_checkpoint>\n'+openCheckpoint(value, token)+'\n</context_checkpoint>\nContinue the existing task from this checkpoint.';}
  catch {return '<context_checkpoint>Earlier conversation was compacted by Claude, but its summary was sealed by an earlier installation of the bridge and cannot be read here; the messages kept after it follow. Ask the user if something important is missing.</context_checkpoint>';}
}

// Codex constrains GPT's apply_patch output with a Lark grammar that an MCP
// schema cannot carry, and documents the tool only as FREEFORM. Without the
// format, Opus left out *** End Patch or sent two patches in one call.
export const APPLY_PATCH_GUIDE=`apply_patch input format. The input is the raw patch text:
*** Begin Patch
*** Update File: path/to/file.py
@@ def a_line_near_the_change():
 unchanged context line (starts with one space)
-line to remove, exactly as it appears in the file
+line to add
 unchanged context line
*** Add File: path/to/new_file.txt
+every line of the new file starts with +
*** Delete File: path/to/old_file.txt
*** End Patch
Rules: the first line is *** Begin Patch and the last line is exactly *** End Patch. Inside an Update File section every line starts with a space, - or +. Context and - lines must match the current file exactly, including indentation. Give about 3 unchanged lines before and after each change and start a new @@ section for each separate place in the file; the @@ text is optional and only helps locate the change. Paths are absolute or relative to the working directory. To rename, put *** Move to: new/path right after the Update File line.`;
// In code mode Opus passes patches and scripts as JavaScript strings. File
// content with backticks or ${...} broke template literals.
// Opus batches several commands per cell. One oversized result (grep on a
// one-line JSON file) pushed the whole cell past its budget and the middle cut
// hid the other commands' results.
export const EXEC_OUTPUT_NOTE='Everything one exec cell prints shares one output budget (max_output_tokens, 10,000 tokens by default), and the host cuts text from the middle when it is exceeded. When a cell runs several commands, keep each result small (head, grep -c, wc -l, or max_output_tokens on each exec_command) and run anything that may print a lot, such as grep on a minified or single-line file, in its own cell, so one large result cannot hide the others.';
export const EXEC_STRING_NOTE='In exec, JavaScript template literals interpret backslashes, backticks and ${...}. When a patch, file body or shell script contains any of them, escape them (\\\\, \\`, \\${) or build the string without a template literal, so the text reaches the tool unchanged.';
const APPLY_PATCH_DOC='The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';

function toolDescription(t) {
  const description=t.description??'';
  if(t.type!=='custom')return description;
  if(t.name==='apply_patch')return description+'\n\n'+APPLY_PATCH_GUIDE;
  if(t.name==='exec'&&description.includes('apply_patch')) {
    const withGuide=description.includes(APPLY_PATCH_DOC)?description.replace(APPLY_PATCH_DOC,APPLY_PATCH_DOC+'\n\n'+APPLY_PATCH_GUIDE):description+'\n\n'+APPLY_PATCH_GUIDE;
    return withGuide+'\n\n'+EXEC_STRING_NOTE+'\n\n'+EXEC_OUTPUT_NOTE;
  }
  return description;
}

export function normalizeTools(tools = [], namespace = '') {
  return tools.flatMap(t => {
    if (t.type === 'namespace') return normalizeTools(t.tools, t.name);
    if (!['function', 'custom'].includes(t.type)) {
      throw new Error(`Unsupported provider-native tool: ${t.type}. Expose it through the desktop tool runtime.`);
    }
    const originalName = namespace ? `${namespace}.${t.name}` : t.name;
    const name = originalName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return [{ name, originalName, hostName:t.name, namespace:namespace||undefined, type: t.type, description: toolDescription(t),
      inputSchema: t.type === 'custom'
        ? {type: 'object', properties: {input: {type: 'string', description: 'The exact raw tool input. Do not add code fences.'}}, required: ['input'], additionalProperties: false}
        : t.parameters ?? {type: 'object', properties: {}},
    }];
  });
}

export function imageBlock(url) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(url ?? '');
  if (!match) throw new Error('An image must be supplied inline as a data URL; remote images are not silently discarded.');
  return {type: 'image', source: {type: 'base64', media_type: match[1], data: match[2]}};
}

// An image from the user's ChatGPT files arrives as a file id that only
// OpenAI can open. Failing on it broke the thread for Claude for good, since
// every later request carries it, even one GPT answered first.
const fileImageNote = id => `[An image from the user's ChatGPT files (${id}) was attached here. Claude cannot open ChatGPT files, so it is not shown. If it matters, ask the user to attach the image itself.]`;
export function contentBlocks(content) {
  if (typeof content === 'string') return [{type: 'text', text: content}];
  return (content ?? []).map(c => {
    if (['input_text', 'output_text', 'text'].includes(c.type)) return {type: 'text', text: c.text};
    if (c.type === 'input_image' && !c.image_url && typeof c.file_id === 'string') return {type: 'text', text: fileImageNote(c.file_id)};
    if (c.type === 'input_image') return imageBlock(c.image_url);
    if (c.type === 'image' && c.data) return {type: 'image', source: {type: 'base64', media_type: c.mimeType, data: c.data}};
    // GPT's refusals stay in a shared thread's history.
    if (c.type === 'refusal') return {type: 'text', text: `[Refused: ${c.refusal ?? ''}]`};
    // Any other part is shown as text rather than dropped or failing the
    // thread on every request. Long values such as file data are left out.
    return {type: 'text', text: JSON.stringify({content_part: c}, (k, v) => typeof v === 'string' && v.length > 2000 ? `[${v.length} characters left out]` : v)};
  });
}

export function mcpResult(output) {
  return {content: contentBlocks(output).map(c => c.type === 'image'
    ? {type: 'image', data: c.source.data, mimeType: c.source.media_type} : c)};
}

export const isResult = item => ['function_call_output', 'custom_tool_call_output'].includes(item.type);
// The desktop delivers a message from another thread (send_message_to_thread,
// a thread that create_thread or handoff_thread started) as a turn's tool
// output: a function_call_output with name and namespace and no call_id, which
// no call of this model made. For the receiving thread it is new input.
// MCP apps and interactive widgets share context the same way, before a turn
// starts (thread/inject_items): a call the desktop writes itself, named
// untrusted_input with a call id untrusted_input_… or visualization_state_…,
// and its output. Neither Claude nor another model made that call.
export const isHostCall = item => item.type === 'function_call' && item.name === 'untrusted_input';
const HOST_CALL_ID = /^(untrusted_input|visualization_state)_/;
export const isHostOutput = item => isResult(item) && (item.call_id == null || HOST_CALL_ID.test(item.call_id));
// Output of a tool call this conversation made.
export const isCallResult = item => isResult(item) && !isHostOutput(item);
// Multi-agent v2 delivers tasks and results between agents as agent_message
// items. For the receiving agent they are new input, like a user message.
export const isIncoming = item => item.type === 'agent_message' || (item.type === 'message' && item.role === 'user') || isHostOutput(item);
export const inputKey = item => item.id ?? digest(item.content ?? item.output);
const hostOutputText = item => {
  const tool = item.call_id == null ? [item.namespace, item.name].filter(Boolean).join('.') || 'unknown' : 'untrusted_input';
  return `<host_tool_output tool="${tool}">The host delivered this as the output of ${tool}, which you did not call. It is new input for you, such as a message from another task or what an app shared.`;
};
// The desktop adds developer notes as a thread goes on (the date, skills, the
// open page, an image resize, an interrupted turn), and GPT reads each where it
// appears. Only those before the conversation starts form Claude's system prompt.
// Folding later ones in changed the prompt mid-thread, which rebuilt a live
// tool cycle or made Claude rewrite the whole prompt cache on the next turn.
export const isDeveloper = item => item.type === 'message' && ['developer', 'system'].includes(item.role);
const leadingEnd = input => {const i = input.findIndex(x => !isDeveloper(x)); return i < 0 ? input.length : i;};
// The payload arrives as encrypted_content; with this provider it holds the
// plain text the sending agent wrote.
function agentMessageText(item) {
  const body = (item.content ?? []).map(c => c.type === 'encrypted_content' ? c.encrypted_content : c.text ?? '').join('');
  return `<agent_message author="${item.author}" recipient="${item.recipient}">\n${body}\n</agent_message>`;
}
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
// A search the bridge ran for Claude is display only: Claude Code has the
// call and its result, and history matching does not depend on whether the
// desktop keeps the item.
export const isBridgeSearch = item => item.type === 'web_search_call' && isBridgeId(item.id);
export function semantic(item) {
  if (['reasoning','compaction_trigger'].includes(item.type) || item.type==='message'&&['system','developer'].includes(item.role) || isBridgeSearch(item)) return null;
  const {id, status, phase, channel, internal_chat_message_metadata_passthrough, ...value} = item;
  if(value.type==='message')value.content=contentBlocks(value.content);
  if(isResult(value))value.output=contentBlocks(value.output);
  if(value.type==='function_call') {
    try{value.arguments=JSON.parse(value.arguments);}catch{}
  }
  return stable(value);
}
export const historyItems = input => input.map(semantic).filter(Boolean);
export const historyFingerprint = input => digest(historyItems(input));
export const historyStamp = input => ({length:historyItems(input).length,fingerprint:historyFingerprint(input)});
export const extendsHistory = (input, stamp) => {
  const history=historyItems(input);
  return !!stamp && history.length>=stamp.length && digest(history.slice(0,stamp.length))===stamp.fingerprint;
};
// Developer notes after the start of the conversation and after the history a
// stamp covers, so a note reaches Claude once, where the desktop placed it.
// Index just past the input items a history stamp covers.
export function historyEnd(input, stamp) {
  if (!stamp?.length) return 0;
  let n = 0;
  for (const [i, x] of input.entries()) if (semantic(x) && ++n === stamp.length) return i + 1;
  return input.length;
}
export function newNotes(input, stamp) {
  const from = historyEnd(input, stamp);
  const start = leadingEnd(input);
  return input.filter((x, i) => i > start && i >= from && isDeveloper(x));
}
// In picker mode GPT can answer between two Claude turns. Its messages and
// tool activity after the history a stamp covers are what the native session
// never saw. Reasoning items are encrypted for GPT and are left out.
export function otherModelTurns(input, stamp) {
  const since = input.slice(historyEnd(input, stamp));
  return since.some(x => !isIncoming(x) && !isDeveloper(x) && !isHostCall(x) && !isBridgeSearch(x) && !['reasoning', 'compaction_trigger'].includes(x.type)) ? since : null;
}
export const OTHER_MODEL_NOTE = '<other_model_turns>Another model continued this conversation after your last turn. Its messages and tool activity follow as history, then the new message.</other_model_turns>';
// What the desktop added after a stopped turn that its native session never
// received: user and agent messages, developer notes (the desktop notes the
// interruption) and host tool output that was not relayed. Claude Code already
// recorded its own answer and tool calls, finished or not.
export function afterStop(input, stamp, seen = [], delivered = []) {
  if (!extendsHistory(input, stamp)) return null;
  return input.slice(historyEnd(input, stamp)).filter(x =>
    isIncoming(x) ? !seen.includes(inputKey(x)) : isResult(x) ? !delivered.includes(x.call_id) : isDeveloper(x));
}
// When the user edits or withdraws a message that was stopped before it was
// answered, the desktop drops the stopped turn and sends the conversation as it
// stood before that turn plus a new message. The new items, when the request
// is exactly that: the earlier history unchanged, then only new user or agent
// messages and developer notes.
export function afterWithdrawn(input, stamp, seen = []) {
  if (!stamp || !extendsHistory(input, stamp)) return null;
  const added = input.slice(historyEnd(input, stamp));
  if (!added.every(x => isIncoming(x) || isDeveloper(x) || isBridgeSearch(x)) || !added.some(x => isIncoming(x) && !seen.includes(inputKey(x)))) return null;
  return added;
}
// Why a turn ended unfinished, besides a Stop. An API error (an overload, a
// usage limit, an expired login) ends the turn after Claude Code has recorded
// its input. Claude Code can also exit on its own while the host runs a tool,
// as when a restart signals it before the bridge.
export const API_FAILED = 'api_error';
export const CLAUDE_EXITED = 'claude_exited';
const RESTART = 'Bridge shutting down.';
// Claude Code marks a stopped turn's unanswered tool calls as rejected by the
// user and the turn as interrupted by the user. When the host or a restart
// stopped it, Opus took the marks at their word: 4 of 4 checkpoints of a turn
// paused for compaction said the user had rejected the calls, and each next
// window waited for the user instead of carrying on.
const STOP_MARKS='The user did not reject, stop or interrupt anything. Claude Code wrote the "The user doesn\'t want to proceed" tool results, "[Request interrupted by user for tool use]" and any "No response requested." reply because of this, not because of anything the user did.';
// The desktop notes a Stop as <turn_aborted>. A restart can cut off a turn the
// user had already stopped, and then the user did stop it.
export const userStopped = items => items.some(x => isDeveloper(x) && contentBlocks(x.content).some(c => c.text?.includes('<turn_aborted')));
const hostStopped = (items, reason) => reason === 'compacted_mid_turn' || [RESTART, CLAUDE_EXITED].includes(reason) && !userStopped(items);
// Claude Code answers the call it was waiting on with an error such as "MCP
// server is not connected" when it is terminated, or as rejected when it is
// interrupted.
const EXIT_MARKS = 'Claude Code stopped waiting for a host tool call, for example because a bridge restart stopped it. '+STOP_MARKS+' An error for that call, such as "MCP server is not connected", also came from this, not from the host.';
const failedNote = ({status}) => `ended with an API error${status ? ` (status ${status})` : ''} before it finished. The user did not stop it, and the conversation up to the error is intact.`;
// A compaction that forks a stopped turn sees the same marks. Without a note,
// the checkpoint could record calls the host ran as never run.
export function stoppedTurnNote(items, {reason, sent = 0, status}) {
  const ran = items.filter(isCallResult).length;
  if (reason === API_FAILED)
    return [{type: 'text', text: `<turn_stopped>Your turn here ${failedNote({status})}${ran ? ' The host ran each tool call whose output follows.' : ''} The checkpoint should record the task as still in progress, continuing from here.</turn_stopped>`}];
  if (!hostStopped(items, reason))
    return ran ? [{type: 'text', text: '<turn_stopped>Your turn was stopped before it finished. A tool call shown as rejected or interrupted ran in the host if output for it follows.</turn_stopped>'}] : [];
  const parts = [reason === 'compacted_mid_turn' ? 'The host paused your turn here to compact the conversation.' : reason === CLAUDE_EXITED ? 'Your turn was cut off here. '+EXIT_MARKS : 'Your turn was cut off here by a bridge restart.', ...(reason === CLAUDE_EXITED ? [] : [STOP_MARKS])];
  if (ran) parts.push('The host ran each tool call whose output follows, so that output is the call\'s normal result.');
  if (ran < sent) parts.push('A call shown as rejected with no output here may have run in part or in full, so the checkpoint should say to check its effects before relying on it or running it again.');
  parts.push('The checkpoint should leave out the pause and these marks, and record the task as still in progress, continuing from here.');
  return [{type: 'text', text: `<turn_stopped>${parts.join(' ')}</turn_stopped>`}];
}
// A message sent while a response streams makes the desktop cancel the
// response and sample again with the message appended, a mid-turn message with
// no <turn_aborted> note. Told the turn was stopped, Opus answered the message
// and waited for a go: 44 of 48 such resumes from October 9 to 11, 2026 carried
// only the message.
export const resampledSteer = (items, reason) => reason === 'Desktop cancelled or disconnected.' && items.some(isIncoming) && !items.some(isCallResult) && !userStopped(items);
export function resumeAfterStop(items, {reason, sent = 0, status}) {
  if (resampledSteer(items, reason)) {
    const parts = ['The desktop restarted your response to deliver the message below, which the user sent while you were working. The user did not stop you: Claude Code marked the response as interrupted by the user because of this restart.'];
    if (sent) parts.push('A tool call shown as rejected had already reached the host, which may have run it in part or in full. Check its effects before relying on it or running it again.');
    parts.push('Carry on with the task, taking the message into account.');
    return [{type: 'text', text: `<turn_stopped>${parts.join(' ')}</turn_stopped>`}, ...steeringPrompt(items)];
  }
  const parts = [reason === API_FAILED ? 'Your previous attempt at this turn '+failedNote({status})
    : !hostStopped(items, reason) ? 'Your previous turn was stopped before it finished.'
    : reason === CLAUDE_EXITED ? 'Your previous turn was cut off. '+EXIT_MARKS : 'Your previous turn was cut off by a bridge restart. '+STOP_MARKS];
  if (items.some(isCallResult)) parts.push('A tool call shown as rejected or interrupted may still have run in the host. The output the host recorded follows.');
  else if (sent) parts.push('A tool call shown as rejected had already reached the host, which may have run it in part or in full. Check its effects before relying on it or running it again.');
  if (!items.some(isIncoming)) parts.push('Continue the task from where it stopped.');
  return [{type: 'text', text: `<turn_stopped>${parts.join(' ')}</turn_stopped>`},
    ...items.flatMap(x => userInput([x], {replay: isCallResult(x), prefix: false}))];
}

// Claude Code adds its own environment note naming the bridge's private empty
// folder as the working directory, which contradicts the desktop's cwd.
const CWD_NOTE='Claude Code’s environment note names a private empty folder as the working directory. Ignore it: the working directory is the cwd in <environment_context>.';
// Codex refuses rm -f style commands outright when approvals are off. Opus
// habitually cleans up with rm -rf, which lost whole chained commands.
const HOST_POLICY_NOTE='The host refuses any shell command containing rm -f or rm -rf, and refuses the whole command line, including anything chained with it. Use rm -r, plain rm or trash instead.';
// Benchmarks showed Opus reading PDFs as text only (missing an image stamp),
// then rendering pages next to the PDF inside the user's project, and losing
// time to background jobs the host kills when the command returns.
const TOOL_HABITS_NOTE='To read a PDF, render its pages to images in a new temporary directory (for example pdftoppm -png -r 100 file.pdf "$(mktemp -d)/page") and look at them with view_image, because text extraction misses stamps, scans and handwriting. Keep the renders out of the user’s project. Background processes started with & or nohup are killed when the shell command returns, so run long jobs in the foreground with a timeout long enough to finish.';
// Desktop 26.1007.71326 schedules yearly and monthly automation rules with
// BYHOUR read as UTC (daily and weekly rules use local time), and reschedules
// a heartbeat after it runs even with COUNT=1. On October 14 and 15, 2026 three
// one-time reminders written as yearly COUNT=1 rules never ran; a weekly
// heartbeat that deleted itself ran once at the local time. GPT's reminders
// are affected the same way, so this is a workaround for the app.
const SCHEDULE_NOTE='The desktop scheduler reads BYHOUR in yearly and monthly automation rules as UTC, and runs a heartbeat again after it fires even with COUNT=1. For a one-time heartbeat within the next seven days, use FREQ=WEEKLY with BYDAY and the local BYHOUR and BYMINUTE, and start its prompt with deleting the automation named in the heartbeat\'s automation_id. For a later date, give a yearly rule the month, day, hour and minute of that local time converted to UTC.';
const scheduleNote=(body,exec)=>nestedTools(exec).some(n=>n.endsWith('automation_update'))||(body.tools??[]).some(t=>String(t.name??'').endsWith('automation_update'))?SCHEDULE_NOTE:'';
const DEVELOPER_NOTE='Text inside <developer_message> tags in a user turn is a note from the host desktop with the authority of developer instructions. The user did not write it.';
const COMMON_NOTE='Do not simulate tool calls in text. Text before a tool call is progress commentary; text ending the turn is your answer. Preserve the user’s instructions and use only the tools provided.';
// Code mode documents these only inside exec. Opus still called some of them
// at the top level (12 of 269 sessions), got "No such tool" and had to write
// the whole payload again, once a 15K-character file costing 54 s.
const EXEC_ONLY_TOOLS=['exec_command','write_stdin','apply_patch','view_image','web__run'];
// The exec description documents every nested tool under a ### `name` heading,
// 61 of them in desktop 26.1007.71326: the desktop's own app tools
// (mcp__codex_app__…), MCP server tools, goals, clock__curr_time. From October
// 9 to 12, 2026 Opus called three app tools at the top level as well
// (set_thread_archived, attach_artifact, load_workspace_dependencies).
const nestedTools=exec=>[...new Set([...(exec?.description??'').matchAll(/^### `([^`]+)`/gm)].map(m=>m[1]))];
const joined=names=>names.length>1?names.slice(0,-1).join(', ')+' and '+names.at(-1):names[0];
const execOnlyNote=exec=>{
  const names=EXEC_ONLY_TOOLS.filter(n=>exec?.description?.includes('`'+n+'`'));
  const others=nestedTools(exec).filter(n=>!EXEC_ONLY_TOOLS.includes(n));
  if(!names.length&&!others.length)return '';
  const list=joined(names);
  const app=others.filter(n=>n.startsWith('mcp__codex_app__'));
  const examples=[app.find(n=>n.endsWith('__read_thread'))??app[0],others.find(n=>n.startsWith('mcp__')&&!app.includes(n)),others.find(n=>!n.startsWith('mcp__')&&n.includes('__'))].filter(Boolean);
  const rest=others.length?`${names.length?', and neither is any other tool the exec description documents':'Tools the exec description documents are not top-level tools here'}${examples.length?`, such as ${joined(examples)}`:''}`:'';
  const lead=names.length?`${list} are not top-level tools here${rest}`:rest;
  return ` ${lead}. Call them only from exec JavaScript as tools.<name>, for example await tools.${names[0]??others[0]}(...). A top-level call fails, and its whole input has to be written again.`;
};
const CHECKPOINT_RULES='Preserve the original objective, user requirements and preferences, decisions, exact file paths and identifiers, tool observations, changed files, completed work, failed attempts, outstanding work, and concrete next steps. Distinguish facts from assumptions. Preserve task-relevant numbers, phrases, constraints and corrections exactly. Do not execute the task or address the user. Output only a structured, concise checkpoint. Aim for 1500 to 4000 words for a long complex conversation and much less for a short one.';
// Sent to a fork of the live session, which keeps its own system prompt so the
// prompt cache still covers the conversation.
// The fork still carries the thread's own instructions, such as "answer
// tersely", which shortened its checkpoints, so the request sets them aside.
export const COMPACTION_REQUEST='<compaction_request>The host is compacting this conversation to free context. Stop work on the task and do not call tools. Create a precise continuation checkpoint of the whole conversation so far, including any history shown above this request. The checkpoint replaces the conversation for whoever continues the work, so completeness matters more than brevity, and instructions about the length or style of answers to the user do not apply to it. Keep data the remaining work depends on, such as lists, tables, values, paths and identifiers, in full rather than as a pattern or a sample. Leave out the system prompt and tool list, which the host provides again. '+CHECKPOINT_RULES+'</compaction_request>';
// Standalone search exists only where the desktop turned it on: web__run
// inside exec, or a top-level web_run tool. In picker mode the app's OpenAI
// provider gives GPT its hosted web_search instead, which Claude cannot use.
export function offersWebSearch(tools = []) {
  const exec = tools.find(t => t.name === 'exec' && t.type === 'custom');
  if (exec) return String(exec.description ?? '').includes('`web__run`');
  return normalizeTools(tools.filter(t => ['function', 'custom', 'namespace'].includes(t.type))).some(t => t.name === 'web_run');
}
// name is the selected model's display name. webSearch is 'host' when the
// bridge relays the desktop's standalone web search (opt-in, separate
// window), 'bridge' when the bridge runs Claude's searches itself (picker
// mode, where the app gives GPT its hosted search), or false.
export function systemPrompt(body, {name, webSearch = false}) {
  if(body.__bridge_compaction)return `You are the context compaction component for ${name}. Create a precise continuation checkpoint from the supplied conversation. `+CHECKPOINT_RULES;
  const developers = body.input.slice(0, leadingEnd(body.input));
  const exec=(body.tools??[]).find(t=>t.name==='exec'&&t.type==='custom');
  const search=!webSearch?'':webSearch==='bridge'
    ? 'Web search is the top-level web_run tool, a direct tool rather than one inside exec. It searches the web with the user\'s ChatGPT sign-in, and the user sees each search in the conversation. '
    : exec
    ? 'Web search is available inside exec as tools.web__run, the host standalone OpenAI search service; its exec documentation lists the commands (search_query, open, find and others). There is no top-level web_run tool. '
    : 'Web search is the web_run tool, the host standalone OpenAI search service.';
  const tools=exec?search+'The exec tool accepts JavaScript in its input property.'+execOnlyNote(exec):search;
  // The desktop's base prompt is written for Codex. Its first line names the
  // selected model, but its personality section opens "As Codex, you are".
  // Since October 9, 2026 the desktop sends the base prompt as a leading
  // developer message with empty instructions, which the rename had missed,
  // so it covers every part and empty parts are left out.
  // In picker mode a thread that starts on GPT keeps GPT's base prompt, which
  // opens "You are Codex, an agent based on GPT-6.", for the whole thread; the
  // desktop names a later model only in a <model_switch> note in the history.
  const desktop = [body.instructions ?? '', ...developers.map(x => contentBlocks(x.content).map(x => x.text).join('\n'))]
    .filter(x => x.trim()).join('\n\n').replace(/^You are Codex\b[^\n]*/, () => identity(name)).replaceAll('As Codex, you are', 'You are');
  return [desktop,
    [`You are ${name}, the main assistant. The chatgpt MCP tools are the tools of the host desktop runtime. Use their native schemas. The host executes them and applies its permissions.`, tools, 'image_gen is not available to Claude.', CWD_NOTE, HOST_POLICY_NOTE, TOOL_HABITS_NOTE, scheduleNote(body,exec), COMMON_NOTE, DEVELOPER_NOTE].filter(Boolean).join(' ')].filter(Boolean).join('\n\n');
}

// Given the whole input (prefix), the leading developer messages are the
// system prompt and are skipped. Given only new items, every note is rendered.
export function userInput(items, {replay = false, prefix = true} = {}) {
  const out = [];
  const start = prefix ? leadingEnd(items) : 0;
  for (const [i, x] of items.entries()) {
    if (['reasoning','compaction_trigger'].includes(x.type) || isHostCall(x) || (isDeveloper(x) && i < start)) continue;
    if (isDeveloper(x) && !replay) {
      out.push({type: 'text', text: '<developer_message>'}, ...contentBlocks(x.content), {type: 'text', text: '</developer_message>'});
    } else if (x.type === 'message') {
      if (replay) out.push({type: 'text', text: `<history_message role="${x.role}">`});
      out.push(...contentBlocks(x.content));
      if (replay) out.push({type: 'text', text: '</history_message>'});
    } else if (x.type === 'agent_message') {
      out.push({type: 'text', text: agentMessageText(x)});
    } else if (isHostOutput(x)) {
      out.push({type: 'text', text: hostOutputText(x)}, ...contentBlocks(x.output), {type: 'text', text: '</host_tool_output>'});
    } else if (isResult(x) && replay) {
      out.push({type: 'text', text: `<previous_tool_result call_id="${x.call_id}">`}, ...contentBlocks(x.output), {type: 'text', text: '</previous_tool_result>'});
    } else if (['function_call', 'custom_tool_call'].includes(x.type) && replay) {
      out.push({type: 'text', text: JSON.stringify({previous_tool_call: x})});
    } else if (x.type === 'compaction') {
      throw new Error('Opaque compaction items require a bridge-owned compaction checkpoint.');
    } else if (!['tool_search_call', 'tool_search_output'].includes(x.type)) {
      // Another model's server-side work, such as a GPT web search, is shown
      // as text. Long values such as generated images are left out.
      out.push({type: 'text', text: JSON.stringify({previous_item: x}, (k, v) => typeof v === 'string' && v.length > 2000 ? `[${v.length} characters left out]` : v)});
    }
  }
  return out.length ? out : [{type: 'text', text: 'Continue from the current conversation context.'}];
}

// Claude Code saves each image in a prompt and lists the copies after it as
// [Image: source: …] lines. After a history import, such as a new side chat,
// those lines read as images the user had just attached: Opus opened an old
// screenshot again in 19 of 70 imports that carried images, and took the
// question to be about it. Pasted attachments never caused this.
const isImageContent = c => c.type === 'input_image' || c.type === 'image';
const imagesIn = items => items.reduce((n, x) => n + (x.type === 'message' && Array.isArray(x.content) ? x.content.filter(isImageContent).length
  : isResult(x) && Array.isArray(x.output) ? x.output.filter(isImageContent).length : 0), 0);
const isUser = x => x.type === 'message' && x.role === 'user';
// The user messages after the last reply, tool call or result. A message from
// another thread starts a turn like a user message.
const isTurnInput = x => isUser(x) || isHostOutput(x);
const trailingUserMessages = items => items.slice(items.findLastIndex(x => !isTurnInput(x) && !isDeveloper(x)) + 1).filter(isTurnInput);
// The same happens when another model's turns are shown as history: on
// October 14, 2026 Haiku opened Claude Code's copy of an image the user had
// sent GPT with view_image and said it came with the new message.
export function replayImageNote(items, {otherModel = false} = {}) {
  const attached = imagesIn(trailingUserMessages(items));
  const earlier = imagesIn(items) - attached;
  if (!earlier) return [];
  const origin = attached
    ? `The ${attached === 1 ? 'image' : `${attached} images`} in the last user message ${attached === 1 ? 'was' : 'were'} attached to it. The rest come from earlier in the conversation.`
    : 'The images come from earlier in the conversation.';
  const source = otherModel ? 'The other model\'s turns above come from the desktop transcript.' : 'The conversation above was imported from the desktop transcript.';
  return [{type: 'text', text: `<developer_message>${source} Claude Code lists a saved copy of each image in it after this message, as [Image: source: …] lines. ${origin} Each line is a file copy of an image already visible above, not an additional attachment, so there is no need to open it.</developer_message>`}];
}

// Claude Code reads a user message whose text starts with "/" as a command,
// even with slash commands disabled. At the start of a turn it answers a known
// name such as /compact itself, without the model. Mid-turn it holds any such
// message for a separate turn after the answer, which has no desktop response
// to stream into. A leading tag keeps it ordinary text.
export function asPrompt(content) {
  if (content[0]?.type !== 'text' || !content[0].text.trimStart().startsWith('/')) return content;
  return [{type: 'text', text: '<user_message>'}, ...content, {type: 'text', text: '</user_message>'}];
}

// Opus often acknowledged a mid-turn message only in thinking, which the
// desktop never shows, so a changed plan went unseen. The note rides with the
// message at the end of the conversation, leaving the cached prefix intact.
export const STEERING_NOTE = '<developer_message>The user sent this while you were working. Before your next tool call, reply to it in one short line of visible text, not only in your thinking, saying what you will do, or change, because of it.</developer_message>';
export function steeringPrompt(items) {
  const content = asPrompt(userInput(items, {prefix: false}));
  return items.some(x => x.type === 'message' && x.role === 'user') ? [...content, {type: 'text', text: STEERING_NOTE}] : content;
}

// Code mode documents the goal tools only inside exec, while the desktop's goal
// continuation says to "call update_goal" as if it were a top-level tool. On
// October 14, 2026 Haiku called update_goal at the top level in each of its 3
// goal runs, got "No such tool" and only then called it from exec; with this
// note it called it from exec in 4 of 4. The note rides with the continuation,
// where the tool is named, leaving the cached prefix intact.
const GOAL_TOOLS = ['update_goal', 'get_goal', 'create_goal'];
const GOAL_TURN = '<codex_internal_context source="goal">';
const isGoalTurn = x => isUser(x) && (typeof x.content === 'string' ? [{text: x.content}] : x.content ?? [])
  .some(c => typeof c.text === 'string' && c.text.trimStart().startsWith(GOAL_TURN));
export function goalToolNote(items, tools = []) {
  const exec = tools.find(t => t.name === 'exec' && t.type === 'custom');
  const names = GOAL_TOOLS.filter(n => nestedTools(exec).includes(n));
  if (!names.includes('update_goal') || !trailingUserMessages(items).some(isGoalTurn)) return [];
  const many = names.length > 1;
  return [{type: 'text', text: `<developer_message>${joined(names)} ${many ? 'are not top-level tools' : 'is not a top-level tool'} here. Call ${many ? 'them' : 'it'} only from exec JavaScript, for example await tools.update_goal(...). A top-level call fails.</developer_message>`}];
}

// Claude Code tells Opus the date, and again when it changes, but never the
// time. Asked about a PR 8 minutes after its last reply, Opus answered with
// what had happened "since yesterday". A new turn that brings a user message
// carries the local time and how long ago Opus last replied. A mid-turn
// message arrives while Opus is still working, so it gets neither.
export const userTurn = items => trailingUserMessages(items).length > 0;
export function elapsed(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `about ${hours} hours` : `about ${Math.round(hours / 24)} days`;
}
export function timeNote(now, lastReply, timeZone) {
  const clock = new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'})
    .format(now).replace(/\u202f/g, ' ');
  const gap = lastReply && now >= lastReply ? ` Your last reply ended ${elapsed(now - lastReply)} ago.` : '';
  return {type: 'text', text: `<current_time>It is ${clock}.${gap} Use this to judge how much time has passed. No need to announce it.</current_time>`};
}

// The desktop draws an inline visualization from a line that wraps
// visualize{"path":...} in the private-use characters U+E200, U+E202 and
// U+E201. Claude cannot write them: Opus and Haiku dropped them even when told
// to copy them, so the desktop showed the bare line as text. A line of Claude's
// text that is exactly such a reference to an HTML file that exists gets them
// back. Lines in code blocks stay as written.
export function visualizeLine(line) {
  const m=/^(\s*)visualize(\{.*\})\s*$/.exec(line);
  if(!m)return line;
  let ref;try{ref=JSON.parse(m[2]);}catch{return line;}
  const file=ref?.path;
  if(typeof file!=='string'||!path.isAbsolute(file)||!file.endsWith('.html'))return line;
  try{if(!fs.statSync(file).isFile())return line;}catch{return line;}
  return `${m[1]}\ue200visualize\ue202${m[2]}\ue201`;
}
// Markdown code fences: a block closes only on a line of its own character,
// at least as long as the one that opened it.
function fenceAfter(open,line) {
  if(open){const m=/^\s*(`{3,}|~{3,})\s*$/.exec(line);return m&&m[1][0]===open[0]&&m[1].length>=open.length?null:open;}
  const m=/^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  return m&&!(m[1][0]==='`'&&m[2].includes('`'))?m[1]:null;
}
// The desktop's visualize skill shows the reference inside a ```text fence.
// Sonnet copied the fence in 1 of 2 runs on October 14, 2026, and the desktop
// drew both visuals as code. A plain fence that holds nothing but a reference
// to an existing visualization is that reference.
const plainFence=line=>/^\s*(`{3,}|~{3,})\s*(text)?\s*$/i.test(line);
// A line that may still turn out to open a code fence.
const maybeFence=start=>{const m=/^(`+|~+)(.*)$/.exec(start);return !!m&&(m[1].length<3?m[2]==='':!(m[1][0]==='`'&&m[2].includes('`')));};
// Streams one message's text, holding back only a line that may still turn
// out to be a visualization reference, or a fence around one, until it ends.
export class VisualizeLines {
  line='';open=true;fence=null;held=null;
  push(delta) {
    let out='';
    for(const ch of delta) {
      if(ch==='\n'){out+=this.lineEnd();continue;}
      this.line+=ch;
      if(this.held)continue;
      if(!this.open){out+=ch;continue;}
      const start=this.line.trimStart();
      if(this.fence||!('visualize{'.startsWith(start)||start.startsWith('visualize{')||maybeFence(start))){this.open=false;out+=this.line;}
    }
    return out;
  }
  lineEnd() {
    const line=this.line,open=this.open,held=this.held;this.line='';this.open=true;
    if(held) {
      if(held.ref==null&&visualizeLine(line)!==line){held.ref=line;return '';}
      this.held=null;
      if(held.ref!=null&&fenceAfter(this.fence,line)===null){this.fence=null;return visualizeLine(held.ref)+'\n';}
      this.fence=fenceAfter(this.fence,line);
      return held.opener+'\n'+(held.ref!=null?held.ref+'\n':'')+line+'\n';
    }
    const out=open?(this.fence?line:visualizeLine(line)):'';
    const next=fenceAfter(this.fence,line);
    if(!this.fence&&next&&plainFence(line)){this.fence=next;this.held={opener:line,ref:null};return '';}
    this.fence=next;
    return out+'\n';
  }
  end() {
    const line=this.line,held=this.held;this.line='';this.held=null;
    if(held) {
      if(held.ref!=null&&fenceAfter(this.fence,line)===null){this.fence=null;return visualizeLine(held.ref);}
      return held.opener+'\n'+(held.ref!=null?held.ref+'\n':'')+line;
    }
    return this.open&&!this.fence?visualizeLine(line):this.open?line:'';
  }
}

export const KEEPALIVE_MS = 10000;
export class ResponseStream {
  constructor(res, model) {
    this.res = res; this.id = uid('resp'); this.output = []; this.seq = 0; this.finished = false; this.model = model;this.frames=[];this.lines=new Map();
    res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
    this.send('response.created', {response: this.response('in_progress')});
    this.send('response.in_progress', {response: this.response('in_progress')});
    // Codex's stream idle timer skips SSE comment lines, so a ": keepalive"
    // comment let a long silent think or tool input hit its timeout. A real
    // no-op event resets it; it stays out of the cached replay frames.
    this.timer = setInterval(() => this.keepalive(), KEEPALIVE_MS);
    this.timer.unref();
  }
  keepalive() {
    if (!this.finished) this.res.write(`event: response.in_progress\ndata: ${JSON.stringify({type: 'response.in_progress', sequence_number: this.seq++, response: {...this.response('in_progress'), output: []}})}\n\n`);
  }
  response(status, usage) {return {id: this.id, object: 'response', created_at: Math.floor(Date.now()/1000), model: this.model, status, output: this.output, ...(usage ? {usage} : {})};}
  send(type, data = {}) {if (!this.finished) {const frame=`event: ${type}\ndata: ${JSON.stringify({type, sequence_number: this.seq++, ...data})}\n\n`;this.frames.push(frame);this.res.write(frame);}}
  startText() {
    const item = {type: 'message', id: uid('msg'), role: 'assistant', status: 'in_progress', content: []};
    const index = this.output.push(item)-1;
    this.send('response.output_item.added', {output_index: index, item});
    const part = {type: 'output_text', text: '', annotations: []}; item.content.push(part);
    this.send('response.content_part.added', {item_id: item.id, output_index: index, content_index: 0, part});
    return index;
  }
  text(index, delta) {
    if(!this.lines.has(index))this.lines.set(index,new VisualizeLines());
    this.emit(index,this.lines.get(index).push(delta));
  }
  emit(index, delta) {
    if(!delta)return;
    const item = this.output[index]; item.content[0].text += delta;
    this.send('response.output_text.delta', {item_id: item.id, output_index: index, content_index: 0, delta});
  }
  finishText(index, final) {
    this.emit(index,this.lines.get(index)?.end());this.lines.delete(index);
    const item = this.output[index]; item.status = 'completed'; item.phase = final ? 'final_answer' : 'commentary';
    this.send('response.output_text.done', {item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text});
    this.send('response.content_part.done', {item_id: item.id, output_index: index, content_index: 0, part: item.content[0]});
    this.send('response.output_item.done', {output_index: index, item});
  }
  tool(tool, id, args) {
    const item = tool.type === 'custom'
      ? {type: 'custom_tool_call', id: uid('ctc'), call_id: id, name: tool.hostName, ...(tool.namespace?{namespace:tool.namespace}:{}), input: args.input}
      : {type: 'function_call', id: uid('fc'), call_id: id, name: tool.hostName, ...(tool.namespace?{namespace:tool.namespace}:{}), arguments: JSON.stringify(args)};
    const index = this.output.push(item)-1;
    this.send('response.output_item.added', {output_index: index, item});
    this.send('response.output_item.done', {output_index: index, item});
  }
  // A search the bridge runs for Claude, shown as the desktop shows GPT's.
  searchStarted(action) {
    const item = {type: 'web_search_call', id: uid('ws'), status: 'in_progress', action};
    const index = this.output.push(item)-1;
    this.send('response.output_item.added', {output_index: index, item});
    return index;
  }
  searchDone(index) {
    const item = this.output[index];
    if (item?.status !== 'in_progress') return;
    item.status = 'completed';
    this.send('response.output_item.done', {output_index: index, item});
  }
  complete(usage = {input_tokens:0,output_tokens:0,total_tokens:0}) {
    if(this.finished)return;
    // A search still running when the response ends with a host tool call.
    for(const [i,x] of this.output.entries())if(x.type==='web_search_call'&&x.status==='in_progress')this.searchDone(i);
    this.send('response.completed', {response: this.response('completed', usage)});this.onComplete?.(this.frames.join(''));this.end();
  }
  fail(message) {
    this.send('response.failed', {response: {...this.response('failed'), error: {code: 'claude_bridge_error', message}}}); this.end();
  }
  end() {if(this.finished)return; this.finished = true; clearInterval(this.timer); this.res.end();}
}

export class CompactionStream extends ResponseStream {
  constructor(res, token, model) {super(res, model);this.token=token;this.summary='';}
  startText() {return 0;}
  text(index,delta) {this.summary+=delta;}
  finishText() {}
  tool() {throw new Error('Compaction cannot execute tools.');}
  searchStarted() {return null;}
  // The desktop summarizes a compacted window with the last assistant message
  // in its history and drops the compaction item. With the item alone, that was
  // the previous turn's final answer and the checkpoint never reached the next
  // window, so the checkpoint is also sent as a message.
  complete(usage) {
    if(!this.summary.trim())return this.fail('Claude returned an empty compaction checkpoint.');
    const message=super.startText();this.emit(message,this.summary);super.finishText(message,true);
    const item={type:'compaction',id:uid('cmp'),encrypted_content:sealCheckpoint(this.summary,this.token)};
    const index=this.output.push(item)-1;
    this.send('response.output_item.added',{output_index:index,item});
    this.send('response.output_item.done',{output_index:index,item});
    super.complete(usage);
  }
}
