import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync} from 'node:zlib';
import {startBridge,pruneResponseCache,pruneToolSets,evictIdleSessions,findClaude} from '../src/server.mjs';
import {openCheckpoint,sealCheckpoint} from '../src/protocol.mjs';
import {parseModels} from '../src/models.mjs';
const MODEL='claude-opus';
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const request=(text,id='user1')=>({model:MODEL,stream:true,tools,instructions:'fixture',input:[{type:'message',id,role:'user',content:[{type:'input_text',text}]}]});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;
async function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-test-'));const logs=[];
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data}),...options});
 t.after(async()=>{await b.close();fs.rmSync(dir,{recursive:true,force:true});});
 const post=(body,extra={})=>fetch(b.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'fixture',...extra.headers},body:JSON.stringify(body),...extra});
 return {b,dir,logs,post};
}
test('native MCP tool cycle, images, and duplicate HTTP response replay',async t=>{
 const {post,dir}=await setup(t);const first=request('invoke-tool');
 const a=await(await post(first)).text();const call=output(a)[0];
 assert.equal(call.type,'custom_tool_call');assert.equal(call.input,'text("hello");\ntext(42);');
 assert.equal(await(await post(first)).text(),a);
 const second={...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:[{type:'input_text',text:'42'},{type:'input_image',image_url:'data:image/png;base64,YQ=='}]}]};
 const result=await(await post(second)).text();assert.match(JSON.stringify(output(result)),/image/);assert.match(JSON.stringify(output(result)),/YQ==/);
 assert.equal(fs.readFileSync(path.join(dir,'fake-starts'),'utf8').trim().split('\n').length,1);
 assert.equal(await(await post(second)).text(),result);
 const cached=fs.readdirSync(path.join(dir,'response-cache'));
 assert.ok(cached.every(x=>x.endsWith('.sealed')));
 assert.ok(cached.every(x=>!fs.readFileSync(path.join(dir,'response-cache',x),'utf8').includes('RESULT')));
});
test('aborting a stream cancels inference and the next turn recovers from desktop history',async t=>{
 const {post,logs}=await setup(t);const abort=new AbortController();
 const res=await post(request('slow-response'),{signal:abort.signal});const reader=res.body.getReader();
 let got='';while(!got.includes('waiting')){const {value}=await reader.read();got+=new TextDecoder().decode(value);}
 abort.abort();
 for(let i=0;i<40&&!logs.some(x=>x.event==='claude_exit');i++)await new Promise(r=>setTimeout(r,25));
 const next=await(await post(request('continue after interruption','user2'))).text();
 assert.ok(output(next));assert.ok(logs.some(x=>x.event==='interrupted_turn_recovery'));
});
test('wrong model, missing authentication, and browser origins are rejected',async t=>{
 const {b,post}=await setup(t);
 assert.equal((await fetch(b.url+'/health')).status,401);
 assert.equal((await fetch(b.url+'/health',{headers:{Authorization:'Bearer fixture-secret',Origin:'https://example.com'}})).status,403);
 assert.equal((await post({...request('x'),model:'some-other-model'})).status,400);
});
test('authenticated desktop zstd requests use a separate bridge header',async t=>{
 const {b}=await setup(t);const res=await fetch(b.url+'/v1/responses',{method:'POST',headers:{'X-Claude-Bridge-Key':'fixture-secret',Authorization:'Bearer desktop-token-not-forwarded','Content-Type':'application/json','Content-Encoding':'zstd','thread-id':'compressed'},body:zstdCompressSync(Buffer.from(JSON.stringify(request('compressed input'))))});
 assert.match(JSON.stringify(output(await res.text())),/compressed input/);
});
test('non-JSON desktop requests name their endpoint instead of failing as bad JSON',async t=>{
 const {b,logs}=await setup(t);
 const res=await fetch(b.url+'/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'multipart/form-data; boundary=x'},body:'--x\r\nContent-Disposition: form-data; name="file"\r\n\r\nabc\r\n--x--'});
 assert.equal(res.status,404);assert.match((await res.json()).error.message,/\/v1\/audio\/transcriptions/);
 assert.deepEqual(logs.find(x=>x.event==='unsupported_body'),{event:'unsupported_body',path:'/v1/audio/transcriptions',content_type:'multipart/form-data',bytes:62});
});
test('helper agents receive agent_message tasks and follow-ups as input',async t=>{
 const {post,logs}=await setup(t);
 const task=(id,text,author='/root',recipient='/root/task_b')=>({type:'agent_message',id,author,recipient,content:[{type:'input_text',text:'Message Type: NEW_TASK\nTask name: '+recipient+'\nSender: '+author+'\nPayload:\n'},{type:'encrypted_content',encrypted_content:text}]});
 const first={model:MODEL,stream:true,tools,instructions:'fixture',input:[{type:'message',id:'env',role:'user',content:[{type:'input_text',text:'<environment_context/>'}]},task('amsg_1','echo-input first task')]};
 const a=await(await post(first)).text();
 const reply=output(a);assert.match(reply[0].content[0].text,/<agent_message author=\\"\/root\\" recipient=\\"\/root\/task_b\\">/);assert.match(reply[0].content[0].text,/echo-input first task/);
 const second={...first,input:[...first.input,...reply,task('amsg_2','echo-input follow-up')]};
 const b=await(await post(second)).text();
 const text=output(b)[0].content[0].text;assert.match(text,/follow-up/);assert.doesNotMatch(text,/first task/);
 assert.ok(!logs.some(x=>x.event==='request_error'));
});
test('encrypted compaction checkpoints survive restarts and reject tampering',()=>{
 const checkpoint=sealCheckpoint('Remember amber pine 742','secret');
 assert.equal(openCheckpoint(checkpoint,'secret'),'Remember amber pine 742');
 assert.throws(()=>openCheckpoint(checkpoint,'different-secret'));
 assert.throws(()=>openCheckpoint(checkpoint.slice(0,-5)+'aaaaa','secret'));
});
test('edited messages, undo, and regeneration rebuild from authoritative history',async t=>{
 const {post,logs}=await setup(t);
 const first=request('original message');const a=output(await(await post(first)).text());
 const second={...first,input:[...first.input,...a,...request('next message','user2').input]};
 await(await post(second)).text();
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,true);
 const edited=request('edited message');
 const result=await(await post(edited)).text();assert.match(JSON.stringify(output(result)),/edited message/);
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,false);
 // A different desktop turn with the same body means regenerate, not a retry.
 await(await post(edited,{headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'fixture','x-codex-turn-metadata':JSON.stringify({turn_id:'regenerated'})}})).text();
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,false);
 const undone={...first,input:[...first.input,...a,...request('different branch','user3').input]};
 const undoResult=await(await post(undone)).text();assert.match(JSON.stringify(output(undoResult)),/different branch/);
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,false);
 assert.equal(logs.filter(x=>x.event==='history_branch_rebuilt').length,3);
});
test('HTTP tool requests arriving before native stdout are matched once',async t=>{
 const {post,logs}=await setup(t);const first=request('racing-tool');
 const call=output(await(await post(first)).text())[0];
 const second={...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'race resolved'}]};
 const final=output(await(await post(second)).text());
 assert.match(JSON.stringify(final),/race resolved/);assert.equal(logs.some(x=>x.event==='error'),false);
});
test('malformed continuation fails without poisoning subsequent requests',async t=>{
 const {post}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 await(await post({...first,input:[...first.input,call]})).text();
 const retry=request('recovered','user2');
 assert.ok(output(await(await post(retry)).text()));
});
test('response cache removes expired and legacy plaintext files',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['old.sealed','current.sealed','legacy.sse'])fs.writeFileSync(path.join(dir,name),'fixture');
 fs.utimesSync(path.join(dir,'old.sealed'),new Date(0),new Date(0));
 pruneResponseCache(dir);
 assert.deepEqual(fs.readdirSync(dir),['current.sealed']);
});

