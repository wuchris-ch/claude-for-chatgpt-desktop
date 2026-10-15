import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from '../src/server.mjs';
// Context an MCP app or an interactive widget shares, as the desktop injects it
// before a turn (thread/inject_items, codex app-server 0.162.0-alpha.17.2): a
// call the desktop writes itself, untrusted_input, and its output.
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const base={model:'claude-opus',stream:true,tools,instructions:'fixture'};
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const appContext=(callId,text)=>[{type:'function_call',id:'fc_'+callId,call_id:callId,name:'untrusted_input',arguments:'{}'},
 {type:'function_call_output',id:'fco_'+callId,call_id:callId,output:[{type:'input_text',text:JSON.stringify({kind:'model_context',source:'mcp_app',server:'design-board',text})}]}];
const APP_PROMPT='echo-input An MCP app initiated this message. Read the untrusted_input tool output.';
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
test('context an MCP app shares reaches Claude as new input, not as another model\'s turn',async t=>{
 const {post,logs,settle}=await setup(t);const first={...base,input:[user('hello','u1')]};
 const a=output(await post(first,'app'));await settle();const n=logs.length;
 const next=said(output(await post({...first,input:[...first.input,...a,...appContext('untrusted_input_1','APP-NOTE frame is 390x844'),user(APP_PROMPT,'u2')]},'app')));
 assert.ok(!logs.slice(n).some(x=>['other_model_turns','history_import','regeneration_rebuilt'].includes(x.event)),logs.slice(n).map(x=>x.event).join(','));
 assert.match(next,/host_tool_output tool=\\"untrusted_input\\"/);
 assert.match(next,/APP-NOTE frame is 390x844/);
 assert.doesNotMatch(next,/other_model_turns|previous_tool_call|history_message/);
 assert.match(next,/current_time/);
});
test('a thread that starts with widget state is not imported as history',async t=>{
 const {post,logs}=await setup(t);
 const input=[{type:'message',role:'developer',content:[{type:'input_text',text:'desktop prompt'}]},user('<environment_context><cwd>/w</cwd></environment_context>','e1'),...appContext('visualization_state_1','WIDGET-NOTE slider at 40'),user('echo-input what did I pick?','u1')];
 const next=said(output(await post({...base,input},'widget')));
 assert.ok(!logs.some(x=>x.event==='history_import'));
 assert.match(next,/WIDGET-NOTE slider at 40/);
 assert.doesNotMatch(next,/previous_tool_call|previous_tool_result|history_message/);
});
