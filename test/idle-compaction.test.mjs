import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge,idleCompactions,idleSettings,IDLE_COMPACTION} from '../src/server.mjs';
import {idleEligible} from '../src/session.mjs';
import {openCheckpoint} from '../src/protocol.mjs';
const MODEL='claude-opus';
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const request=(text,id='user1')=>({model:MODEL,stream:true,tools,instructions:'fixture',reasoning:{effort:'high'},input:[user(text,id)]});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;
const texts=out=>out.filter(x=>x.type==='message').map(x=>({phase:x.phase,text:x.content[0].text}));
// The probe's prompt excerpt can carry escaped quotes.
const args=out=>{const raw=/ARGS (\{.*\})/.exec(texts(out).map(x=>x.text).join(''))[1];try{return JSON.parse(raw);}catch{return JSON.parse(raw.replaceAll('\\"','"'));}};
const MINUTE=60000;
async function waitUntil(predicate) {
 for(let i=0;i<400&&!predicate();i++)await new Promise(r=>setTimeout(r,10));
 assert.ok(predicate(),'condition not reached');
}
// The fixture's turns use 15 tokens of context, so the threshold is lowered.
async function setup(t,options={}) {
 const dir=options.stateDir??fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-idle-'));const logs=[];
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,log:(event,data)=>logs.push({event,...data}),idleCompaction:{minTokens:10},...options});
 t.after(async()=>{await b.close();if(!options.stateDir)fs.rmSync(dir,{recursive:true,force:true});});
 const post=(body,headers={})=>fetch(b.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':'fixture',...headers},body:JSON.stringify(body)});
 const turn=async(body,headers)=>{const out=output(await(await post(body,headers)).text());await waitUntil(()=>[...b.sessions.values()].every(s=>!s.child));return out;};
 const compactions=()=>fs.existsSync(path.join(dir,'fake-compactions'))?fs.readFileSync(path.join(dir,'fake-compactions'),'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
 return {b,dir,logs,post,turn,compactions};
}
// Runs the idle timer just past 54 minutes after a thread's last request.
async function fire(b,{thread='fixture',after=54*MINUTE+1}={}) {
 const [key,candidate]=[...b.idle.candidates].find(([,c])=>c.thread===thread)??[];
 assert.ok(candidate,'no idle candidate for '+thread);
 await idleCompactions(b,candidate.cacheAt+after);await Promise.all([...b.idle.jobs]);
 return b.sessions.get(key);
}
const claudeIdOf=(b,thread='fixture')=>[...b.sessions.values()].find(s=>s.record.thread===thread&&s.record.kind==='turn').record.claudeId;
test('the defaults are Claude Code\'s: 200K tokens, 54 minutes of a one-hour cache',()=>{
 assert.equal(IDLE_COMPACTION.minTokens,200000);assert.equal(IDLE_COMPACTION.afterMs,0.9*60*MINUTE);
 const r={kind:'turn',started:true,inflight:false,cacheAt:1,contextTokens:200000};
 assert.equal(idleEligible(r,200000),true);
 for(const change of [{contextTokens:199999},{kind:'compaction'},{subagent:true},{structured:true},{inflight:true},{stop:{reason:'x'}},{started:false},{cacheAt:null}])
  assert.equal(idleEligible({...r,...change},200000),false,JSON.stringify(change));
 assert.equal(idleEligible(r,0),false);
});
test('settings.json turns idle compaction off or moves its threshold, to no less than 100K',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-idle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'settings.json');
 assert.deepEqual(idleSettings(file),{});
 for(const [settings,expected] of [[{idleCompaction:false},{minTokens:0}],[{idleCompactMinTokens:300000},{minTokens:300000}],[{idleCompactMinTokens:5000},{minTokens:100000}],[{idleCompaction:true},{}],[null,{}],['{not json',{}]]) {
  fs.writeFileSync(file,typeof settings==='string'?settings:JSON.stringify(settings));
  assert.deepEqual(idleSettings(file),expected,JSON.stringify(settings));
 }
});
test('an idle turn is compacted on a fork with its own settings, and a cold next turn starts from the summary',async t=>{
 const {b,logs,turn,compactions}=await setup(t);const first=request('args-probe first');
 const one=await turn(first);
 const original=claudeIdOf(b);
 const s=await fire(b);
 const [run]=compactions();
 assert.deepEqual({fork:run.fork,from:run.from,effort:run.effort,slash:run.slash,tools:run.tools},{fork:true,from:original,effort:'high',slash:true,tools:['exec']});
 // The alias runs the model the session ran, whose cache it reads.
 assert.deepEqual({requested:run.requested,model:run.model,pin:run.pin},{requested:'opus',model:'claude-opus-5-5',pin:'claude-opus-5-5'});
 assert.match(run.prompt,/^fixture/);
 assert.deepEqual({claudeId:s.record.idle.claudeId,before:s.record.idle.before,after:s.record.idle.after},{claudeId:run.session_id,before:381000,after:12000});
 assert.equal(s.record.claudeId,original);assert.ok(logs.some(x=>x.event==='idle_compacted'&&x.before===381000&&x.after===12000));
 // The cache the compaction read has now expired.
 s.record.idle.at-=60*MINUTE+1;
 const two=await turn({...first,input:[...first.input,...one,user('args-probe second','user2')]});
 const shown=texts(two);
 assert.deepEqual(shown[0],{phase:'commentary',text:'Compacted while idle: Claude now works from a summary of the earlier turns (381K to 12K tokens), written before the prompt cache expired.'});
 assert.equal(args(two).resume,run.session_id);assert.equal(s.record.claudeId,run.session_id);assert.equal(s.record.idle,undefined);
 assert.ok(logs.some(x=>x.event==='idle_compaction_used'&&x.before===381000));
 // Later turns stay on the compacted session.
 const three=await turn({...first,input:[...first.input,...one,user('args-probe second','user2'),...two,user('args-probe third','user3')]});
 assert.equal(args(three).resume,run.session_id);
 assert.equal(logs.some(x=>['error','history_branch_rebuilt','regeneration_rebuilt','interrupted_turn_recovery'].includes(x.event)),false);
});
test('while the cache is still warm, the next turn resumes the full conversation and the summary is dropped',async t=>{
 const {b,logs,turn}=await setup(t);const first=request('args-probe first');
 const one=await turn(first);const original=claudeIdOf(b);
 const s=await fire(b);assert.ok(s.record.idle);
 const two=await turn({...first,input:[...first.input,...one,user('args-probe second','user2')]});
 assert.equal(args(two).resume,original);assert.equal(texts(two).length,1);
 assert.ok(logs.some(x=>x.event==='idle_compaction_discarded'&&x.reason==='cache_warm'));assert.equal(s.record.idle,undefined);
});
test('a new message during an idle compaction stops it and resumes the full conversation',async t=>{
 const {b,dir,logs,turn,compactions}=await setup(t);const first=request('args-probe first');
 const one=await turn(first);const original=claudeIdOf(b);
 fs.writeFileSync(path.join(dir,'fake-compact-wait'),'5000');
 const [key,candidate]=[...b.idle.candidates][0];const s=b.sessions.get(key);
 await idleCompactions(b,candidate.cacheAt+54*MINUTE+1);
 await waitUntil(()=>compactions().length===1);
 const two=await turn({...first,input:[...first.input,...one,user('args-probe second','user2')]});
 assert.equal(args(two).resume,original);
 assert.ok(logs.some(x=>x.event==='idle_compaction_cancelled'&&x.reason==='new_request'));
 assert.ok(logs.some(x=>x.event==='idle_compaction_failed'&&x.message==='cancelled'));
 assert.equal(s.record.idle,undefined);assert.equal(b.idle.jobs.size,0);
});
test('a failed compaction leaves the session as it was',async t=>{
 const {b,dir,logs,turn}=await setup(t);const first=request('args-probe first');
 const one=await turn(first);const original=claudeIdOf(b);
 fs.writeFileSync(path.join(dir,'fake-compact-fail'),'');
 const s=await fire(b);
 assert.ok(logs.some(x=>x.event==='idle_compaction_failed'&&/fixture compaction failure/.test(x.message)));assert.equal(s.record.idle,undefined);
 const two=await turn({...first,input:[...first.input,...one,user('args-probe second','user2')]});
 assert.equal(args(two).resume,original);
});
test('a compaction that Claude Code starts on another model is not kept',async t=>{
 const {b,logs,turn}=await setup(t);const first=request('args-probe first');
 const one=await turn(first);const original=claudeIdOf(b);
 const previous=process.env.FAKE_CLAUDE_MODEL;process.env.FAKE_CLAUDE_MODEL='claude-opus-4-8';
 t.after(()=>{if(previous===undefined)delete process.env.FAKE_CLAUDE_MODEL;else process.env.FAKE_CLAUDE_MODEL=previous;});
 const s=await fire(b);
 if(previous===undefined)delete process.env.FAKE_CLAUDE_MODEL;else process.env.FAKE_CLAUDE_MODEL=previous;
 assert.ok(logs.some(x=>x.event==='idle_compaction_failed'&&/claude-opus-4-8/.test(x.message)));assert.equal(s.record.idle,undefined);
 const two=await turn({...first,input:[...first.input,...one,user('args-probe second','user2')]});
 assert.equal(args(two).resume,original);
});
test('a compaction that ends after the session changed is not kept',async t=>{
 const {b,dir,logs,turn,compactions}=await setup(t);
 await turn(request('hello'));
 fs.writeFileSync(path.join(dir,'fake-compact-wait'),'300');
 const [key,candidate]=[...b.idle.candidates][0];const s=b.sessions.get(key);
 await idleCompactions(b,candidate.cacheAt+54*MINUTE+1);
 await waitUntil(()=>compactions().length===1);
 // As if another turn had finished meanwhile.
 s.record.cacheAt+=1;
 await Promise.all([...b.idle.jobs]);
 assert.equal(s.record.idle,undefined);assert.ok(logs.some(x=>x.event==='idle_compaction_skipped'&&x.reason==='session_changed'));
});
test('a desktop compaction during an idle compaction stops it and forks the full conversation',async t=>{
 const {b,dir,logs,turn,post,compactions}=await setup(t);const first=request('hello');
 const one=await turn(first);const original=claudeIdOf(b);
 fs.writeFileSync(path.join(dir,'fake-compact-wait'),'5000');
 const [,candidate]=[...b.idle.candidates][0];
 await idleCompactions(b,candidate.cacheAt+54*MINUTE+1);await waitUntil(()=>compactions().length===1);
 const response=await post({...first,input:[...first.input,...one,user('next question','user2')]},{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction'})});
 const report=JSON.parse(output(await response.text())[0].content[0].text.replace(/^FORK /,''));
 assert.equal(report.resume,original);assert.ok(logs.some(x=>x.event==='idle_compaction_cancelled'&&x.reason==='desktop_compaction'));
});
test('a tool call during an idle compaction is refused without an error',async t=>{
 const {b,dir,logs,turn}=await setup(t);
 await turn(request('hello'));
 fs.writeFileSync(path.join(dir,'fake-compact-tool'),'');
 const s=await fire(b);
 assert.match(fs.readFileSync(path.join(dir,'fake-compact-tool'),'utf8'),/Not run: the host is compacting this conversation/);
 assert.ok(s.record.idle);assert.equal(logs.some(x=>x.event==='error'),false);
});
test('subagent threads, small turns, late timers and threads that moved on are not compacted',async t=>{
 const {b,logs,turn,compactions}=await setup(t);
 await turn(request('hello'),{'x-openai-subagent':'collab_spawn','thread-id':'child'});
 assert.equal(b.idle.candidates.size,0);assert.equal([...b.sessions.values()][0].record.subagent,true);
 assert.ok(logs.some(x=>x.event==='request'&&x.subagent===true));
 await turn(request('hello'),{'thread-id':'late'});
 await fire(b,{thread:'late',after:57*MINUTE});assert.ok(logs.some(x=>x.event==='idle_compaction_skipped'&&x.reason==='lapsed'));
 // The desktop moved the thread to a new context window.
 await turn(request('hello'),{'thread-id':'moved'});
 await turn(request('hello again','u2'),{'thread-id':'moved','x-codex-turn-metadata':JSON.stringify({context_window_id:'second'})});
 await fire(b,{thread:'moved'});
 assert.ok(logs.some(x=>x.event==='idle_compaction_skipped'&&x.reason==='thread_moved_on'));
 assert.equal(compactions().length,0);
 const {b:big,logs:quiet,turn:bigTurn}=await setup(t,{idleCompaction:{}});
 await bigTurn(request('hello'));assert.equal(big.idle.candidates.size,0);
 const {b:off,turn:offTurn}=await setup(t,{idleCompaction:{minTokens:0}});
 await offTurn(request('hello'));assert.equal(off.idle.candidates.size,0);
 await idleCompactions(off,Date.now()+54*MINUTE);assert.equal(quiet.some(x=>x.event.startsWith('idle_')),false);
});
test('turns keep slash commands off, and a compaction Claude Code refuses changes nothing',async t=>{
 const {b,dir,logs,turn}=await setup(t);const first=request('args-probe first');
 const one=await turn(first);assert.equal(args(one).slashCommands,false);const original=claudeIdOf(b);
 fs.writeFileSync(path.join(dir,'fake-compact-refuse'),'');
 const s=await fire(b);
 assert.ok(logs.some(x=>x.event==='idle_compaction_failed'&&/isn't available/.test(x.message)));assert.equal(s.record.idle,undefined);
 const two=await turn({...first,input:[...first.input,...one,user('args-probe second','user2')]});
 assert.equal(args(two).resume,original);assert.equal(args(two).slashCommands,false);
});
test('idle candidates survive a restart unless the thread moved on',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-idle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const first=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,idleCompaction:{minTokens:10}});
 const post=(thread,body,headers={})=>fetch(first.url+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-secret','Content-Type':'application/json','thread-id':thread,...headers},body:JSON.stringify(body)}).then(r=>r.text());
 await post('stays',request('hello'));await post('moved',request('hello'));
 await post('moved',request('hello again','u2'),{'x-codex-turn-metadata':JSON.stringify({context_window_id:'second'})});
 await waitUntil(()=>[...first.sessions.values()].every(s=>!s.child));
 await first.close();
 const {b,logs}=await setup(t,{stateDir:dir});
 const restored=[...b.idle.candidates.values()];
 assert.deepEqual(restored.map(c=>c.thread).sort(),['moved','stays']);
 await idleCompactions(b,Math.max(...restored.map(c=>c.cacheAt))+54*MINUTE+1);await Promise.all([...b.idle.jobs]);
 assert.equal(logs.filter(x=>x.event==='idle_compacted').length,2);
});
test('a desktop compaction after the cache expired forks the idle summary',async t=>{
 const {b,dir,logs,turn,post}=await setup(t);const first=request('hello');
 const one=await turn(first);
 const s=await fire(b);const summary=s.record.idle.claudeId;
 // The record on disk is what a compaction reads; both it and the summary are now past the cache lifetime.
 const file=path.join(dir,`${s.id}.json`);const record=JSON.parse(fs.readFileSync(file,'utf8'));
 record.idle.at-=60*MINUTE+1;fs.writeFileSync(file,JSON.stringify(record));
 const stale=new Date(Date.now()-61*MINUTE);fs.utimesSync(file,stale,stale);
 const response=await post({...first,input:[...first.input,...one,user('next question','user2')]},{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction'})});
 const out=output(await response.text());const report=JSON.parse(out[0].content[0].text.replace(/^FORK /,''));
 assert.equal(openCheckpoint(out[1].encrypted_content,'fixture-secret'),out[0].content[0].text);
 assert.equal(report.resume,summary);assert.equal(report.caching,'off');
 assert.ok(logs.some(x=>x.event==='compaction_fork'&&x.idle_summary===true&&x.cold===true));
});
