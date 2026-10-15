import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from '../src/server.mjs';
import {goalToolNote} from '../src/protocol.mjs';

const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
// Code mode documents the goal tools only in the exec description, as desktop 26.1007.71326 does.
const exec=(nested=['exec_command','update_goal','get_goal','create_goal'])=>({type:'custom',name:'exec',description:'Run JavaScript code to orchestrate/compose tool calls\n\n'+nested.map(n=>`### \`${n}\`\nDocs for ${n}.\n`).join('\n')});
const GOAL='<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n\n<objective>\nCreate notes.txt\n</objective>\n\nIf the objective is achieved, call update_goal with status "complete" so usage accounting is preserved.\n</codex_internal_context>';
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;

test('the goal tool note goes only with a goal continuation in code mode',()=>{
  const tools=[exec()];
  const [note,...rest]=goalToolNote([user('<environment_context/>','e1'),user(GOAL,'g1')],tools);
  assert.equal(rest.length,0);
  assert.match(note.text,/^<developer_message>update_goal, get_goal and create_goal are not top-level tools here\. Call them only from exec JavaScript, for example await tools\.update_goal\(\.\.\.\)\. A top-level call fails\.<\/developer_message>$/);
  assert.deepEqual(goalToolNote([user('Create notes.txt','u1')],tools),[]);
  // A continuation answered earlier in the thread is history, not this turn's input.
  assert.deepEqual(goalToolNote([user(GOAL,'g1'),{type:'message',role:'assistant',content:[{type:'output_text',text:'Done.'}]},user('thanks','u2')],tools),[]);
  // Without code mode the goal tools are top-level tools of their own.
  assert.deepEqual(goalToolNote([user(GOAL,'g1')],[exec(['exec_command'])]),[]);
  assert.deepEqual(goalToolNote([user(GOAL,'g1')],[{type:'function',name:'update_goal',parameters:{type:'object'}}]),[]);
  assert.match(goalToolNote([user(GOAL,'g1')],[exec(['update_goal'])])[0].text,/update_goal is not a top-level tool here\. Call it only/);
});

test('a goal continuation turn calls update_goal from exec, not as a top-level tool',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-goal-'));const logs=[];
  const bridge=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data})});
  t.after(async()=>{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});});
  const post=body=>fetch(bridge.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'goal'},body:JSON.stringify(body)});
  const first={model:'claude-haiku',stream:true,tools:[exec()],instructions:'fixture',input:[user('<environment_context/>','e1'),user(GOAL,'g1')]};
  const a=output(await(await post(first)).text());
  const call=a.find(x=>x.type==='custom_tool_call');
  assert.equal(call?.name,'exec');
  assert.match(call.input,/tools\.update_goal\(\{status:"complete"\}\)/);
  assert.deepEqual(logs.filter(x=>x.event==='unknown_tool'),[]);
  const b=output(await(await post({...first,input:[...first.input,...a,{type:'custom_tool_call_output',call_id:call.call_id,output:'{"goal":{"status":"complete"}}'}]})).text());
  assert.match(JSON.stringify(b),/GOAL .*complete/);
});
