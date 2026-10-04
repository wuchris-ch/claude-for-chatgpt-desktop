import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {normalizeTools, contentBlocks, mcpResult, ResponseStream, userInput, asPrompt, steeringPrompt, STEERING_NOTE, newNotes, afterStop, resumeAfterStop, inputKey, historyStamp, extendsHistory, systemPrompt, isIncoming, sealCheckpoint, openCheckpoint, APPLY_PATCH_GUIDE, EXEC_STRING_NOTE, EXEC_OUTPUT_NOTE, KEEPALIVE_MS} from '../src/protocol.mjs';

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
 assert.throws(()=>contentBlocks([{type:'input_audio',data:'abc'}]),/Unsupported content/);
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
 assert.match(code,/inside exec as tools\.web__run/);
 assert.match(code,/exec_command and apply_patch are not top-level tools here\. Call them only from exec JavaScript as tools\.<name>, for example await tools\.exec_command/);
 assert.doesNotMatch(systemPrompt({...body,tools:[{type:'custom',name:'exec'}]},options),/not top-level tools/);
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
 assert.match(resumeAfterStop([],{reason:'Bridge shutting down.'})[0].text,/bridge restart, not stopped by the user\. Continue the task from where it stopped\./);
 assert.match(resumeAfterStop([user('new','u3')],{reason:'tool_cycle_interrupted',sent:1})[0].text,/stopped before it finished\. A tool call shown as rejected had already reached the host.*running it again\.<\/turn_stopped>$/);
});