const resumed=final=>{const text=final.find(x=>x.type==='message').content[0].text;assert.match(text,/^RESUMED /);return JSON.parse(text.slice(8));};
// The stored record of the first native session started in a test.
const record=(dir,logs)=>JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(x=>x.startsWith(logs.find(e=>e.event==='claude_start').session)&&x.endsWith('.json'))),'utf8'));
async function stopWhileStreaming(post,body,logs) {
 const abort=new AbortController();const reader=(await post(body,{signal:abort.signal})).body.getReader();let got='';
 while(!got.includes('waiting')){const {value}=await reader.read();got+=new TextDecoder().decode(value);}
 abort.abort();await waitUntil(()=>logs.some(x=>x.event==='claude_exit'));
}
async function waitUntil(predicate) {
 for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}
 assert.fail('Timed out waiting for fixture condition');
}
test('native tool timeout is recovered without losing a retry or rerunning an observed tool',async t=>{
 const {post,logs,b}=await setup(t);const first=request('timeout-tool');
 const call=output(await(await post(first)).text())[0];
 await waitUntil(()=>logs.some(x=>x.event==='error'));
 const next={...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'already executed: 323'}]};
 const final=output(await(await post(next)).text());
 assert.match(JSON.stringify(final),/already executed: 323/);
 assert.equal(logs.filter(x=>x.event==='tool_call').length,1);
 assert.ok(logs.some(x=>x.event==='interrupted_turn_recovery'));
 await waitUntil(()=>[...b.sessions.values()].every(s=>!s.child));
});
test('immediate continuation after Stop waits for the cancelled process to close',async t=>{
 const {post,b,logs,dir}=await setup(t);const first=request('stop-after-tool');
 const call=output(await(await post(first)).text())[0];
 const history=[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'323'}];
 const abort=new AbortController();const res=await post({...first,input:history},{signal:abort.signal});
 const reader=res.body.getReader();let chunks='';
 while(!chunks.includes('waiting after tool')){const {value}=await reader.read();chunks+=new TextDecoder().decode(value);}
 abort.abort();
 await waitUntil(()=>[...b.sessions.values()][0].stopping);
 assert.ok([...b.sessions.values()][0].child,'Fixture must still be exiting when continuation starts');
 const final=output(await(await post({...first,input:[...history,...request('continue now','user2').input]})).text());
 const report=resumed(final);
 assert.match(report.request,/turn_stopped.*continue now/);
 // The result Claude already received is not sent again.
 assert.doesNotMatch(report.request,/323/);
 assert.equal(report.resume,record(dir,logs).claudeId);
 assert.ok(logs.some(x=>x.event==='stopped_turn_resumed'));assert.equal(logs.some(x=>x.event==='interrupted_turn_recovery'),false);
 assert.equal(logs.filter(x=>x.event==='claude_start').length,2);
});
test('a new user message can abandon a tool cycle that has no result',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('invoke-tool');
 const a=output(await(await post(first)).text());
 const next={...first,input:[...first.input,...a,...request('That tool was stopped. Answer this new message.','u2').input]};
 const report=resumed(output(await(await post(next)).text()));
 assert.match(report.request,/turn_stopped.*already reached the host.*Answer this new message/);assert.doesNotMatch(report.request,/invoke-tool/);
 assert.equal(report.resume,record(dir,logs).claudeId);
 assert.ok(logs.some(x=>x.event==='cancel'&&x.reason==='tool_cycle_interrupted'));
 assert.ok(logs.some(x=>x.event==='stopped_turn_resumed'&&x.items===1));
 assert.equal(logs.filter(x=>x.event==='tool_call').length,1);
});
test('Stop during a response resumes the native session with only what came after',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('slow-response');
 await stopWhileStreaming(post,first,logs);
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted the previous turn.</turn_aborted>'}]};
 const report=resumed(output(await(await post({...first,input:[...first.input,note,...request('continue after stop','user2').input]})).text()));
 assert.match(report.request,/turn_stopped.*stopped before it finished.*developer_message.*turn_aborted.*continue after stop/);
 assert.doesNotMatch(report.request,/slow-response|Continue the task|reached the host/);
 assert.equal(report.resume,record(dir,logs).claudeId);
 assert.ok(logs.some(x=>x.event==='stopped_turn_resumed'&&x.items===2));
});
test('a turn cut off by a bridge restart resumes when the desktop retries it',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-test-'));const logs=[];let b;
 t.after(async()=>{await b?.close();fs.rmSync(dir,{recursive:true,force:true});});
 const start=()=>startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data})});
 const poster=b=>(body,extra={})=>fetch(b.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'fixture'},body:JSON.stringify(body),...extra});
 const first=request('slow-response');const a=await start();
 const res=await poster(a)(first);const reader=res.body.getReader();let got='';
 while(!got.includes('waiting')){const {value}=await reader.read();got+=new TextDecoder().decode(value);}
 await a.close();
 b=await start();
 const report=resumed(output(await(await poster(b)(first)).text()));
 assert.match(report.request,/bridge restart.*Continue the task from where it stopped/);
 assert.equal(report.resume,record(dir,logs).claudeId);
 assert.ok(logs.some(x=>x.event==='stopped_turn_resumed'&&x.reason==='Bridge shutting down.'&&x.items===0));
});
test('a compaction after a Stop forks the stopped native session',async t=>{
 const {post,logs,dir}=await setup(t);const first={...request('slow-response'),reasoning:{effort:'high'}};
 await stopWhileStreaming(post,first,logs);
 const text=await checkpoint(await compact(post,{...first,input:[...first.input,...request('next question','user2').input]}));
 const report=JSON.parse(text.replace(/^FORK /,''));
 assert.equal(report.fork,true);assert.equal(report.effort,'high');assert.equal(report.resume,record(dir,logs).claudeId);
 assert.match(report.request,/next question.*compaction_request/);assert.doesNotMatch(report.request,/slow-response/);
 assert.ok(logs.some(x=>x.event==='compaction_fork'&&x.extra_items===1));assert.equal(logs.some(x=>x.event==='history_import'),false);
});
test('messages arriving mid-response answer the tool calls the desktop dropped, without a rebuild',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('invoke-tool');
 const [call]=output(await(await post(first)).text());assert.equal(call.type,'custom_tool_call');
 const mail={type:'agent_message',id:'amsg_done',author:'/root/helper',recipient:'/root',content:[{type:'input_text',text:'Message Type: FINAL_ANSWER\nPayload:\n'},{type:'encrypted_content',encrypted_content:'helper finished'}]};
 // Recorded from the desktop: the unexecuted call is gone and the helper's answer is appended.
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,mail]})).text()));
 assert.match(final,/Not run: new messages arrived/);assert.match(final,/STEERED/);assert.match(final,/helper finished/);assert.doesNotMatch(final,/Before your next tool call/);
 assert.equal(fs.readFileSync(path.join(dir,'fake-starts'),'utf8').trim().split('\n').length,1);
 assert.ok(logs.some(x=>x.event==='tool_superseded'&&x.call_id===call.call_id));
 assert.equal(logs.some(x=>['history_branch_rebuilt','tool_cycle_interrupted','error'].includes(x.event)),false);
});
test('a user message sent during a tool cycle reaches Claude with the result and asks for a visible reply',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'completed once'},...request('btw use the other worker','user2').input]})).text()));
 assert.match(final,/RESULT/);assert.match(final,/STEERED.*btw use the other worker.*Before your next tool call/);
 assert.equal(fs.readFileSync(path.join(dir,'fake-starts'),'utf8').trim().split('\n').length,1);
 assert.ok(logs.some(x=>x.event==='user_steering'));
});
test('a mid-turn message that Claude Code queues late still reaches Claude before the tool result',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'completed once'},...request('slow-queue screenshot question','user2').input]})).text()));
 assert.match(final,/RESULT.*STEERED.*slow-queue screenshot question/);
 assert.equal(logs.some(x=>x.event==='steering_unconfirmed'),false);
});
test('an unconfirmed mid-turn message does not hold the tool result forever',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'completed once'},...request('never-queued note','user2').input]})).text()));
 assert.match(final,/RESULT.*STEERED.*never-queued note/);
 assert.ok(logs.some(x=>x.event==='steering_unconfirmed'));
});
test('a reply to a mid-turn message written only in thinking is shown before the next tool call',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const input=[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'completed once'},...request('think-only use the other worker','user2').input];
 const out=output(await(await post({...first,input})).text());
 assert.equal(out[0].type,'message');assert.equal(out[0].content[0].text,'Got it, switching to the other worker.');assert.equal(out[0].phase,'commentary');
 assert.equal(out[1].type,'custom_tool_call');
 assert.ok(logs.some(x=>x.event==='steering_ack_from_thinking'));
 const final=JSON.stringify(output(await(await post({...first,input:[...input,...out,{type:'custom_tool_call_output',call_id:out[1].call_id,output:'next done'}]})).text()));
 assert.match(final,/DONE/);
});
test('a clock.sleep the desktop never answers is stopped and the next message resumes the session',async t=>{
 const {post,logs,dir}=await setup(t,{sleepGraceMs:100});
 const sleepTools=[...tools,{type:'namespace',name:'clock',tools:[{type:'function',name:'sleep',description:'Sleeps.',parameters:{type:'object',properties:{duration_ms:{type:'number'}},required:['duration_ms']}}]}];
 const first={...request('sleep-tool'),tools:sleepTools};
 const out=output(await(await post(first)).text());
 assert.equal(out[0].type,'function_call');assert.equal(out[0].name,'sleep');assert.equal(out[0].namespace,'clock');
 await waitUntil(()=>logs.some(x=>x.event==='claude_exit'));
 assert.ok(logs.some(x=>x.event==='host_sleep_abandoned'));
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted the previous turn.</turn_aborted>'}]};
 const report=resumed(output(await(await post({...first,input:[...first.input,...out,note,...request('continue after stop','user2').input]})).text()));
 assert.equal(report.resume,record(dir,logs).claudeId);
 assert.equal(fs.readFileSync(path.join(dir,'fake-starts'),'utf8').trim().split('\n').length,2);
});
test('a clock.sleep answered in time is not stopped',async t=>{
 const {post,logs}=await setup(t,{sleepGraceMs:200});
 const sleepTools=[...tools,{type:'namespace',name:'clock',tools:[{type:'function',name:'sleep',description:'Sleeps.',parameters:{type:'object',properties:{duration_ms:{type:'number'}},required:['duration_ms']}}]}];
 const first={...request('sleep-tool'),tools:sleepTools};
 const out=output(await(await post(first)).text());
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,...out,{type:'function_call_output',call_id:out[0].call_id,output:'Sleep completed.'}]})).text()));
 assert.match(final,/SLEPT/);
 await new Promise(r=>setTimeout(r,400));
 assert.equal(logs.some(x=>x.event==='host_sleep_abandoned'),false);
});
test('an edited transcript during a tool cycle still rebuilds even when a message is appended',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 output(await(await post(first)).text());
 const edited=request('echo-input edited instead','user1');
 const final=JSON.stringify(output(await(await post({...edited,input:[...edited.input,...request('echo-input more','user2').input]})).text()));
 assert.match(final,/edited instead/);
 assert.ok(logs.some(x=>x.event==='history_branch_rebuilt'));assert.equal(logs.some(x=>x.event==='tool_superseded'),false);
});
test('changed developer instructions rebuild a running tool cycle with the observed result',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const next={...first,input:[{type:'message',role:'developer',content:'UPDATED-POLICY'},...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'completed once'}]};
 const final=output(await(await post(next)).text());
 assert.match(JSON.stringify(final),/updatedPolicy\\":true/);
 assert.ok(logs.some(x=>x.event==='instructions_changed'));
 assert.equal(logs.filter(x=>x.event==='tool_call').length,1);
});
test('a developer note added during a tool cycle reaches Claude with the result, without a rebuild',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<image_resize_notice>Image 1 was resized.</image_resize_notice>'}]};
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'completed once'},note]})).text()));
 assert.match(final,/RESULT/);assert.match(final,/STEERED/);assert.match(final,/developer_message.*image_resize_notice/);
 assert.equal(fs.readFileSync(path.join(dir,'fake-starts'),'utf8').trim().split('\n').length,1);
 assert.equal(logs.some(x=>['instructions_changed','tool_cycle_interrupted','history_branch_rebuilt','error'].includes(x.event)),false);
});
test('a developer note added between turns arrives with the next message and leaves the system prompt unchanged',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('hello');
 const answer=output(await(await post(first)).text());
 const prompt=()=>fs.readdirSync(dir).filter(x=>x.endsWith('.system.txt')).map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('');
 const before=prompt();
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<codex_apps_client_time_context>NEW-DATE</codex_apps_client_time_context>'}]};
 const final=JSON.stringify(output(await(await post({...first,input:[...first.input,...answer,note,...request('echo-input next','user2').input]})).text()));
 assert.match(final,/developer_message.*NEW-DATE.*echo-input next/);
 assert.equal(prompt(),before);assert.doesNotMatch(prompt(),/NEW-DATE/);
 assert.equal(logs.some(x=>['instructions_changed','regeneration_rebuilt','history_branch_rebuilt','error'].includes(x.event)),false);
 assert.ok(logs.filter(x=>x.event==='claude_start').at(-1).resume);
});
const compact=(post,body)=>post(body,{headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'fixture','x-codex-turn-metadata':JSON.stringify({request_kind:'compaction'})}});
// The desktop reads the checkpoint from the assistant message; the sealed item carries the same text.
const checkpoint=async response=>{
 const out=output(await response.text());assert.deepEqual(out.map(x=>x.type),['message','compaction']);
 const text=out[0].content[0].text;assert.equal(out[0].role,'assistant');assert.equal(openCheckpoint(out[1].encrypted_content,'fixture-secret'),text);return text;
};
test('a compaction at a turn boundary forks the native session with its prompt, tools and effort',async t=>{
 const {post,logs,dir}=await setup(t);const first={...request('hello'),reasoning:{effort:'high'}};
 const answer=output(await(await post(first)).text());
 const next=request('next question','user2').input[0];
 const text=await checkpoint(await compact(post,{...first,reasoning:{effort:'low'},input:[...first.input,...answer,next]}));
 const report=JSON.parse(text.replace(/^FORK /,''));
 const turn=logs.find(x=>x.event==='claude_start');
 assert.equal(report.fork,true);assert.equal(report.effort,'high');assert.deepEqual(report.tools,['exec']);
 assert.equal(report.resume,JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(x=>x.startsWith(turn.session)&&x.endsWith('.json'))),'utf8')).claudeId);
 assert.match(report.prompt,/^fixture/);assert.match(report.request,/history_message role=\\"user\\".*next question.*compaction_request/);
 assert.ok(logs.some(x=>x.event==='compaction_fork'&&x.extra_items===1&&x.cold===false));assert.equal(report.caching,'on');
 assert.equal(logs.some(x=>x.event==='history_import'||x.event==='error'),false);
});
test('a compaction of a session idle past the cache lifetime does not write a cache',async t=>{
 const {post,logs,dir}=await setup(t);const first=request('hello');
 const answer=output(await(await post(first)).text());
 const stale=new Date(Date.now()-2*3600000);fs.utimesSync(path.join(dir,fs.readdirSync(dir).find(x=>/^[0-9a-f]{64}\.json$/.test(x))),stale,stale);
 const report=JSON.parse((await checkpoint(await compact(post,{...first,input:[...first.input,...answer,request('next question','user2').input[0]]}))).replace(/^FORK /,''));
 assert.equal(report.fork,true);assert.equal(report.caching,'off');
 assert.ok(logs.some(x=>x.event==='compaction_fork'&&x.cold===true));
});
test('a tool call inside a compaction fork is refused and the checkpoint still returns',async t=>{
 const {post,logs}=await setup(t);const first=request('hello');
 const answer=output(await(await post(first)).text());
 const text=await checkpoint(await compact(post,{...first,input:[...first.input,...answer,request('call-tool-first','user2').input[0]]}));
 assert.match(text,/Not run: the host is compacting/);
 assert.ok(logs.some(x=>x.event==='compaction_tool_refused'));assert.equal(logs.some(x=>x.event==='error'),false);
});
test('a compaction during a tool cycle imports the transcript instead of forking',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const text=await checkpoint(await compact(post,{...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'done'}]}));
 assert.match(text,/^REPLAY/);
 assert.equal(logs.some(x=>x.event==='compaction_fork'),false);assert.ok(logs.some(x=>x.event==='history_import'));
 assert.ok(logs.some(x=>x.event==='compaction_import'&&x.reason==='turn_in_progress'));
 // The desktop continues in a new window, so the waiting turn process is stopped.
 await waitUntil(()=>logs.some(x=>x.event==='cancel'&&x.reason==='compacted_mid_turn'));
 const turn=logs.find(x=>x.event==='cancel'&&x.reason==='compacted_mid_turn').session;
 await waitUntil(()=>logs.some(x=>x.event==='claude_exit'&&x.session===turn));
});
test('stored tool lists older than a day are pruned',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tool-sets-'));
 fs.writeFileSync(path.join(dir,'old.json'),'[]');fs.writeFileSync(path.join(dir,'new.json'),'[]');
 const old=new Date(Date.now()-2*86400000);fs.utimesSync(path.join(dir,'old.json'),old,old);
 pruneToolSets(dir);assert.deepEqual(fs.readdirSync(dir),['new.json']);fs.rmSync(dir,{recursive:true});
});
test('explicit unsupported constraints fail before starting a native process',async t=>{
 const {post,logs}=await setup(t);
 for(const constraint of [{tool_choice:'none'},{text:{format:{type:'grammar'}}},{text:{format:{type:'json_schema'}}},{max_output_tokens:10}]) {
  const response=await post({...request('x'),...constraint});assert.equal(response.status,400);
  assert.match((await response.json()).error.message,/Unsupported request constraint/);
 }
 assert.equal(logs.some(x=>x.event==='claude_start'),false);
});
test('structured output requests (titles, suggestions) return the validated JSON as the final answer',async t=>{
 const {post,logs}=await setup(t);
 const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties:{title:{type:'string'},description:{type:'string'}},required:['title','description'],additionalProperties:false};
 const response=await post({...request('name this task'),tools:[],text:{format:{type:'json_schema',name:'title',strict:true,schema}}});
 assert.equal(response.status,200);
 const items=output(await response.text());
 const final=items.filter(x=>x.type==='message'&&x.phase==='final_answer');
 assert.equal(final.length,1);
 assert.deepEqual(JSON.parse(final[0].content[0].text),{title:'Fixture title',required:['title','description']});
 assert.ok(items.some(x=>x.phase==='commentary'&&x.content[0].text==='Choosing a title.'));
 assert.equal(items.some(x=>/StructuredOutput/.test(JSON.stringify(x))),false);
 assert.equal(logs.some(x=>x.event==='request_error'||x.event==='error'),false);
});
test('parallel_tool_calls=false relays one host tool call per response',async t=>{
 const {post}=await setup(t);const first={...request('two-tools'),parallel_tool_calls:false};
 const a=output(await(await post(first)).text());
 assert.equal(a.length,1);assert.equal(a[0].input,'text("one");');
 const second={...first,input:[...first.input,a[0],{type:'custom_tool_call_output',call_id:a[0].call_id,output:'ONE'}]};
 const b=output(await(await post(second)).text());
 assert.equal(b.length,1);assert.equal(b[0].input,'text("two");');
 const third={...second,input:[...second.input,b[0],{type:'custom_tool_call_output',call_id:b[0].call_id,output:'TWO'}]};
 const done=JSON.stringify(output(await(await post(third)).text()));
 assert.match(done,/RESULTS/);assert.match(done,/ONE/);assert.match(done,/TWO/);
});
test('long or silent host tools are not abandoned, and long descriptions and large results reach Claude whole',async t=>{
 const {post}=await setup(t);
 assert.match(JSON.stringify(output(await(await post(request('env-probe'))).text())),/ENV 86400000 4000000 idle:0 output:200000 size:1000000 /);
});
const probe=async(post,text,body={},thread='fixture')=>{
 const out=output(await(await post({...request(text),...body},{headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':thread}})).text());
 const reply=out.find(x=>x.type==='message').content[0].text;return JSON.parse(reply.slice(reply.indexOf(' ')+1));
};
// Sets environment variables for one test, as the bridge's own service environment would carry them.
function withEnv(t,values){
 const saved=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
 for(const [k,v] of Object.entries(values))process.env[k]=v;
 t.after(()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
}
const failure=text=>events(text).find(x=>x.type==='response.failed')?.response.error.message;
test('login mode runs the plain Claude Code login: inherited keys, tokens and endpoints never reach it',async t=>{
 withEnv(t,{ANTHROPIC_API_KEY:'fixture-inherited-key',CLAUDE_CODE_OAUTH_TOKEN:'fixture-inherited-oauth',ANTHROPIC_BASE_URL:'http://fixture.invalid',CLAUDE_CONFIG_DIR:'/fixture/claude-config'});
 const {post,logs}=await setup(t);
 assert.deepEqual(await probe(post,'auth-probe'),{key:null,oauth:null,base:null,configDir:'/fixture/claude-config'});
 assert.equal(logs.find(x=>x.event==='claude_start').auth,'claude_login');
 assert.equal(JSON.stringify(logs).includes('fixture-inherited'),false);
});
test('API key mode gives Claude Code only the configured key and never logs it',async t=>{
 withEnv(t,{ANTHROPIC_API_KEY:'fixture-inherited-key',CLAUDE_CODE_OAUTH_TOKEN:'fixture-inherited-oauth',ANTHROPIC_BASE_URL:'http://fixture.invalid'});
 const {post,logs}=await setup(t,{auth:{mode:'api_key',apiKey:()=>'fixture-api-key'}});
 const seen=await probe(post,'auth-probe');
 assert.equal(seen.key,'fixture-api-key');assert.equal(seen.oauth,null);assert.equal(seen.base,null);
 assert.equal(logs.find(x=>x.event==='claude_start').auth,'api_key');
 assert.equal(JSON.stringify(logs).includes('fixture-api-key'),false);
});
test('API key mode without a key fails the request clearly and starts nothing',async t=>{
 const {post,logs,dir}=await setup(t,{auth:{mode:'api_key',apiKey:()=>undefined}});
 assert.match(failure(await(await post(request('hello'))).text()),/no ANTHROPIC_API_KEY/);
 assert.equal(logs.some(x=>x.event==='claude_start'),false);assert.equal(fs.existsSync(path.join(dir,'fake-starts')),false);
});
test('unknown auth modes are refused at startup',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-test-'));
 await assert.rejects(startBridge({stateDir:dir,token:'x',port:0,claude:fixture,auth:{mode:'oauth_token'}}),/Unknown auth mode oauth_token/);
 fs.rmSync(dir,{recursive:true,force:true});
});
test('each catalog model starts Claude Code with its own model, effort and name; Haiku gets no effort flag',async t=>{
 const {post,logs}=await setup(t);
 const opus=await probe(post,'model-probe',{},'t-opus');
 assert.deepEqual({requested:opus.requested,model:opus.model,effort:opus.effort,identity:opus.identity,webSearch:opus.webSearch},{requested:'opus',model:'claude-opus-5-5',effort:'medium',identity:'Claude Opus',webSearch:false});
 const sonnet=await probe(post,'model-probe',{model:'claude-sonnet',reasoning:{effort:'high'}},'t-sonnet');
 assert.deepEqual([sonnet.requested,sonnet.model,sonnet.effort,sonnet.identity],['sonnet','claude-sonnet-5-5','high','Claude Sonnet']);
 const haiku=await probe(post,'model-probe',{model:'claude-haiku',reasoning:{effort:'medium'}},'t-haiku');
 assert.deepEqual([haiku.requested,haiku.model,haiku.effort,haiku.identity],['haiku','claude-haiku-4-5-20251001',null,'Claude Haiku']);
 assert.deepEqual(logs.filter(x=>x.event==='claude_start').map(x=>[x.model,x.claude_model,x.effort]),[['claude-opus','opus','medium'],['claude-sonnet','sonnet','high'],['claude-haiku','haiku',null]]);
 assert.deepEqual(logs.filter(x=>x.event==='turn_complete').map(x=>x.model),['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-4-5-20251001']);
});
test('unknown models and unsupported efforts are refused before Claude Code starts',async t=>{
 const {post,logs}=await setup(t);
 const unknown=await post({...request('x'),model:'claude-opus-5-5'});assert.equal(unknown.status,400);
 assert.match((await unknown.json()).error.message,/Unknown model claude-opus-5-5\. This bridge serves claude-opus, claude-sonnet, claude-haiku\. There is no fallback model\./);
 const effort=await post({...request('x'),model:'claude-sonnet',reasoning:{effort:'ultra'}});assert.equal(effort.status,400);
 assert.match((await effort.json()).error.message,/Claude Sonnet does not support ultra effort/);
 assert.equal(logs.some(x=>x.event==='claude_start'),false);
});
test('an alias is pinned to the model Claude Code first started for it',async t=>{
 const {post}=await setup(t);
 const first=request('model-probe');
 const a=output(await(await post(first)).text());
 assert.deepEqual(JSON.parse(a[0].content[0].text.slice(6)).pins,{opus:null,sonnet:null,haiku:null,subagent:null});
 const second=JSON.parse(output(await(await post({...first,input:[...first.input,...a,...request('model-probe again','user2').input]})).text())[0].content[0].text.slice(6));
 assert.equal(second.resume,true);
 assert.deepEqual(second.pins,{opus:'claude-opus-5-5',sonnet:'claude-opus-5-5',haiku:'claude-opus-5-5',subagent:'claude-opus-5-5'});
});
test('an alias accepts another version of its family; a pinned id or another family is refused',async t=>{
 withEnv(t,{FAKE_CLAUDE_MODEL:'claude-opus-5-6'});
 const alias=await setup(t);
 assert.equal((await probe(alias.post,'model-probe')).model,'claude-opus-5-6');
 const pinned=await setup(t,{models:parseModels({models:[{slug:'opus-pinned',claude_model:'claude-opus-5-5',display_name:'Claude Opus 5.5',efforts:['low','medium'],context_window:1000000}]})});
 assert.match(failure(await(await pinned.post({...request('hello'),model:'opus-pinned'})).text()),/Claude Code started claude-opus-5-6 for Claude Opus 5\.5 \(claude-opus-5-5\)\. The bridge does not switch models silently\./);
 process.env.FAKE_CLAUDE_MODEL='claude-sonnet-5-5';
 assert.match(failure(await(await alias.post(request('hello','u9'),{headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'other-family'}})).text()),/started claude-sonnet-5-5 for Claude Opus \(opus\)/);
});
test('a fallback model mid-turn fails the turn instead of switching silently',async t=>{
 const {post,logs}=await setup(t);
 assert.match(failure(await(await post(request('fallback-model'))).text()),/answered with claude-opus-4-8 instead of claude-opus-5-5\. Its safety classifiers can re-run a flagged request on a fallback model/);
 assert.equal(logs.some(x=>x.event==='turn_complete'),false);
});
test('switching Claude models between turns resumes the native session on the new model',async t=>{
 const {post,logs}=await setup(t);const first=request('model-probe');
 const a=output(await(await post(first)).text());
 const next=JSON.parse(output(await(await post({...first,model:'claude-sonnet',input:[...first.input,...a,...request('model-probe on sonnet','user2').input]})).text())[0].content[0].text.slice(6));
 assert.deepEqual([next.requested,next.model,next.resume,next.identity],['sonnet','claude-sonnet-5-5',true,'Claude Sonnet']);
 assert.ok(logs.some(x=>x.event==='model_switched'&&x.from==='claude-opus'&&x.to==='claude-sonnet'));
 assert.equal(logs.some(x=>['history_branch_rebuilt','regeneration_rebuilt','error'].includes(x.event)),false);
});
test('a model change while Claude waits on a tool result rebuilds from the transcript',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];
 const final=JSON.stringify(output(await(await post({...first,model:'claude-haiku',input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'observed once'}]})).text()));
 assert.match(final,/REPLAY/);assert.match(final,/observed once/);
 assert.ok(logs.some(x=>x.event==='model_changed'));assert.equal(logs.filter(x=>x.event==='tool_call').length,1);
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).model,'claude-haiku');
});
test('a compaction fork keeps the session model even when the desktop asks with another',async t=>{
 const {post,logs}=await setup(t);const first={...request('hello'),model:'claude-sonnet',reasoning:{effort:'low'}};
 const answer=output(await(await post(first)).text());
 const report=JSON.parse((await checkpoint(await compact(post,{...first,model:'claude-opus',reasoning:{effort:'high'},input:[...first.input,...answer,request('next question','user2').input[0]]}))).replace(/^FORK /,''));
 assert.equal(report.fork,true);assert.equal(report.model,'claude-sonnet-5-5');assert.equal(report.effort,'low');
 assert.ok(logs.some(x=>x.event==='compaction_fork'));
});
test('the models endpoint and health check list the catalog, auth mode and search setting',async t=>{
 const {b}=await setup(t);const get=p=>fetch(b.url+p,{headers:{Authorization:'Bearer fixture-secret'}}).then(r=>r.json());
 assert.deepEqual((await get('/v1/models')).data.map(m=>[m.id,m.display_name]),[['claude-opus','Claude Opus'],['claude-sonnet','Claude Sonnet'],['claude-haiku','Claude Haiku']]);
 const health=await get('/health');
 assert.deepEqual([health.models,health.auth,health.web_search],[['claude-opus','claude-sonnet','claude-haiku'],'claude_login',false]);
});
test('Claude Code is found through CLAUDE_BIN, then PATH, with an install hint when missing',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bin-'));const bin=path.join(dir,'claude');
 fs.writeFileSync(bin,'#!/bin/sh\n',{mode:0o755});fs.mkdirSync(path.join(dir,'empty'));
 assert.equal(findClaude({CLAUDE_BIN:'/custom/claude',PATH:dir},[]),'/custom/claude');
 assert.equal(findClaude({PATH:[path.join(dir,'empty'),dir].join(path.delimiter)},[]),bin);
 assert.equal(findClaude({PATH:''},[dir]),bin);
 assert.throws(()=>findClaude({PATH:path.join(dir,'empty')},[]),/Claude Code was not found\. Install it from https:\/\/code\.claude\.com/);
 fs.rmSync(dir,{recursive:true});
});
test('a hallucinated tool name is answered natively instead of ending the turn',async t=>{
 const {post,logs}=await setup(t);
 const items=output(await(await post(request('unknown-tool'))).text());
 assert.ok(items.some(x=>x.phase==='commentary'&&x.content[0].text==='Searching.'));
 assert.deepEqual(items.filter(x=>x.phase==='final_answer').map(x=>x.content[0].text),['Recovered']);
 assert.equal(items.some(x=>x.type!=='message'),false);
 assert.ok(logs.some(x=>x.event==='unknown_tool'&&x.name==='web_run'));
 assert.equal(logs.some(x=>x.event==='request_error'||x.event==='error'),false);
});
test('completed sessions release transcript data and resume after idle eviction',async t=>{
 const {post,b,logs}=await setup(t);const first=request('remember fixture');
 const previous=output(await(await post(first)).text());
 await waitUntil(()=>[...b.sessions.values()].every(s=>!s.child));
 const session=[...b.sessions.values()][0];
 assert.equal(session.stream,null);assert.equal(session.streamInput,null);
 await evictIdleSessions(b,Date.now()+300001);assert.equal(b.sessions.size,0);
 const next={...first,input:[...first.input,...previous,...request('remember next','u2').input]};
 assert.ok(output(await(await post(next)).text()));
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,true);
});
test('large screenshot histories fit normal inference and compaction after bounded replay',async t=>{
 const {post,b}=await setup(t);const first=request('summarize observed screenshots');
 const image='data:image/png;base64,'+'A'.repeat(114*1024);
 const history=Array.from({length:300},(_,i)=>[
  {type:'custom_tool_call',call_id:'old'+i,name:'exec',input:'screenshot'},
  {type:'custom_tool_call_output',call_id:'old'+i,output:[{type:'input_text',text:'observation '+i},{type:'input_image',image_url:image}]}
 ]).flat();
 const body={...first,input:[...first.input,...history]};
 const bytes=Buffer.from(JSON.stringify(body));assert.ok(bytes.length>32*1024*1024);
 for(const kind of ['turn','compaction']) {
  const encoded=Buffer.from(JSON.stringify({...body,parallel_tool_calls:kind!=='compaction'}));
  const response=await post(body,{headers:{Authorization:'Bearer fixture-secret','thread-id':'images-'+kind,'content-encoding':'zstd','x-codex-turn-metadata':JSON.stringify({request_kind:kind})},body:zstdCompressSync(encoded)});
  const out=output(await response.text());assert.ok(out);
  const text=kind==='compaction'?out[0].content[0].text:JSON.stringify(out);
  assert.match(text,/observation 299/);
  const session=[...b.sessions.values()].find(s=>s.key.startsWith('images-'+kind+':'));
  assert.ok(session.record.imageCutoff>200);
 }
});
test('a running native image history rebuilds once at the window boundary and then resumes',async t=>{
 const {post,b,logs}=await setup(t);const first=request('invoke-tool');
 const a=output(await(await post(first)).text());const call=a[0];
 const images=Array.from({length:210},()=>({type:'input_image',image_url:'data:image/png;base64,YQ=='}));
 const history=[...first.input,...a,{type:'custom_tool_call_output',call_id:call.call_id,output:[{type:'input_text',text:'observed image batch'},...images]}];
 const reply=output(await(await post({...first,input:history})).text());
 assert.match(JSON.stringify(reply),/observed image batch/);
 assert.equal(logs.filter(x=>x.event==='image_history_bounded').length,1);
 assert.equal(logs.filter(x=>x.event==='tool_call').length,1);
 const cutoff=[...b.sessions.values()][0].record.imageCutoff;
 const next={...first,input:[...history,...reply,...request('continue with retained history','u2').input]};
 assert.ok(output(await(await post(next)).text()));
 assert.equal([...b.sessions.values()][0].record.imageCutoff,cutoff);
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,true);
});

