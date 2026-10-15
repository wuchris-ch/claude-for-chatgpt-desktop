// Request shapes captured from the ChatGPT app's runtime (codex
// 0.162.0-alpha.17.2) driven through the bridge, replayed against the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from '../src/server.mjs';
import {systemPrompt} from '../src/protocol.mjs';
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const request=(text,id='u1')=>({model:'claude-opus',stream:true,tools,instructions:'fixture',input:[user(text,id)]});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;
async function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-shapes-'));const logs=[];
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data})});
 t.after(async()=>{await b.close();fs.rmSync(dir,{recursive:true,force:true});});
 const post=body=>fetch(b.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'shapes'},body:JSON.stringify(body)}).then(r=>r.text());
 return {logs,post};
}

test('a new turn after a Stop during a host tool resumes as a stopped turn, not a mid-turn message',async t=>{
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await post(first))[0];
 // What the runtime sends after turn/interrupt during exec, then a new message.
 const aborted={type:'custom_tool_call_output',id:'ctco_1',call_id:call.call_id,output:'aborted by user after 0.8s'};
 const note={type:'message',id:'msg_dev',role:'developer',content:[{type:'input_text',text:'<turn_aborted>\nThe previous turn was interrupted on purpose.\n</turn_aborted>'}]};
 const text=JSON.stringify(output(await post({...first,input:[...first.input,call,aborted,note,user('what changed?','u2')]})));
 assert.match(text,/RESUMED/);assert.match(text,/turn_stopped/);assert.match(text,/aborted by user/);assert.match(text,/what changed\?/);assert.match(text,/current_time/);
 assert.doesNotMatch(text,/while you were working/);
 assert.equal(logs.some(x=>x.event==='history_import'),false);
});
test('a tool cycle keeps its system prompt when Claude Code reports a newer version of the alias',async t=>{
 const previous=process.env.FAKE_CLAUDE_MODEL;process.env.FAKE_CLAUDE_MODEL='claude-opus-5-6';
 t.after(()=>{if(previous===undefined)delete process.env.FAKE_CLAUDE_MODEL;else process.env.FAKE_CLAUDE_MODEL=previous;});
 const {post,logs}=await setup(t);const first=request('invoke-tool');
 const call=output(await post(first))[0];
 const final=JSON.stringify(output(await post({...first,input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:'42'}]})));
 assert.match(final,/RESULT/);
 assert.equal(logs.some(x=>x.event==='instructions_changed'),false);
 assert.equal(logs.filter(x=>x.event==='claude_start').length,1);
});
test('a thread that started on GPT gives Claude its own identity, not the Codex one',()=>{
 // A picker thread started on GPT keeps GPT's base prompt as its leading developer message.
 const base='You are Codex, an agent based on GPT-6. You and the user share one workspace, and your job is to collaborate with them until their intended goal is completely handled.\n\n# Personality\n\nAs Codex, you are pragmatic.';
 const prompt=systemPrompt({input:[{type:'message',role:'developer',content:[{type:'input_text',text:base}]},{type:'message',role:'user',content:'hi'}]},{name:'Claude Opus 5.5'});
 assert.match(prompt,/^You are Claude Opus 5\.5, running as the main assistant in ChatGPT Desktop\. You and the user share one workspace/);
 assert.doesNotMatch(prompt,/Codex|GPT-6/);
 // A Claude catalog prompt is left as it is.
 const own='You are Claude Opus 5.5, running as the main assistant in ChatGPT Desktop. Rules.';
 assert.ok(systemPrompt({input:[{type:'message',role:'developer',content:own},{type:'message',role:'user',content:'hi'}]},{name:'Claude Opus 5.5'}).startsWith(own));
});
