import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from '../src/server.mjs';
// A message from another thread, as codex app-server 0.162.0-alpha.17.2 sends
// it for send_message_to_thread, create_thread and handoff_thread: a turn tool
// output with name and namespace and no call_id.
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const base={model:'claude-opus',stream:true,tools,instructions:'fixture'};
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const fromThread=(name,text,id)=>({type:'function_call_output',id,name,namespace:'codex_app',output:`<codex_delegation>\n  <source_thread_id>thread-a</source_thread_id>\n  <input>${text}</input>\n</codex_delegation>`});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;
const said=out=>(out??[]).filter(x=>x.type==='message').map(x=>x.content.map(c=>c.text).join('')).join(' ');
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-test-'));const logs=[];
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data})});
 t.after(async()=>{await b.close();fs.rmSync(dir,{recursive:true,force:true});});
 const post=(body,thread)=>fetch(b.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':thread},body:JSON.stringify(body)}).then(r=>r.text());
 const settle=async()=>{for(let i=0;i<400&&[...b.sessions.values()].some(s=>s.child);i++)await new Promise(r=>setTimeout(r,25));};
 return {logs,post,settle};
}
test('a message from another thread that arrives while Claude waits on a tool reaches Claude',async t=>{
 const {post}=await setup(t);const first={...base,input:[user('invoke-tool','u1')]};
 const a=output(await post(first,'mid'));const call=a.find(x=>x.type==='custom_tool_call');
 const next=await post({...first,input:[...first.input,...a,{type:'custom_tool_call_output',call_id:call.call_id,output:'exec ok'},fromThread('send_message_to_thread','MIDTURN-NOTE also run the tests','fco_1')]},'mid');
 assert.match(said(output(next)),/STEERED/);
 assert.match(said(output(next)),/MIDTURN-NOTE also run the tests/);
});
test('a message from another thread continues an idle thread without rebuilding it, as new input',async t=>{
 const {post,logs,settle}=await setup(t);const first={...base,input:[user('hello','u1')]};
 const a=output(await post(first,'idle'));await settle();const n=logs.length;
 const next=said(output(await post({...first,input:[...first.input,...a,fromThread('send_message_to_thread','echo-input IDLE-NOTE check the deploy','fco_2')]},'idle')));
 const later=logs.slice(n).map(x=>x.event);
 assert.ok(!later.includes('regeneration_rebuilt')&&!later.includes('history_import'),later.join(','));
 assert.match(next,/IDLE-NOTE check the deploy/);
 assert.match(next,/host_tool_output tool=\\"codex_app.send_message_to_thread\\"/);
 assert.doesNotMatch(next,/previous_tool_result/);
});
test('a thread started by create_thread gets its task as new input, not as an old tool result',async t=>{
 const {post,logs}=await setup(t);
 const input=[{type:'message',role:'developer',content:[{type:'input_text',text:'desktop prompt'}]},user('<environment_context><cwd>/w</cwd></environment_context>','e1'),fromThread('create_thread','echo-input CREATE-NOTE build it','fco_3')];
 const next=said(output(await post({...base,input},'created')));
 assert.match(next,/CREATE-NOTE build it/);
 assert.doesNotMatch(next,/previous_tool_result|call_id="undefined"/);
 assert.match(next,/current_time/);
 assert.ok(!logs.some(x=>x.event==='history_import'));
});