test('when GPT answers between two Claude turns, the resumed session receives its messages and tool activity',async t=>{
 const {post,logs}=await setup(t);const first=request('remember fixture');
 const a=output(await(await post(first)).text());
 await waitUntil(()=>logs.some(x=>x.event==='claude_exit'));
 const gpt=[{type:'reasoning',id:'rs_1',encrypted_content:'gAAAA-gpt'},{type:'message',role:'assistant',content:[{type:'output_text',text:'GPT checked the build'}]},
  {type:'function_call',call_id:'call_gpt',name:'exec_command',arguments:'{"cmd":"make"}'},{type:'function_call_output',call_id:'call_gpt',output:'build ok'}];
 const input=[...first.input,...a,request('gpt turn','u2').input[0],...gpt,request('echo-input back to claude','u3').input[0]];
 const text=JSON.stringify(output(await(await post({...first,input})).text()));
 assert.match(text,/other_model_turns/);assert.match(text,/GPT checked the build/);assert.match(text,/previous_tool_call.*make/);assert.match(text,/build ok/);
 assert.doesNotMatch(text,/gAAAA-gpt/);
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,true);
 assert.ok(logs.some(x=>x.event==='other_model_turns'&&x.items===6));
 assert.equal(logs.some(x=>x.event==='history_branch_rebuilt'),false);
});

