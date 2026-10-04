import {createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const uid = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;

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

export function contentBlocks(content) {
  if (typeof content === 'string') return [{type: 'text', text: content}];
  return (content ?? []).map(c => {
    if (['input_text', 'output_text', 'text'].includes(c.type)) return {type: 'text', text: c.text};
    if (c.type === 'input_image') return imageBlock(c.image_url);
    if (c.type === 'image' && c.data) return {type: 'image', source: {type: 'base64', media_type: c.mimeType, data: c.data}};
    throw new Error(`Unsupported content block: ${c.type}. The bridge will not drop content.`);
  });
}

export function mcpResult(output) {
  return {content: contentBlocks(output).map(c => c.type === 'image'
    ? {type: 'image', data: c.source.data, mimeType: c.source.media_type} : c)};
}

export const isResult = item => ['function_call_output', 'custom_tool_call_output'].includes(item.type);
// Multi-agent v2 delivers tasks and results between agents as agent_message
// items. For the receiving agent they are new input, like a user message.
export const isIncoming = item => item.type === 'agent_message' || (item.type === 'message' && item.role === 'user');
export const inputKey = item => item.id ?? digest(item.content);
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
export function semantic(item) {
  if (['reasoning','compaction_trigger'].includes(item.type) || item.type==='message'&&['system','developer'].includes(item.role)) return null;
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
  return since.some(x => !isIncoming(x) && !isDeveloper(x) && !['reasoning', 'compaction_trigger'].includes(x.type)) ? since : null;
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
// Claude Code marks a stopped turn's unanswered tool calls as rejected by the
// user, which is not always what happened in the host.
export function resumeAfterStop(items, {reason, sent = 0}) {
  const parts = [reason === 'Bridge shutting down.' ? 'Your previous turn was cut off by a bridge restart, not stopped by the user.' : 'Your previous turn was stopped before it finished.'];
  if (items.some(isResult)) parts.push('A tool call shown as rejected or interrupted may still have run in the host. The output the host recorded follows.');
  else if (sent) parts.push('A tool call shown as rejected had already reached the host, which may have run it in part or in full. Check its effects before relying on it or running it again.');
  if (!items.some(isIncoming)) parts.push('Continue the task from where it stopped.');
  return [{type: 'text', text: `<turn_stopped>${parts.join(' ')}</turn_stopped>`},
    ...items.flatMap(x => userInput([x], {replay: isResult(x), prefix: false}))];
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
const DEVELOPER_NOTE='Text inside <developer_message> tags in a user turn is a note from the host desktop with the authority of developer instructions. The user did not write it.';
const COMMON_NOTE='Do not simulate tool calls in text. Text before a tool call is progress commentary; text ending the turn is your answer. Preserve the user’s instructions and use only the tools provided.';
// Code mode documents these only inside exec. Opus still called some of them
// at the top level (12 of 269 sessions), got "No such tool" and had to write
// the whole payload again, once a 15K-character file costing 54 s.
const EXEC_ONLY_TOOLS=['exec_command','write_stdin','apply_patch','view_image','web__run'];
const execOnlyNote=exec=>{
  const names=EXEC_ONLY_TOOLS.filter(n=>exec?.description?.includes('`'+n+'`'));
  if(!names.length)return '';
  const list=names.length>1?names.slice(0,-1).join(', ')+' and '+names.at(-1):names[0];
  return ` ${list} are not top-level tools here. Call them only from exec JavaScript as tools.<name>, for example await tools.${names[0]}(...). A top-level call fails, and its whole input has to be written again.`;
};
const CHECKPOINT_RULES='Preserve the original objective, user requirements and preferences, decisions, exact file paths and identifiers, tool observations, changed files, completed work, failed attempts, outstanding work, and concrete next steps. Distinguish facts from assumptions. Preserve task-relevant numbers, phrases, constraints and corrections exactly. Do not execute the task or address the user. Output only a structured, concise checkpoint. Aim for 1500 to 4000 words for a long complex conversation and much less for a short one.';
// Sent to a fork of the live session, which keeps its own system prompt so the
// prompt cache still covers the conversation.
// The fork still carries the thread's own instructions, such as "answer
// tersely", which shortened its checkpoints, so the request sets them aside.
export const COMPACTION_REQUEST='<compaction_request>The host is compacting this conversation to free context. Stop work on the task and do not call tools. Create a precise continuation checkpoint of the whole conversation so far, including any history shown above this request. The checkpoint replaces the conversation for whoever continues the work, so completeness matters more than brevity, and instructions about the length or style of answers to the user do not apply to it. Keep data the remaining work depends on, such as lists, tables, values, paths and identifiers, in full rather than as a pattern or a sample. Leave out the system prompt and tool list, which the host provides again. '+CHECKPOINT_RULES+'</compaction_request>';
// name is the selected model's display name. webSearch says whether the
// bridge relays the desktop's standalone web search (opt-in).
export function systemPrompt(body, {name, webSearch = false}) {
  if(body.__bridge_compaction)return `You are the context compaction component for ${name}. Create a precise continuation checkpoint from the supplied conversation. `+CHECKPOINT_RULES;
  const developers = body.input.slice(0, leadingEnd(body.input));
  const exec=(body.tools??[]).find(t=>t.name==='exec'&&t.type==='custom');
  const search=!webSearch?'':exec
    ? 'Web search is available inside exec as tools.web__run, the host standalone OpenAI search service; its exec documentation lists the commands (search_query, open, find and others). There is no top-level web_run tool. '
    : 'Web search is the web_run tool, the host standalone OpenAI search service.';
  const tools=exec?search+'The exec tool accepts JavaScript in its input property.'+execOnlyNote(exec):search;
  // The desktop's base prompt is written for Codex with only its first line renamed.
  const instructions=(body.instructions ?? '').replace('As Codex, you are','You are');
  return [instructions, ...developers.map(x => contentBlocks(x.content).map(x => x.text).join('\n')),
    [`You are ${name}, the main assistant. The chatgpt MCP tools are the tools of the host desktop runtime. Use their native schemas. The host executes them and applies its permissions.`, tools, 'image_gen is not available to Claude.', CWD_NOTE, HOST_POLICY_NOTE, TOOL_HABITS_NOTE, COMMON_NOTE, DEVELOPER_NOTE].filter(Boolean).join(' ')].join('\n\n');
}

// Given the whole input (prefix), the leading developer messages are the
// system prompt and are skipped. Given only new items, every note is rendered.
export function userInput(items, {replay = false, prefix = true} = {}) {
  const out = [];
  const start = prefix ? leadingEnd(items) : 0;
  for (const [i, x] of items.entries()) {
    if (['reasoning','compaction_trigger'].includes(x.type) || (isDeveloper(x) && i < start)) continue;
    if (isDeveloper(x) && !replay) {
      out.push({type: 'text', text: '<developer_message>'}, ...contentBlocks(x.content), {type: 'text', text: '</developer_message>'});
    } else if (x.type === 'message') {
      if (replay) out.push({type: 'text', text: `<history_message role="${x.role}">`});
      out.push(...contentBlocks(x.content));
      if (replay) out.push({type: 'text', text: '</history_message>'});
    } else if (x.type === 'agent_message') {
      out.push({type: 'text', text: agentMessageText(x)});
    } else if (isResult(x) && replay) {
      out.push({type: 'text', text: `<previous_tool_result call_id="${x.call_id}">`}, ...contentBlocks(x.output), {type: 'text', text: '</previous_tool_result>'});
    } else if (['function_call', 'custom_tool_call'].includes(x.type) && replay) {
      out.push({type: 'text', text: JSON.stringify({previous_tool_call: x})});
    } else if (x.type === 'compaction') {
      throw new Error('Opaque compaction items require a bridge-owned compaction checkpoint.');
    } else {
      throw new Error(`Cannot safely import conversation item ${x.type}.`);
    }
  }
  return out.length ? out : [{type: 'text', text: 'Continue from the current conversation context.'}];
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

export const KEEPALIVE_MS = 10000;
export class ResponseStream {
  constructor(res, model) {
    this.res = res; this.id = uid('resp'); this.output = []; this.seq = 0; this.finished = false; this.model = model;this.frames=[];
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
    const item = this.output[index]; item.content[0].text += delta;
    this.send('response.output_text.delta', {item_id: item.id, output_index: index, content_index: 0, delta});
  }
  finishText(index, final) {
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
  complete(usage = {input_tokens:0,output_tokens:0,total_tokens:0}) {
    if(this.finished)return;
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
  // The desktop summarizes a compacted window with the last assistant message
  // in its history and drops the compaction item. With the item alone, that was
  // the previous turn's final answer and the checkpoint never reached the next
  // window, so the checkpoint is also sent as a message.
  complete(usage) {
    if(!this.summary.trim())return this.fail('Claude returned an empty compaction checkpoint.');
    const message=super.startText();super.text(message,this.summary);super.finishText(message,true);
    const item={type:'compaction',id:uid('cmp'),encrypted_content:sealCheckpoint(this.summary,this.token)};
    const index=this.output.push(item)-1;
    this.send('response.output_item.added',{output_index:index,item});
    this.send('response.output_item.done',{output_index:index,item});
    super.complete(usage);
  }
}
