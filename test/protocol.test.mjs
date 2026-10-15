import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {visualizeLine, VisualizeLines, normalizeTools, contentBlocks, mcpResult, ResponseStream, userInput, replayImageNote, asPrompt, steeringPrompt, STEERING_NOTE, userTurn, elapsed, timeNote, newNotes, afterStop, afterWithdrawn, API_FAILED, CLAUDE_EXITED, stoppedTurnNote, resumeAfterStop, inputKey, historyStamp, extendsHistory, systemPrompt, isIncoming, sealCheckpoint, openCheckpoint, APPLY_PATCH_GUIDE, EXEC_STRING_NOTE, EXEC_OUTPUT_NOTE, KEEPALIVE_MS} from '../src/protocol.mjs';

test('freeform tools preserve multiline JavaScript without JSON coercion',()=>{
 const [tool]=normalizeTools([{type:'custom',name:'exec',description:'Execute JS'}]);
 const res=new EventEmitter();res.writeHead=()=>{};res.write=x=>(res.chunks??=[]).push(x);res.end=()=>{};
 const s=new ResponseStream(res,'claude-opus');const code='const x = "a\\nb";\ntext(x);';s.tool(tool,'toolu_test',{input:code});s.complete();
 assert.equal(s.output[0].type,'custom_tool_call');assert.equal(s.output[0].input,code);
 assert.ok(res.chunks.join('').includes('response.completed'));assert.ok(res.chunks.join('').includes('"model":"claude-opus"'));
});
test('keepalives are real events that reset the desktop idle timer and stay out of replays',()=>{
 const res=new EventEmitter();res.writeHead=()=>{};res.write=x=>(res.chunks??=[]).push(x);res.end=()=>{};
 const s=new ResponseStream(res);const before=s.frames.length;s.keepalive();
 const frame=res.chunks.at(-1);assert.match(frame,/^event: response\.in_progress\ndata: /);assert.doesNotMatch(frame,/^:/m);
 const data=JSON.parse(frame.split('\n')[1].slice(6));assert.equal(data.type,'response.in_progress');assert.deepEqual(data.response.output,[]);
 assert.equal(s.frames.length,before);assert.equal(KEEPALIVE_MS,10000);
 s.complete();const n=res.chunks.length;s.keepalive();assert.equal(res.chunks.length,n);
});
test('function namespaces preserve the host tool identity',()=>{
 const [t]=normalizeTools([{type:'namespace',name:'computer',tools:[{type:'function',name:'click',parameters:{type:'object',properties:{x:{type:'number'}}}}]}]);
 assert.equal(t.name,'computer_click');assert.equal(t.originalName,'computer.click');assert.equal(t.inputSchema.properties.x.type,'number');
});
test('unsupported hosted tools fail instead of disappearing',()=>{
 assert.throws(()=>normalizeTools([{type:'web_search'}]),/Unsupported provider-native tool/);
});
test('tool images retain their actual bytes and media type',()=>{
 const data=Buffer.from('test-image-bytes').toString('base64');
 const result=mcpResult([{type:'input_text',text:'image below'},{type:'input_image',image_url:'data:image/png;base64,'+data}]);
 assert.deepEqual(result.content,[{type:'text',text:'image below'},{type:'image',mimeType:'image/png',data}]);
});
test('unsupported content and remote images cannot silently lose context',()=>{
 // Audio becomes a visible note, so Claude can say it cannot hear it and the thread keeps working.
 assert.match(contentBlocks([{type:'input_audio',data:'a'.repeat(3000)}])[0].text,/"type":"input_audio".*characters left out/);
 assert.throws(()=>contentBlocks([{type:'input_image',image_url:'https://example.com/a.png'}]),/inline/);
});
test('fresh input preserves user images and excludes developer text',()=>{
 const result=userInput([{type:'message',role:'developer',content:'system rule'},{type:'message',role:'user',content:[{type:'input_text',text:'look'},{type:'input_image',image_url:'data:image/png;base64,YQ=='}]}]);
 assert.equal(result.length,2);assert.equal(result[1].type,'image');
});
test('history import keeps speaker and tool-result boundaries',()=>{
 const result=userInput([{type:'message',role:'assistant',content:[{type:'output_text',text:'prior'}]},{type:'function_call_output',call_id:'call_1',output:'42'}],{replay:true});
 assert.match(result[0].text,/role="assistant"/);assert.match(result[3].text,/call_id="call_1"/);
});
test('compaction checkpoints are not tied to one Claude model',()=>{
 assert.equal(openCheckpoint(sealCheckpoint('carry on','secret'),'secret'),'carry on');
 assert.throws(()=>openCheckpoint('gAAAA-from-another-provider','secret'),/created by another provider/);
});
test('desktop internal message metadata does not create a false history branch',()=>{
 const original={type:'message',id:'bridge_id',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'remembered',annotations:[]}]};
 const stored={...original,id:'host_id',internal_chat_message_metadata_passthrough:{content_item_kinds:['unknown'],turn_id:'host-turn'}};
 assert.ok(extendsHistory([stored,{type:'message',role:'user',content:'next'}],historyStamp([original])));
 assert.equal(extendsHistory([{...stored,content:'edited'}],historyStamp([original])),false);
});
test('apply_patch documents the patch format the host grammar enforces for GPT',()=>{
 const doc='The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';
 const [patch,shell]=normalizeTools([{type:'custom',name:'apply_patch',description:doc,format:{type:'grammar',syntax:'lark',definition:'start: begin_patch hunk+ end_patch'}},{type:'function',name:'exec_command',description:'Runs a command.'}]);
 assert.equal(patch.description,doc+'\n\n'+APPLY_PATCH_GUIDE);
 assert.match(patch.description,/last line is exactly \*\*\* End Patch/);
 assert.equal(shell.description,'Runs a command.');
 const exec='Run JavaScript.\n### `apply_patch`\n'+doc+'\ndeclare const tools: { apply_patch(input: string): Promise<unknown>; };\n### `exec_command`\nRuns a command.';
 const [code]=normalizeTools([{type:'custom',name:'exec',description:exec}]);
 assert.ok(code.description.startsWith('Run JavaScript.\n### `apply_patch`\n'+doc+'\n\n'+APPLY_PATCH_GUIDE+'\ndeclare const tools'));
 assert.ok(code.description.endsWith('Runs a command.\n\n'+EXEC_STRING_NOTE+'\n\n'+EXEC_OUTPUT_NOTE));
 assert.match(EXEC_OUTPUT_NOTE,/cuts text from the middle/);
 assert.equal(normalizeTools([{type:'custom',name:'exec',description:'Execute JS'}])[0].description,'Execute JS');
});
test('system prompt corrects Codex identity and working directory for either tool mode',()=>{
 const body={instructions:'# Personality\n\nAs Codex, you are curious.',input:[{type:'message',role:'developer',content:'dev rule'}],tools:[{type:'custom',name:'exec',description:'### `apply_patch`\n...\n### `exec_command`\n...'}]};
 const options={name:'Claude Sonnet',webSearch:true};
 const code=systemPrompt(body,options);
 assert.match(code,/^# Personality\n\nYou are curious\.\n\ndev rule\n\n/);
 assert.match(code,/\n\nYou are Claude Sonnet, the main assistant\./);
 // Since October 9, 2026 the base prompt arrives as a developer message with empty instructions.
 const moved=systemPrompt({instructions:'',input:[{type:'message',role:'developer',content:'You are Claude Opus 5.5, running as the main assistant.\n\n# Personality\n\nAs Codex, you are curious.'},{type:'message',role:'developer',content:'dev rule'}]},{name:'Claude Opus 5.5'});
 assert.match(moved,/^You are Claude Opus 5\.5, running as the main assistant\.\n\n# Personality\n\nYou are curious\.\n\ndev rule\n\nYou are Claude Opus 5\.5, the main assistant\./);
 assert.doesNotMatch(moved,/As Codex/);
 assert.match(code,/inside exec as tools\.web__run/);
 assert.match(code,/exec_command and apply_patch are not top-level tools here\. Call them only from exec JavaScript as tools\.<name>, for example await tools\.exec_command/);
 assert.doesNotMatch(systemPrompt({...body,tools:[{type:'custom',name:'exec'}]},options),/not top-level tools/);
 // Every tool the exec description documents is nested, including the desktop's
 // app tools and MCP server tools, which Opus also called at the top level.
 const nested=systemPrompt({...body,tools:[{type:'custom',name:'exec',description:'### `exec_command`\nRuns a command.\n\n### `clock__curr_time`\nTime.\n\n### `mcp__codex_app__set_thread_archived`\nArchive or unarchive a thread.\n\n### `mcp__figma__get_design_context`\nDesign context.'}]},options);
 assert.match(nested,/exec_command are not top-level tools here, and neither is any other tool the exec description documents, such as mcp__codex_app__set_thread_archived, mcp__figma__get_design_context and clock__curr_time\. Call them only from exec JavaScript as tools\.<name>/);
 const appOnly=systemPrompt({...body,tools:[{type:'custom',name:'exec',description:'### `mcp__codex_app__read_thread`\nRead a thread.'}]},options);
 assert.match(appOnly,/Tools the exec description documents are not top-level tools here, such as mcp__codex_app__read_thread\. Call them only from exec JavaScript as tools\.<name>, for example await tools\.mcp__codex_app__read_thread/);
 // The timer workaround appears only when the desktop offers its automation tool.
 const timers=systemPrompt({...body,tools:[{type:'custom',name:'exec',description:'### `exec_command`\nRuns a command.\n\n### `mcp__codex_app__automation_update`\nCreate automations.'}]},options);
 assert.match(timers,/use FREQ=WEEKLY with BYDAY and the local BYHOUR and BYMINUTE, and start its prompt with deleting the automation named in the heartbeat's automation_id/);
 assert.doesNotMatch(code,/automation_id/);
 assert.match(code,/Ignore it: the working directory is the cwd in <environment_context>/);
 assert.match(code,/refuses any shell command containing rm -f or rm -rf/);
 assert.match(code,/render its pages to images in a new temporary directory/);assert.match(code,/mktemp -d/);assert.match(code,/killed when the shell command returns/);
 const direct=systemPrompt({...body,tools:[{type:'function',name:'exec_command'},{type:'function',name:'web_run'}]},options);
 assert.match(direct,/Web search is the web_run tool/);
 assert.doesNotMatch(direct,/no top-level web_run/);assert.doesNotMatch(direct,/not top-level tools/);
 // Search is opt-in: without it the prompt does not mention it at all.
 const quiet=systemPrompt(body,{name:'Claude Sonnet'});
 assert.doesNotMatch(quiet,/web search|web__run|web_run/i);assert.match(quiet,/The exec tool accepts JavaScript in its input property\. exec_command and apply_patch/);
 assert.doesNotMatch(systemPrompt({...body,tools:[]},{name:'Claude Haiku'}),/  |web_run/);
 assert.match(systemPrompt({...body,__bridge_compaction:true},{name:'Claude Haiku'}),/^You are the context compaction component for Claude Haiku\./);
});
test('a user message starting with a slash is tagged so Claude Code passes it to Opus',()=>{
 const say=text=>userInput([{type:'message',role:'user',content:[{type:'input_text',text}]}]);
 assert.deepEqual(asPrompt(say('/compact the notes')),[{type:'text',text:'<user_message>'},{type:'text',text:'/compact the notes'},{type:'text',text:'</user_message>'}]);
 assert.equal(asPrompt(say('  /review this')).length,3);
 assert.deepEqual(asPrompt(say('false? a/b')),say('false? a/b'));
 assert.deepEqual(asPrompt(userInput([{type:'message',role:'assistant',content:[{type:'output_text',text:'/x'}]}],{replay:true}))[0],{type:'text',text:'<history_message role="assistant">'});
});
test('a mid-turn user message asks for a visible acknowledgment; notes and agent mail do not',()=>{
 const user={type:'message',role:'user',content:[{type:'input_text',text:'btw use the other worker'}]};
 const dev={type:'message',role:'developer',content:[{type:'input_text',text:'<image_resize_notice>resized</image_resize_notice>'}]};
 const mail={type:'agent_message',author:'/root/helper',recipient:'/root',content:[{type:'input_text',text:'done'}]};
 assert.deepEqual(steeringPrompt([user]),[{type:'text',text:'btw use the other worker'},{type:'text',text:STEERING_NOTE}]);
 assert.equal(steeringPrompt([dev,user]).at(-1).text,STEERING_NOTE);
 assert.equal(steeringPrompt([{...user,content:[{type:'input_text',text:'/review'}]}])[0].text,'<user_message>');
 assert.ok(!JSON.stringify(steeringPrompt([dev])).includes(STEERING_NOTE));
 assert.ok(!JSON.stringify(steeringPrompt([mail])).includes(STEERING_NOTE));
});
test('a new turn carries the local time and how long ago Claude last replied',()=>{
 const now=Date.UTC(2026,9,10,4,53,33);
 assert.equal(timeNote(now,now-8*60000,'America/Vancouver').text,'<current_time>It is Friday, October 9, 2026 at 9:53 PM PDT. Your last reply ended 8 minutes ago. Use this to judge how much time has passed. No need to announce it.</current_time>');
 assert.equal(timeNote(now,undefined,'America/Vancouver').text,'<current_time>It is Friday, October 9, 2026 at 9:53 PM PDT. Use this to judge how much time has passed. No need to announce it.</current_time>');
 assert.deepEqual([20000,60000,119*60000,150*60000,47*3600000,49*3600000].map(elapsed),['less than a minute','1 minute','119 minutes','about 3 hours','about 47 hours','about 2 days']);
 const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
 const reply={type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]};
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted/>'}]};
 assert.equal(userTurn([user('a','u1'),reply,note,user('b','u2')]),true);
 // A turn that continues after tool results, as after a mid-turn compaction, brings no new message.
 assert.equal(userTurn([user('a','u1'),{type:'function_call',call_id:'c1',name:'x',arguments:'{}'},{type:'function_call_output',call_id:'c1',output:'ok'}]),false);
 assert.equal(userTurn([user('a','u1'),reply]),false);
});
test('only developer messages before the conversation form the system prompt; later notes stay in place',()=>{
 const dev=text=>({type:'message',role:'developer',content:[{type:'input_text',text}]});
 const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
 const input=[dev('SETUP'),user('first','u1'),{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]},dev('<image_resize_notice>resized</image_resize_notice>'),user('second','u2')];
 const prompt=systemPrompt({instructions:'base',input},{name:'Claude Opus'});
 assert.match(prompt,/SETUP/);assert.doesNotMatch(prompt,/image_resize_notice/);assert.match(prompt,/<developer_message> tags/);
 const replay=userInput(input,{replay:true}).map(x=>x.text).join('');
 assert.doesNotMatch(replay,/SETUP/);assert.match(replay,/<history_message role="developer"><image_resize_notice>resized<\/image_resize_notice><\/history_message>.*second/);
 assert.deepEqual(userInput([input[3],input[4]],{prefix:false}).map(x=>x.text),['<developer_message>','<image_resize_notice>resized</image_resize_notice>','</developer_message>','second']);
 // A note is new only after the history already given to Opus.
 assert.deepEqual(newNotes(input,null),[input[3]]);
 assert.deepEqual(newNotes(input,historyStamp(input.slice(0,3))),[input[3]]);
 assert.deepEqual(newNotes(input,historyStamp(input)),[]);
 assert.deepEqual(newNotes([dev('A'),dev('B')],null),[]);
});
test('agent messages become labelled input text',()=>{
 const item={type:'agent_message',id:'amsg_1',author:'/root/task_b',recipient:'/root',content:[{type:'input_text',text:'Message Type: FINAL_ANSWER\nPayload:\n'},{type:'encrypted_content',encrypted_content:'ok'}]};
 assert.deepEqual(userInput([item]),[{type:'text',text:'<agent_message author="/root/task_b" recipient="/root">\nMessage Type: FINAL_ANSWER\nPayload:\nok\n</agent_message>'}]);
 assert.ok(isIncoming(item));assert.ok(!isIncoming({type:'message',role:'assistant',content:'x'}));
});
test('after a Stop only what the stopped session never received is sent, with a note on what happened',()=>{
 const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
 const call={type:'custom_tool_call',call_id:'c1',name:'exec',input:'x'},call2={...call,call_id:'c2'};
 const input=[user('first','u1'),call,call2,{type:'custom_tool_call_output',call_id:'c1',output:'relayed'},{type:'message',role:'assistant',content:[{type:'output_text',text:'partial'}]},
  {type:'custom_tool_call_output',call_id:'c2',output:'ran in host'},{type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted/>'}]},user('steered','u2'),user('new','u3')];
 const items=afterStop(input,historyStamp(input.slice(0,3)),[inputKey(input[0]),inputKey(input[7])],['c1']);
 assert.deepEqual(items,[input[5],input[6],input[8]]);
 assert.equal(afterStop(input,historyStamp([user('edited','u1')]),[],[]),null);
 const text=resumeAfterStop(items,{reason:'Desktop cancelled or disconnected.',sent:1}).map(x=>x.text).join('');
 assert.match(text,/^<turn_stopped>Your previous turn was stopped before it finished\. A tool call shown as rejected or interrupted may still have run in the host\. The output the host recorded follows\.<\/turn_stopped><previous_tool_result call_id="c2">ran in host<\/previous_tool_result><developer_message><turn_aborted\/><\/developer_message>new$/);
 assert.match(resumeAfterStop([],{reason:'Bridge shutting down.'})[0].text,/^<turn_stopped>Your previous turn was cut off by a bridge restart\. The user did not reject, stop or interrupt anything\..*Continue the task from where it stopped\./);
 const aborted={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The previous turn was interrupted on purpose.</turn_aborted>'}]};
 const steer=resumeAfterStop([user('keep both?','u4')],{reason:'Desktop cancelled or disconnected.',sent:0}).map(x=>x.text).join('');
 assert.match(steer,/^<turn_stopped>The desktop restarted your response to deliver the message below, which the user sent while you were working\. The user did not stop you: .*Carry on with the task, taking the message into account\.<\/turn_stopped>keep both\?<developer_message>The user sent this while you were working\./);
 assert.match(resumeAfterStop([user('keep both?','u4')],{reason:'Desktop cancelled or disconnected.',sent:1})[0].text,/restarted your response.*already reached the host/);
 assert.match(resumeAfterStop([aborted,user('keep both?','u4')],{reason:'Desktop cancelled or disconnected.'})[0].text,/^<turn_stopped>Your previous turn was stopped before it finished\./);
 const restarted=resumeAfterStop([aborted,user('new','u3')],{reason:'Bridge shutting down.',sent:1})[0].text;
 assert.match(restarted,/^<turn_stopped>Your previous turn was stopped before it finished\./);assert.doesNotMatch(restarted,/did not reject|bridge restart/);
 assert.match(stoppedTurnNote([aborted,{type:'custom_tool_call_output',call_id:'c1',output:'ran'}],{reason:'Bridge shutting down.',sent:1})[0].text,/^<turn_stopped>Your turn was stopped before it finished\./);
 assert.match(resumeAfterStop([user('new','u3')],{reason:'tool_cycle_interrupted',sent:1})[0].text,/stopped before it finished\. A tool call shown as rejected had already reached the host.*running it again\.<\/turn_stopped>$/);
});
test('a compaction of a stopped turn says which interrupted tool calls the host ran, and that the user did nothing when the host stopped it',()=>{
 const result={type:'custom_tool_call_output',call_id:'c1',output:'ran'},next={type:'message',id:'u2',role:'user',content:[{type:'input_text',text:'next'}]};
 assert.equal(stoppedTurnNote([result],{reason:'compacted_mid_turn',sent:1})[0].text,'<turn_stopped>The host paused your turn here to compact the conversation. The user did not reject, stop or interrupt anything. Claude Code wrote the "The user doesn\'t want to proceed" tool results, "[Request interrupted by user for tool use]" and any "No response requested." reply because of this, not because of anything the user did. The host ran each tool call whose output follows, so that output is the call\'s normal result. The checkpoint should leave out the pause and these marks, and record the task as still in progress, continuing from here.</turn_stopped>');
 assert.match(stoppedTurnNote([result],{reason:'compacted_mid_turn',sent:2})[0].text,/normal result\. A call shown as rejected with no output here may have run in part or in full, so the checkpoint should say to check its effects/);
 const none=stoppedTurnNote([next],{reason:'compacted_mid_turn',sent:1})[0].text;
 assert.match(none,/did not reject, stop or interrupt anything\..*A call shown as rejected with no output here/);assert.doesNotMatch(none,/host ran each/);
 assert.match(stoppedTurnNote([result],{reason:'Bridge shutting down.',sent:1})[0].text,/^<turn_stopped>Your turn was cut off here by a bridge restart\. The user did not reject/);
 const stopped=stoppedTurnNote([result],{reason:'Desktop cancelled or disconnected.',sent:1})[0].text;
 assert.match(stopped,/^<turn_stopped>Your turn was stopped before it finished\. A tool call/);assert.doesNotMatch(stopped,/did not reject/);
 assert.deepEqual(stoppedTurnNote([next],{reason:'Desktop cancelled or disconnected.'}),[]);
});
test('a turn that ended with an API error resumes with a note that the user did not stop it',()=>{
 const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
 assert.equal(resumeAfterStop([],{reason:API_FAILED,status:529})[0].text,'<turn_stopped>Your previous attempt at this turn ended with an API error (status 529) before it finished. The user did not stop it, and the conversation up to the error is intact. Continue the task from where it stopped.</turn_stopped>');
 // A message the user sent after the error follows the note, which then does not ask to continue.
 const next=resumeAfterStop([user('try again please','u2')],{reason:API_FAILED}).map(x=>x.text).join('');
 assert.match(next,/^<turn_stopped>Your previous attempt at this turn ended with an API error before it finished\..*intact\.<\/turn_stopped>try again please$/);
 assert.match(stoppedTurnNote([{type:'custom_tool_call_output',call_id:'c1',output:'ran'}],{reason:API_FAILED,status:429})[0].text,/^<turn_stopped>Your turn here ended with an API error \(status 429\) before it finished\. The user did not stop it.*The host ran each tool call whose output follows\. The checkpoint should record the task as still in progress/);
});
test('a turn cut off when Claude Code exited while the host ran a tool says the error and rejection came from the exit',()=>{
 const output={type:'function_call_output',call_id:'c1',output:'build passed'};
 const text=resumeAfterStop([output],{reason:CLAUDE_EXITED,sent:1}).map(x=>x.text).join('');
 assert.match(text,/^<turn_stopped>Your previous turn was cut off\. Claude Code stopped waiting for a host tool call, for example because a bridge restart stopped it\. The user did not reject, stop or interrupt anything\..*"MCP server is not connected", also came from this, not from the host\. A tool call shown as rejected or interrupted may still have run in the host\. The output the host recorded follows\. Continue the task from where it stopped\.<\/turn_stopped><previous_tool_result call_id="c1">build passed<\/previous_tool_result>$/);
 assert.match(stoppedTurnNote([output],{reason:CLAUDE_EXITED,sent:1})[0].text,/^<turn_stopped>Your turn was cut off here\. Claude Code stopped waiting.*not from the host\. The host ran each tool call whose output follows/);
 // The user had stopped the turn in the desktop.
 const aborted={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The previous turn was interrupted on purpose.</turn_aborted>'}]};
 assert.match(resumeAfterStop([aborted,output],{reason:CLAUDE_EXITED,sent:1})[0].text,/^<turn_stopped>Your previous turn was stopped before it finished\./);
});
test('a withdrawn message is recognised only when the earlier history is unchanged and a new message follows',()=>{
 const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
 const reply={type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]};
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted/>'}]};
 const before=[user('first','u1'),reply];const stamp=historyStamp(before);
 assert.deepEqual(afterWithdrawn([...before,note,user('edited','u3')],stamp,[inputKey(before[0])]),[note,user('edited','u3')]);
 // The earlier history changed, nothing new arrived, or the request carries tool output or a reply.
 assert.equal(afterWithdrawn([user('first, edited','u1'),reply,user('edited','u3')],stamp,[]),null);
 assert.equal(afterWithdrawn([...before,note],stamp,[inputKey(before[0])]),null);
 assert.equal(afterWithdrawn([...before,{type:'function_call_output',call_id:'c1',output:'x'},user('edited','u3')],stamp,[]),null);
 assert.equal(afterWithdrawn([...before,user('edited','u3')],null,[]),null);
});
test('an imported history explains the image copies Claude Code lists after it, and leaves plain attachments alone',()=>{
 const image={type:'input_image',image_url:'data:image/png;base64,YQ=='};
 const user=(content,id)=>({type:'message',id,role:'user',content});
 const call={type:'custom_tool_call',call_id:'c1',name:'exec',input:'screenshot'};
 const shot={type:'custom_tool_call_output',call_id:'c1',output:[{type:'input_text',text:'checkout page'},image]};
 const answer={type:'message',role:'assistant',content:[{type:'output_text',text:'checked'}]};
 const dev={type:'message',role:'developer',content:[{type:'input_text',text:'<codex_apps_client_time_context/>'}]};
 // A side chat: the main chat's screenshot is history, the question has no image.
 const side=[user([{type:'input_text',text:'check checkout'}],'u1'),call,shot,answer,dev,user([{type:'input_text',text:'any other runs?'}],'u2')];
 const [note]=replayImageNote(side);
 assert.match(note.text,/^<developer_message>.*\[Image: source: …\].*come from earlier in the conversation.*not an additional attachment.*<\/developer_message>$/);
 // An image pasted with the question is named as its attachment.
 const pasted=replayImageNote([...side.slice(0,-1),user([{type:'input_text',text:'and this?'},image,image],'u2')])[0].text;
 assert.match(pasted,/The 2 images in the last user message were attached to it\. The rest come from earlier/);
 assert.match(replayImageNote([...side.slice(0,-1),user([image],'u2')])[0].text,/The image in the last user message was attached to it\./);
 // Nothing to explain without earlier images.
 assert.deepEqual(replayImageNote([user([{type:'input_text',text:'q'}],'u1'),answer,user([{type:'input_text',text:'look'},image],'u2')]),[]);
 assert.deepEqual(replayImageNote([user([{type:'input_text',text:'q'}],'u1'),answer,user([{type:'input_text',text:'next'}],'u2')]),[]);
 // A transcript that ends on a screenshot result counts it as earlier context.
 assert.match(replayImageNote([user([{type:'input_text',text:'q'}],'u1'),call,shot])[0].text,/come from earlier/);
});

test('a bare visualization reference to an existing HTML file gets the desktop markers back',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge viz '));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'worker-client-runtime.html');fs.writeFileSync(file,'<div id="x">hi</div>');
 const ref=`visualize{"path":${JSON.stringify(file)}}`,wrapped=`\ue200visualize\ue202{"path":${JSON.stringify(file)}}\ue201`;
 assert.equal(visualizeLine(ref),wrapped);
 assert.equal(visualizeLine(`visualize{"path":${JSON.stringify(file)},"mode":"wide"}`),`\ue200visualize\ue202{"path":${JSON.stringify(file)},"mode":"wide"}\ue201`);
 for(const line of [`visualize{"path":${JSON.stringify(path.join(dir,'missing.html'))}}`,'visualize{"path":"relative.html"}',`visualize{"path":${JSON.stringify(file)}`,`see ${ref}`,wrapped])
  assert.equal(visualizeLine(line),line);
 const res=new EventEmitter();res.writeHead=()=>{};res.write=x=>(res.chunks??=[]).push(x);res.end=()=>{};
 const s=new ResponseStream(res);const i=s.startText();
 const text=`Here is the layout.\n\n${ref}\n\nSwitch tabs.\n\n\`\`\`text\n${ref}\n\`\`\`\nvisualize is a skill.\n${ref}`;
 // Claude's text arrives in small pieces that split the reference anywhere.
 for(let n=0;n<text.length;n+=7)s.text(i,text.slice(n,n+7));
 s.finishText(i,true);s.complete();
 // A reference fenced the way the skill shows it is still the reference.
 const expected=`Here is the layout.\n\n${wrapped}\n\nSwitch tabs.\n\n${wrapped}\nvisualize is a skill.\n${wrapped}`;
 assert.equal(s.output[0].content[0].text,expected);
 const events=res.chunks.join('').split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
 assert.equal(events.filter(e=>e.type==='response.output_text.delta').map(e=>e.delta).join(''),expected);
 assert.equal(events.find(e=>e.type==='response.output_text.done').text,expected);
 // Text that cannot start a reference is not held back.
 const lines=new VisualizeLines();assert.equal(lines.push('Working on '),'Working on ');assert.equal(lines.push('it.\nvis'),'it.\n');assert.equal(lines.push('it the page'),'visit the page');
});


test('GPT web searches and other hosted items in a thread reach Claude as text, without breaking it',()=>{
 const items=[{type:'web_search_call',id:'ws_1',action:{type:'search',query:'weather'},status:'completed'},
  {type:'image_generation_call',id:'ig_1',status:'completed',result:'A'.repeat(50000),revised_prompt:'a cat'},
  {type:'tool_search_call',id:'ts_1'},{type:'tool_search_output',tools:[]},
  {type:'message',role:'assistant',content:[{type:'output_text',text:'Sunny.'}]}];
 const text=userInput(items,{replay:true,prefix:false}).map(x=>x.text).join('\n');
 assert.match(text,/"web_search_call".*"query":"weather"/);
 assert.match(text,/"result":"\[50000 characters left out\]".*"revised_prompt":"a cat"/);
 assert.doesNotMatch(text,/tool_search/);assert.match(text,/Sunny\./);
 assert.throws(()=>userInput([{type:'compaction',encrypted_content:'x'}],{replay:true,prefix:false}),/compaction/);
});
test('a visualization line inside any code block stays as written',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fence-'));const file=path.join(dir,'v.html');fs.writeFileSync(file,'<div>hi</div>');
 const ref=`visualize{"path":"${file}"}`;
 const drawn=text=>{const v=new VisualizeLines();return (v.push(text)+v.end()).includes('\ue200');};
 try {
  assert.equal(drawn('~~~\n```\n'+ref+'\n~~~\n'),false);
  assert.equal(drawn('````\n```\n'+ref+'\n````\n'),false);
  assert.equal(drawn('```js\nx\n```\n'+ref+'\n'),true);
  assert.equal(drawn('```x``` is inline code\n'+ref+'\n'),true);
  assert.equal(drawn('- item\n    ```\n    y\n    ```\n'+ref+'\n'),true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('a reference copied inside the skill\'s text fence is drawn, and real code stays code',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge viz '));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'bar-chart.html');fs.writeFileSync(file,'<div>x</div>');
 const ref=`visualize{"path":${JSON.stringify(file)}}`,wrapped=`visualize{"path":${JSON.stringify(file)}}`;
 const missing=`visualize{"path":${JSON.stringify(path.join(dir,'missing.html'))}}`;
 const run=(text,n)=>{const v=new VisualizeLines();let out='';for(let i=0;i<text.length;i+=n)out+=v.push(text.slice(i,i+n));return out+v.end();};
 const cases=[
  // As Sonnet wrote it on October 14, 2026: two visuals, each in a ```text fence.
  ['Bar chart:\n\n```text\n'+ref+'\n```\n\nPie chart:\n\n```text\n'+ref+'\n```\n','Bar chart:\n\n'+wrapped+'\n\nPie chart:\n\n'+wrapped+'\n'],
  ['```\n'+ref+'\n```','\n'.slice(1)+wrapped],
  ['~~~text\n'+ref+'\n~~~\nafter',wrapped+'\nafter'],
  ['  ```text\n'+ref+'\n  ```\r\nafter',wrapped+'\nafter'],
  // Real code, other content, a missing file or an unclosed fence stay as written.
  ['```js\n'+ref+'\n```\n','```js\n'+ref+'\n```\n'],
  ['```text\n'+ref+'\n'+ref+'\n```\n','```text\n'+ref+'\n'+ref+'\n```\n'],
  ['```text\nnote\n'+ref+'\n```\n','```text\nnote\n'+ref+'\n```\n'],
  ['```text\n'+missing+'\n```\n','```text\n'+missing+'\n```\n'],
  ['```text\n'+ref+'\n','```text\n'+ref+'\n'],
  ['```text\n'+ref,'```text\n'+ref],
  ['```text\n```\n'+ref,'```text\n```\n'+wrapped],
  ['```\ncode\n```\n'+ref+'\n','```\ncode\n```\n'+wrapped+'\n'],
  ['``inline`` and `x`\n'+ref,'``inline`` and `x`\n'+wrapped],
 ];
 for(const [text,want] of cases)for(const n of [1,3,text.length])assert.equal(run(text,n).replace(/\r/g,''),want.replace(/\r/g,''),JSON.stringify({text,n}));
 // Ordinary text still streams as it arrives.
 const v=new VisualizeLines();assert.equal(v.push('Plain text '),'Plain text ');assert.equal(v.push('`code` more'),'`code` more');
});
test('a GPT refusal and unknown content parts in history reach Claude as text',()=>{
 const blocks=contentBlocks([{type:'output_text',text:'ok'},{type:'refusal',refusal:'I can not help with that.'},{type:'input_file',filename:'a.pdf',file_data:'x'.repeat(5000)}]);
 assert.deepEqual(blocks.map(b=>b.type),['text','text','text']);
 assert.equal(blocks[1].text,'[Refused: I can not help with that.]');
 assert.match(blocks[2].text,/"filename":"a\.pdf".*\[5000 characters left out\]/);
});
test('an image from the user\'s ChatGPT files becomes a note instead of breaking the thread',()=>{
 const file={type:'input_image',image_url:'',file_id:'file_00000000abc'};
 const [text,note]=contentBlocks([{type:'input_text',text:'What is this?'},file]);
 assert.deepEqual(text,{type:'text',text:'What is this?'});
 assert.equal(note.type,'text');assert.match(note.text,/ChatGPT files \(file_00000000abc\).*ask the user to attach the image itself/);
 // Every later request carries it as history.
 assert.doesNotThrow(()=>historyStamp([{type:'message',role:'user',content:[{type:'input_text',text:'What is this?'},file]},{type:'message',role:'assistant',content:[{type:'output_text',text:'I cannot see it.'}]}]));
});
test('images in another model\'s turns are named as copies of what is shown',()=>{
 const image={type:'input_image',image_url:'data:image/png;base64,iVBORw0KGgo='};
 const other=[{type:'message',role:'user',content:[{type:'input_text',text:'look'},image]},{type:'message',role:'assistant',content:[{type:'output_text',text:'A cat.'}]},{type:'message',role:'user',content:[{type:'input_text',text:'Did it come with this message?'}]}];
 const [note]=replayImageNote(other,{otherModel:true});
 assert.match(note.text,/^<developer_message>The other model's turns above come from the desktop transcript\. /);
 assert.match(note.text,/The images come from earlier in the conversation\..*not an additional attachment/);
 assert.match(replayImageNote(other)[0].text,/^<developer_message>The conversation above was imported from the desktop transcript\. /);
});
