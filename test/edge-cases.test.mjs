// Edge cases found by driving the ChatGPT app's own runtime against the bridge with real Claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from '../src/server.mjs';
const MODEL='claude-opus';
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const request=(text,id='user1')=>({model:MODEL,stream:true,tools,instructions:'fixture',input:[user(text,id)]});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;
const until=async(check,ms=5000)=>{for(let i=0;i<ms/25&&!check();i++)await new Promise(r=>setTimeout(r,25));};
async function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-hunt-'));const logs=[];
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data}),...options});
 t.after(async()=>{await b.close();fs.rmSync(dir,{recursive:true,force:true});});
 const post=(body,extra={})=>fetch(b.url+(extra.path??'/v1/responses'),{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'fixture',...extra.headers},body:JSON.stringify(body),signal:extra.signal});
 return {b,dir,logs,post};
}

test('a Stop before Claude Code reports init resumes the native session instead of rebuilding it',async t=>{
 const {post,logs,dir}=await setup(t);
 const base={model:MODEL,stream:true,tools,instructions:'fixture slow-init'};
 const u1=user('first','u1');
 const a=output(await(await post({...base,input:[u1]})).text());assert.ok(a);
 await until(()=>logs.filter(x=>x.event==='claude_exit').length>=1);
 // The desktop stops the next turn while Claude Code is still starting.
 const abort=new AbortController();
 const res=await post({...base,input:[u1,...a,user('second','u2')]},{signal:abort.signal});
 await res.body.getReader().read();abort.abort();
 await until(()=>logs.filter(x=>x.event==='claude_exit').length>=2);
 // The bridge waited for init, so Claude Code recorded the stopped message, then stopped it.
 const stopped=logs.findLastIndex(y=>y.event==='claude_start');
 assert.ok(!logs.some((x,i)=>x.event==='claude_ready'&&i>stopped),'stopped before init');
 assert.ok(logs.some((x,i)=>x.event==='stopped_at_init'&&i>stopped&&x.reason==='Desktop cancelled or disconnected.'));
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted the previous turn.</turn_aborted>'}]};
 const c=await(await post({...base,input:[u1,...a,user('second','u2'),note,user('third','u3')]})).text();
 assert.ok(!logs.some(x=>['interrupted_turn_recovery','history_import','history_branch_rebuilt'].includes(x.event)),'no rebuild from the desktop transcript');
 assert.equal(logs.filter(x=>x.event==='claude_start').at(-1).resume,true);
 assert.ok(logs.some(x=>x.event==='stopped_turn_resumed'&&x.items===2));
 // The resumed session gets only what came after the stop; the stopped message is in its transcript once.
 const said=JSON.stringify(output(c));
 assert.match(said,/RESUMED/);assert.match(said,/third/);assert.doesNotMatch(said,/second|REPLAY/);
 const prompts=fs.readFileSync(path.join(dir,'fake-entries'),'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.kind==='prompt');
 assert.equal(prompts.filter(e=>e.text.includes('second')).length,1);
});

test('every output the desktop records for one exec call reaches Claude, as with code mode notify()',async t=>{
 const {post}=await setup(t);const first=request('invoke-tool');
 const call=output(await(await post(first)).text())[0];assert.equal(call.type,'custom_tool_call');
 // Shape seen live: the cell's own output, then the one notify() added, both for the same call.
 const second={...first,input:[...first.input,call,
  {type:'custom_tool_call_output',call_id:call.call_id,output:[{type:'input_text',text:'Script completed\nOutput:\n'},{type:'input_text',text:'FINAL-B-29'}]},
  {type:'custom_tool_call_output',call_id:call.call_id,name:'exec',output:'NOTE-A-17'}]};
 const said=JSON.stringify(output(await(await post(second)).text()));
 assert.match(said,/RESULT/);assert.match(said,/FINAL-B-29/);assert.match(said,/NOTE-A-17/);
});

test('picker requests without standalone search do not tell Claude it has web__run',async t=>{
 const {post}=await setup(t,{webSearch:true,gatewayKey:'hunt-key',gatewayUpstream:'http://127.0.0.1:9/backend-api/codex'});
 const probe=(description,extra)=>post({model:MODEL,stream:true,instructions:'fixture',tools:[{type:'custom',name:'exec',description}],input:[user('model-probe','m1')]},extra).then(r=>r.text()).then(x=>JSON.parse(JSON.stringify(output(x))).map(o=>o.content?.[0]?.text).join('').replace(/^MODEL /,'')).then(JSON.parse);
 // Picker mode: the app's OpenAI provider documents no web__run inside exec.
 const picker=await probe('### `exec_command`\nRuns a command.',{path:'/g/hunt-key/backend-api/codex/responses',headers:{'thread-id':'picker-thread'}});
 assert.equal(picker.webSearch,false);
 // The separate window with search on documents web__run inside exec.
 const window=await probe('### `exec_command`\nRuns a command.\n### `web__run`\nTool for accessing the internet.',{headers:{'thread-id':'window-thread'}});
 assert.equal(window.webSearch,true);
});

test('a relative state folder still reaches Claude Code, which runs in another directory',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-rel-'));const old=process.cwd();process.chdir(parent);
 const b=await startBridge({stateDir:'state',token:'fixture-secret',port:0,claude:fixture,log:()=>{}});
 t.after(async()=>{await b.close();process.chdir(old);fs.rmSync(parent,{recursive:true,force:true});});
 const r=await fetch(b.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'rel'},body:JSON.stringify(request('hello'))});
 const said=JSON.stringify(output(await r.text())??null);
 assert.match(said,/FINAL/);
});
