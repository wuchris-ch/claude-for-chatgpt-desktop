#!/usr/bin/env node
// Live checks with real Claude Code through this bridge, run in-process on a
// random port with a temporary state folder. Each scenario sends a few short,
// low-effort requests and uses your normal claude login (or ANTHROPIC_API_KEY
// with CLAUDE_BRIDGE_AUTH=api_key).
//   node e2e/live.mjs [models|tools|steer|narration|image|switch|stop|compact|midturn|time|resample|visualize|toolwait|resume|idle|answer ...]
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {deflateSync, crc32} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {startBridge, evictIdleSessions, idleCompactions, findClaude} from '../src/server.mjs';

const wanted=process.argv.slice(2);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-live-'));const logs=[];
const auth=process.env.CLAUDE_BRIDGE_AUTH==='api_key'?{mode:'api_key',apiKey:()=>process.env.ANTHROPIC_API_KEY}:{mode:'claude_login'};
const bridge=await startBridge({stateDir:dir,token:'live-secret',port:0,auth,log:(event,data)=>logs.push({event,...data})});
const post=(thread,body,extra={})=>fetch(bridge.url+'/v1/responses',{method:'POST',signal:extra.signal,body:JSON.stringify(body),
  headers:{Authorization:'Bearer live-secret','Content-Type':'application/json','thread-id':thread,...extra.headers}});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
async function done(response) {
  const all=events(await response.text());const completed=all.findLast(x=>x.type==='response.completed');
  if(!completed)throw new Error(all.find(x=>x.type==='response.failed')?.response.error.message??'The bridge returned no completed response.');
  return completed.response;
}
const say=output=>output.filter(x=>x.type==='message').map(x=>x.content.map(c=>c.text).join('')).join(' ').replace(/\s+/g,' ').trim();
const user=(text,id,image)=>({type:'message',id,role:'user',content:[{type:'input_text',text},...(image?[{type:'input_image',image_url:image}]:[])]});
const runJob=[{type:'function',name:'run_job',description:'Runs a named job on the host and returns its output.',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']}}];
const base=(model,tools=[])=>({model,stream:true,tools,instructions:'You are a test agent. Keep answers short.',reasoning:{effort:'low'}});
const settle=async()=>{for(let i=0;i<400&&[...bridge.sessions.values()].some(s=>s.child);i++)await new Promise(r=>setTimeout(r,50));};
const cache=r=>`${r.usage?.input_tokens_details?.cached_tokens??0} of ${r.usage?.input_tokens??0} input tokens from cache`;
const results=[];
const check=(name,ok,detail)=>{results.push({name,ok});console.log(`${ok?'PASS':'FAIL'} ${name}: ${detail}`);};

// A solid-color 16x16 PNG as a data URL.
function png(r,g,b) {
  const size=16,row=size*3+1,raw=Buffer.alloc(row*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)raw.set([r,g,b],y*row+1+x*3);
  const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]);const out=Buffer.alloc(4+body.length+4);out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body),4+body.length);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}

// A pass-through proxy to api.anthropic.com that answers the next `fail` model
// requests with an error status, so a live turn can end with an API error. It
// never logs or stores headers.
async function apiErrorProxy() {
  const state={fail:0,status:529};
  const server=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=Buffer.concat(chunks);
    if(state.fail>0&&req.method==='POST'&&/^\/v1\/messages(\?|$)/.test(req.url)) {
      state.fail--;res.writeHead(state.status,{'content-type':'application/json','x-should-retry':'false'});
      res.end(JSON.stringify({type:'error',error:{type:state.status===529?'overloaded_error':'rate_limit_error',message:state.status===529?'Overloaded':'Rate limited'}}));return;
    }
    const {'transfer-encoding':_,...headers}=req.headers;
    const up=https.request({host:'api.anthropic.com',port:443,method:req.method,path:req.url,headers:{...headers,host:'api.anthropic.com','content-length':body.length}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    up.on('error',e=>{res.writeHead(502);res.end(e.message);});up.end(body);
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {state,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);})};
}
// Claude Code's own transcripts, for the resume scenario's check that each
// message is on the active branch exactly as often as the desktop shows it.
const claudeProjects=()=>path.join(process.env.CLAUDE_CONFIG_DIR??path.join(os.homedir(),'.claude'),'projects');
function activeChain(claudeId) {
  const root=claudeProjects();
  const file=fs.readdirSync(root).map(d=>path.join(root,d,claudeId+'.jsonl')).find(f=>fs.existsSync(f));
  if(!file)return [];
  const records=fs.readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.uuid);
  const byId=new Map(records.map(r=>[r.uuid,r]));const out=[];
  for(let r=records.findLast(r=>['user','assistant','attachment'].includes(r.type));r;r=byId.get(r.parentUuid))out.unshift(r);
  return out;
}
const recordText=r=>{const c=r.type==='attachment'?r.attachment?.prompt:r.message?.content;return typeof c==='string'?c:(c??[]).map(b=>b.text??(b.type==='tool_result'?JSON.stringify(b.content):'')).join(' ');};
// How often the user side of the active branch carries each text.
function onBranch(claudeId,texts) {
  const userSide=activeChain(claudeId).filter(r=>r.type==='user'||r.type==='attachment'&&r.attachment?.type==='queued_command');
  return Object.fromEntries(texts.map(t=>[t,userSide.filter(r=>recordText(r).includes(t)).length]));
}

const scenarios={
  async models() {
    for(const m of bridge.models.list) {
      const n=logs.length;
      const r=await done(await post('live-models-'+m.slug,{...base(m.slug),input:[user('Reply with the single word READY.','u1')]}));
      const start=logs.slice(n).find(x=>x.event==='claude_start'),end=logs.slice(n).find(x=>x.event==='turn_complete');
      check('model '+m.slug,/READY/i.test(say(r.output))&&!!end,`"${say(r.output)}" from ${end?.model} (context ${end?.context_window}, effort flag ${start?.effort??'none'})`);
    }
  },
  async tools() {
    const first={...base('claude-opus',runJob),input:[user('Call run_job with name "build" exactly once, then report its output in one line.','u1')]};
    const a=await done(await post('live-tools',first));const call=a.output.find(x=>x.type==='function_call');
    if(!call)return check('tool call',false,'no tool call: '+say(a.output));
    const b=await done(await post('live-tools',{...first,input:[...first.input,...a.output,{type:'function_call_output',call_id:call.call_id,output:'build ok: 42 files'}]}));
    check('tool call',/42/.test(say(b.output)),`${call.name}(${call.arguments}), then "${say(b.output)}"; ${cache(b)}`);
  },
  async steer() {
    const first={...base('claude-opus',runJob),input:[user('Run the jobs "build", "test" and "deploy" with run_job, strictly one call at a time, waiting for each result. Then report the outputs in one line.','u1')]};
    const a=await done(await post('live-steer',first));const call=a.output.find(x=>x.type==='function_call');
    if(!call)return check('mid-turn message',false,'no tool call: '+say(a.output));
    const b=await done(await post('live-steer',{...first,input:[...first.input,...a.output,{type:'function_call_output',call_id:call.call_id,output:'build ok'},user('btw skip deploy, the server is down','u2')]}));
    const i=b.output.findIndex(x=>x.type==='function_call'),j=b.output.findIndex(x=>x.type==='message');
    check('mid-turn message',j>=0&&(i<0||j<i)&&logs.some(x=>x.event==='user_steering'),`visible reply "${say(b.output)}" before ${i<0?'the end':'the next call '+b.output[i].arguments}`);
    // A question it can already answer is answered now, not promised for the end.
    const q=await done(await post('live-steer-question',{...first,input:[...first.input,...a.output,{type:'function_call_output',call_id:call.call_id,output:'build ok'},user('quick question while you work, answer now: in two or three sentences, what is a race condition and how do you usually prevent one?','u2')]}));
    const k=q.output.findIndex(x=>x.type==='function_call');
    const said=q.output.slice(0,k<0?q.output.length:k).filter(x=>x.type==='message').map(x=>x.content.map(c=>c.text).join('')).join('\n');
    check('mid-turn question answered before the next call',/race/i.test(said)&&/(lock|mutex|atomic|synchroni|order|shared|same time|concurren)/i.test(said)&&said.length>=150,`${said.length} chars: "${said.slice(0,160)}"`);
  },
  async narration() {
    // At high effort Claude often writes its progress in its thinking, which
    // the API returns only as a summary tagged narration; it is shown as
    // commentary, the answer stays last, and the next message resumes.
    const jobs={build:'build ok: 412 files, 3 warnings (unused import in auth.ts)',lint:'lint failed: 2 errors in auth.ts (no-unused-vars)',test:'test: 118 passed, 1 failed (session expiry after 30 minutes)',bench:'bench: p95 latency 212 ms, up from 140 ms last week'};
    const first={...base('claude-opus',runJob),instructions:'You are a careful engineer working through a checklist.',reasoning:{effort:'xhigh'}};
    let input=[user('Run the jobs "build", "lint", "test" and "bench" with run_job, one call at a time, waiting for each result. Between calls, tell me what each result means and what it suggests. Then summarize.','u1')];
    const from=logs.length,phases=[];
    for(let step=0;step<8;step++){
      const r=await done(await post('live-narration',{...first,input}));input=[...input,...r.output];
      phases.push(...r.output.filter(x=>x.type==='message').map(x=>x.phase));
      const call=r.output.find(x=>x.type==='function_call');if(!call)break;
      input.push({type:'function_call_output',call_id:call.call_id,output:jobs[JSON.parse(call.arguments).name]??'unknown job'});
    }
    const shown=logs.slice(from).filter(x=>x.event==='narration_shown').length;
    check('narration',shown>0&&phases.at(-1)==='final_answer'&&phases.filter(x=>x==='final_answer').length===1,`${shown} summaries shown among ${phases.filter(x=>x==='commentary').length} commentary items`);
    await settle();
    const next=await done(await post('live-narration',{...first,input:[...input,user('Which result worries you most, in one sentence?','u2')]}));
    check('after narration, the next message resumes',!!say(next.output)&&!logs.slice(from).some(x=>['history_import','history_branch_rebuilt','regeneration_rebuilt','error','request_error'].includes(x.event)),`"${say(next.output).slice(0,100)}"`);
  },
  async image() {
    const r=await done(await post('live-image',{...base('claude-haiku'),input:[user('What single color fills this image? One word.','u1',png(220,30,30))]}));
    check('image on claude-haiku',/red/i.test(say(r.output)),`"${say(r.output)}"`);
  },
  async switch() {
    const first={...base('claude-opus'),input:[user('Remember the code word HERON. Reply OK.','u1')]};
    const a=await done(await post('live-switch',first));await settle();const n=logs.length;
    const r=await done(await post('live-switch',{...base('claude-sonnet'),input:[...first.input,...a.output,user('What was the code word? One word.','u2')]}));
    const later=logs.slice(n),start=later.find(x=>x.event==='claude_start');
    check('switch opus to sonnet',/HERON/i.test(say(r.output))&&start?.resume===true&&later.some(x=>x.event==='model_switched'),`"${say(r.output)}" from ${later.find(x=>x.event==='turn_complete')?.model}, native session resumed: ${start?.resume}`);
  },
  async stop() {
    const first={...base('claude-opus'),input:[user('Write a 200-word story about a lighthouse keeper named Ada.','u1')]};
    const abort=new AbortController();const reader=(await post('live-stop',first,{signal:abort.signal})).body.getReader();let got='';
    try{while(!got.includes('output_text.delta')){const {value,done:end}=await reader.read();if(end)break;got+=new TextDecoder().decode(value);}}catch{}
    abort.abort();await settle();const n=logs.length;
    const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted the previous turn.</turn_aborted>'}]};
    const r=await done(await post('live-stop',{...first,input:[...first.input,note,user('In one line: what is the keeper called in the story you started?','u2')]}));
    check('stop then continue',/Ada/.test(say(r.output))&&logs.slice(n).some(x=>x.event==='stopped_turn_resumed'),`"${say(r.output)}"; ${cache(r)}`);
  },
  async compact() {
    // The desktop always sends its tools; the fork reuses the session's tool list.
    const first={...base('claude-sonnet',runJob),input:[user('The deploy code word is amber pine 742 and the staging host is stg-14. Reply OK.','u1')]};
    const a=await done(await post('live-compact',first));await settle();
    const r=await done(await post('live-compact',{...first,input:[...first.input,...a.output,user('Summarize for a handoff.','u2')]},{headers:{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction'})}}));
    const summary=say(r.output);const fork=logs.some(x=>x.event==='compaction_fork');const imported=logs.find(x=>x.event==='compaction_import');
    check('compaction',/amber pine 742/.test(summary)&&/stg-14/.test(summary)&&fork&&r.output.some(x=>x.type==='compaction'),`${summary.length}-character checkpoint, ${fork?'forked from the live session':'imported ('+imported?.reason+')'}; ${cache(r)}`);
  },
  async midturn() {
    // The desktop's automatic compaction fires inside a turn, after the host ran the tool call.
    const first={...base('claude-sonnet',runJob),input:[user('The staging host is stg-14. Call run_job with name "nightly" exactly once, then report its build id in one line.','u1')]};
    const a=await done(await post('live-midturn',first));const call=a.output.find(x=>x.type==='function_call');
    if(!call)return check('mid-turn compaction',false,'no tool call: '+say(a.output));
    const ran={type:'function_call_output',call_id:call.call_id,output:'nightly finished: 3 migrations applied, build id B-5521'};
    const n=logs.length;
    const r=await done(await post('live-midturn',{...first,input:[...first.input,...a.output,ran,user('Summarize for a handoff.','u2')]},{headers:{'x-codex-turn-metadata':JSON.stringify({request_kind:'compaction'})}}));
    const summary=say(r.output);const fork=logs.slice(n).find(x=>x.event==='compaction_fork');
    const blames=/\b(the )?user (has |had )?(rejected|interrupted|stopped|declined|cancell?ed|denied)|(rejected|interrupted|stopped) by the user|user'?s? (rejection|interruption)/i.test(summary);
    check('mid-turn compaction',/B-5521/.test(summary)&&!blames&&fork?.stopped==='compacted_mid_turn'&&!logs.slice(n).some(x=>x.event==='compaction_import'),`${summary.length}-character checkpoint, build id ${/B-5521/.test(summary)?'kept':'missing'}, ${fork?`forked from the stopped turn (cold: ${fork.cold})`:'imported'}${blames?', blames the user for the pause':''}; ${cache(r)}`);
  },
  async time() {
    const first={...base('claude-sonnet'),input:[user('Remember the code word HERON. Reply OK.','u1')]};
    const a=await done(await post('live-time',first));await settle();
    const b=await done(await post('live-time',{...first,input:[...first.input,...a.output,user('What is my local time now, to the minute? Reply with only the time.','u2')]}));
    const now=new Date(),said=say(b.output),m=/(\d{1,2}):(\d\d)/.exec(said);
    const off=m?Math.abs((Number(m[1])%12)*60+Number(m[2])-((now.getHours()%12)*60+now.getMinutes())):null;
    check('time of day',off!==null&&Math.min(off,720-off)<=2&&!/\d:\d\d/.test(say(a.output)),`"${said}" at ${now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}; the first reply "${say(a.output)}" did not announce it`);
  },
  async resample() {
    // A message sent while a response streams: the desktop cancels the response
    // and sends the request again with the message appended.
    const first={...base('claude-opus',runJob),reasoning:{effort:'high'},input:[user('Release check, one job at a time: call run_job for "build", then for "test", then for "deploy-staging". Then report the build id in one line.','u1')]};
    const a=await done(await post('live-resample',first));const call=a.output.find(x=>x.type==='function_call');
    if(!call)return check('mid-response message',false,'no tool call: '+say(a.output));
    let input=[...first.input,...a.output,{type:'function_call_output',call_id:call.call_id,output:'build passed: build id B-7731'}];
    const abort=new AbortController();const n=logs.length;
    const response=await post('live-resample',{...first,input},{signal:abort.signal});
    const reading=(async()=>{try{const reader=response.body.getReader();while(!(await reader.read()).done);}catch{}})();
    await new Promise(r=>setTimeout(r,1200));abort.abort();await reading;await settle();
    input=[...input,user('quick q, is running the tests before deploying actually needed here, and does it cost me anything?','u2')];
    const b=await done(await post('live-resample',{...first,input}));
    const resumed=logs.slice(n).find(x=>x.event==='stopped_turn_resumed'),next=b.output.find(x=>x.type==='function_call');
    check('mid-response message',!!next&&(!resumed||resumed.steer),`${resumed?(resumed.steer?'resumed as a mid-turn message':'resumed as a stopped turn'):'the call was out before the cancel'}, then "${say(b.output).slice(0,120)}" and ${next?'run_job('+next.arguments+')':'no further call'}`);
  },
  async visualize() {
    // The desktop draws an inline visual only from a reference wrapped in
    // private-use characters, which Claude cannot write. The bridge adds them.
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-live-viz-'));const file=path.join(folder,'hello.html');
    const shell=[{type:'function',name:'exec_command',description:'Runs a shell command on the host and returns its output.',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}}];
    let input=[user(`Write a one-line HTML fragment, a div saying Hello, to ${file} with exec_command. Then end your answer with this line on its own: visualize{"path":"${file}"}`,'u1')],r;
    for(let i=0;i<4;i++) {
      r=await done(await post('live-visualize',{...base('claude-opus',shell),input}));input=[...input,...r.output];
      const calls=r.output.filter(x=>x.type==='function_call');if(!calls.length)break;
      input=[...input,...calls.map(c=>{const x=spawnSync('bash',['-c',JSON.parse(c.arguments).cmd],{encoding:'utf8',timeout:20000});return {type:'function_call_output',call_id:c.call_id,output:((x.stdout??'')+(x.stderr??'')).slice(0,2000)||'(no output)'};})];
    }
    const text=say(r.output);fs.rmSync(folder,{recursive:true,force:true});
    check('inline visualization',/\ue200visualize\ue202\{.*\}\ue201/.test(text),`reference ${text.includes('\ue200')?'with':'without'} the desktop's markers`);
  },
  async toolwait() {
    // A thread archived or left during a tool call never sends the result.
    const first={...base('claude-opus',runJob),input:[user('Call run_job for "build" once, then report the build id in one line.','u1')]};
    const a=await done(await post('live-toolwait',first));const call=a.output.find(x=>x.type==='function_call');
    if(!call)return check('abandoned tool call',false,'no tool call: '+say(a.output));
    const n=logs.length;
    await evictIdleSessions(bridge,Date.now()+bridge.toolWaitMs+1000);await settle();
    const b=await done(await post('live-toolwait',{...first,input:[...first.input,...a.output,{type:'function_call_output',call_id:call.call_id,output:'build passed: build id B-7731'}]}));
    const resumed=logs.slice(n).find(x=>x.event==='stopped_turn_resumed');
    check('abandoned tool call',logs.slice(n).some(x=>x.event==='host_tool_abandoned')&&!!resumed&&/B-7731/.test(say(b.output))&&!b.output.some(x=>x.type==='function_call'),`stopped after the wait limit; the late result ${resumed?'resumed the session':'did not resume it'}: "${say(b.output).slice(0,120)}"`);
  },
  async resume() {
    // Turns that used to rebuild the thread from the desktop transcript now
    // resume the native session: an API error the desktop retries, a Stop
    // before Claude Code reports init, and a stopped message the user replaces.
    // API errors come from a local pass-through proxy that Claude Code is
    // pointed at by a wrapper script.
    const proxy=await apiErrorProxy();const rdir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-live-resume-'));const rlogs=[];
    const claude=path.join(rdir,'claude');
    fs.writeFileSync(claude,`#!/bin/sh\nexport ANTHROPIC_BASE_URL='${proxy.url}'\nexport CLAUDE_CODE_MAX_RETRIES=0\nexec '${findClaude()}' "$@"\n`,{mode:0o700});
    const rb=await startBridge({stateDir:path.join(rdir,'state'),token:'live-secret',port:0,auth,claude,log:(event,data)=>rlogs.push({event,...data})});
    const rpost=(thread,body,extra={})=>fetch(rb.url+'/v1/responses',{method:'POST',signal:extra.signal,body:JSON.stringify(body),
      headers:{Authorization:'Bearer live-secret','Content-Type':'application/json','thread-id':thread}});
    const rsettle=async()=>{for(let i=0;i<400&&[...rb.sessions.values()].some(s=>s.child);i++)await new Promise(r=>setTimeout(r,50));};
    const claudeId=thread=>[...rb.sessions.values()].find(s=>s.key.startsWith(thread+':'))?.record.claudeId;
    const REBUILDS=['interrupted_turn_recovery','history_import','history_branch_rebuilt','regeneration_rebuilt'];
    const since=n=>rlogs.slice(n),rebuilt=n=>since(n).filter(x=>REBUILDS.includes(x.event)).map(x=>x.event);
    const aborted={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted the previous turn on purpose.</turn_aborted>'}]};
    const model=process.env.LIVE_RESUME_MODEL??'claude-haiku';
    const remember=[user('Remember the code word PELICAN-42 for later. Reply with just OK.','u1')];
    const counts=c=>Object.entries(c).map(([t,n])=>`"${t.slice(0,24)}" x${n}`).join(', ');
    try {
      {
        const thread='live-resume-api',n=rlogs.length;
        const a=await done(await rpost(thread,{...base(model),input:remember}));await rsettle();
        const ask={...base(model),input:[...remember,...a.output,user('What is the code word I gave you? Reply with just the code word.','u2')]};
        proxy.state.fail=1;proxy.state.status=529;
        const failed=events(await(await rpost(thread,ask)).text()).find(x=>x.type==='response.failed')?.response.error.message??'';await rsettle();
        // The desktop retries the same request.
        const r=await done(await rpost(thread,ask));await rsettle();
        const resumed=since(n).find(x=>x.event==='stopped_turn_resumed');const branch=onBranch(claudeId(thread),['code word I gave you']);
        check('resume after an API error',/529/.test(failed)&&/PELICAN-42/.test(say(r.output))&&resumed?.reason==='api_error'&&!rebuilt(n).length&&branch['code word I gave you']===1,
          `injected "${failed.slice(0,40)}", retry ${resumed?'resumed ('+resumed.reason+')':'did not resume'}${rebuilt(n).length?', rebuilt: '+rebuilt(n).join(' '):''}, said "${say(r.output)}"; on the native branch ${counts(branch)}`);
      }
      {
        const thread='live-resume-init',n=rlogs.length;
        const a=await done(await rpost(thread,{...base(model),input:remember}));await rsettle();
        const stopped=[...remember,...a.output,user('Write a limerick about the code word.','u2')];
        const starts=()=>rlogs.filter(x=>x.event==='claude_start').length,before=starts();
        const abort=new AbortController();const pending=rpost(thread,{...base(model),input:stopped},{signal:abort.signal}).then(r=>r.text()).catch(()=>{});
        for(let i=0;i<400&&starts()===before;i++)await new Promise(r=>setTimeout(r,5));
        abort.abort();await pending;await rsettle();
        const atInit=since(n).some(x=>x.event==='stopped_at_init');
        const r=await done(await rpost(thread,{...base(model),input:[...stopped,aborted,user('Never mind the limerick. What is the code word? Reply with just the code word.','u3')]}));await rsettle();
        const resumed=since(n).find(x=>x.event==='stopped_turn_resumed');const branch=onBranch(claudeId(thread),['limerick about the code word','Never mind the limerick']);
        check('resume after a Stop before init',atInit&&/PELICAN-42/.test(say(r.output))&&!!resumed&&!rebuilt(n).length&&Object.values(branch).every(x=>x===1),
          `${atInit?'stopped at init':'the Stop landed after init'}, next turn ${resumed?'resumed':'did not resume'}${rebuilt(n).length?', rebuilt: '+rebuilt(n).join(' '):''}, said "${say(r.output)}"; on the native branch ${counts(branch)}`);
      }
      {
        const thread='live-resume-withdrawn',n=rlogs.length;
        const a=await done(await rpost(thread,{...base(model),input:remember}));await rsettle();
        const story=user('Write a 300-word story about a lighthouse keeper named Ada.','u2');
        const abort=new AbortController();const reader=(await rpost(thread,{...base(model),input:[...remember,...a.output,story]},{signal:abort.signal})).body.getReader();let got='';
        try{while(!got.includes('output_text.delta')){const {value,done:end}=await reader.read();if(end)break;got+=new TextDecoder().decode(value);}}catch{}
        abort.abort();await rsettle();
        // The user edits the stopped message: the desktop drops it and sends the new one.
        const r=await done(await rpost(thread,{...base(model),input:[...remember,...a.output,aborted,user('What is the code word? Also say whether I asked you for any story. Reply in one line.','u3')]}));await rsettle();
        const dropped=since(n).find(x=>x.event==='withdrawn_turn_dropped');const branch=onBranch(claudeId(thread),['lighthouse keeper named Ada','What is the code word? Also say']);
        check('withdrawn message dropped from the native session',!!dropped&&/PELICAN-42/.test(say(r.output))&&!/lighthouse|\bAda\b/i.test(say(r.output))&&!rebuilt(n).length&&branch['lighthouse keeper named Ada']===0&&branch['What is the code word? Also say']===1,
          `${dropped?'dropped with --resume-session-at':'not dropped'}${rebuilt(n).length?', rebuilt: '+rebuilt(n).join(' '):''}, said "${say(r.output)}"; on the native branch ${counts(branch)}`);
      }
    } finally {
      const turns=rlogs.filter(x=>x.event==='turn_complete').length;
      const errors=rlogs.filter(x=>['error','request_error'].includes(x.event)&&!/^API Error/.test(x.message??''));
      console.log(`  resume: ${turns} completed Claude turns on ${model}, ${errors.length} unexpected bridge errors${errors.length?': '+errors.map(x=>x.message.slice(0,120)).join(' | '):''}`);
      if(errors.length)check('resume without bridge errors',false,errors.map(x=>x.message.slice(0,120)).join(' | '));
      await rb.close();await proxy.close();
      // Claude Code's project folder for this run's private working directory.
      try{for(const d of fs.readdirSync(claudeProjects()))if(d.includes(path.basename(rdir)))fs.rmSync(path.join(claudeProjects(),d),{recursive:true,force:true});}catch{}
      fs.rmSync(rdir,{recursive:true,force:true});
    }
  },
  async answer() {
    // A follow-up in an automation thread. The app's automation prompt asks
    // for a memory update before the closing inbox directive, and the app
    // folds every message before the final answer when the turn ends.
    const shell=[{type:'function',name:'shell',description:'Runs a zsh command on the host and returns its output.',parameters:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}}];
    const automation='Response MUST end with a remark-directive block.\n\n## Responding\n\n- Answer the user normally and concisely. Explain what you found, what you did, and what the user should focus on now.\n- Automations: use the memory file at `$CODEX_HOME/automations/<automation_id>/memory.md` (create it if missing).\n  - Read it first (if present) to avoid repeating recent work.\n  - Before returning the directive, write a concise summary of what you did/decided plus the current run time.\n  - Use the `Automation ID:` value provided in the message to locate/update this file.\n- REQUIRED: End with a valid remark-directive block on its own line (not inline).\n  - Always include an inbox item directive:\n    `::inbox-item{title="Sample title" summary="Place description here"}`';
    const rules='# AGENTS.md instructions for /Users/me/reports\n\n<INSTRUCTIONS>\n- For work with several parts, start with a short plan of the parts in order.\n- While you work, tell me what you find as you find it, in two to four plain sentences before your next step. The final answer still gives the full summary.\n</INSTRUCTIONS>';
    const writes=cmd=>/memory\.md/.test(cmd)&&/>|tee|printf|cat <</.test(cmd);
    const reply=cmd=>/memory\.md/.test(cmd)?'# Weekly report health check: memory\n\n## Run 2026-11-08\nFound three risks: address lookup gap, blocked by-law sites (Vaughan, Ottawa), release script second-host failure.':
      /lookup|address|gis/i.test(cmd)?'src/runner.mjs:212: if (lookup.failed && job.kind === "letter") return review(job);\nsrc/runner.mjs:213: // map reports continue without a located lot':
      /alarm|cloudwatch/i.test(cmd)?'submit-queue-oldest-message: threshold 600 s, action ops-alerts\ndead-letter-not-empty: action ops-alerts':
      /release|deploy|install/i.test(cmd)?'scripts/release.sh: installs host A, then host B; if host B fails it exits 1 and leaves host A on the new release':
      /bylaw|by-law|vaughan|ottawa/i.test(cmd)?'vaughan.ca: 403 for automated reads (14 jobs in 30 days)\nottawa.ca: 403 for automated reads (18 jobs in 30 days)':
      /^\s*(ls|find|tree)\b/.test(cmd)?'README.md\ninfra/alarms.tf\nscripts/release.sh\nsrc/lookup.mjs\nsrc/runner.mjs':
      'README.md: Report workers. Jobs come from the submit queue; each runs lookup, then the report writer. Two hosts run the workers.';
    let input=[{type:'message',role:'developer',content:[{type:'input_text',text:automation}]},user(rules,'u0'),
      user('Automation: Weekly report health check\nAutomation ID: weekly-report-check\nAutomation memory: $CODEX_HOME/automations/weekly-report-check/memory.md\nLast run: never\n\nCheck the report workers in ~/reports for anything that could send a customer a wrong or empty report.','u1'),
      {type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Three paths can go wrong: the address lookup can fail and a map report still goes out with no lot; two city by-law sites block automated reads; and the release script does not handle a failed install on the second host. Alarms already cover a stuck queue and dead letters.\n\n::inbox-item{title="Three report risks found" summary="Address lookup gap, blocked by-law sites, release script"}'}]},
      user('well anything u recommend? i dont want embarassing moments because we didnt do further engineering but also dont want to overengineer','u2')];
    const shown=[];let memory=false;
    for(let step=0;step<14;step++) {
      const r=await done(await post('live-answer',{...base('claude-opus',shell),instructions:'',reasoning:{effort:'xhigh'},input}));
      for(const x of r.output)if(x.type==='message')shown.push({phase:x.phase,text:x.content.map(c=>c.text).join('')});
      input=[...input,...r.output];
      const calls=r.output.filter(x=>x.type==='function_call');if(!calls.length)break;
      for(const call of calls){const cmd=JSON.parse(call.arguments).cmd??'';memory||=writes(cmd);input.push({type:'function_call_output',call_id:call.call_id,output:writes(cmd)?'':reply(cmd)});}
    }
    const final=shown.at(-1),longest=Math.max(0,...shown.slice(0,-1).map(x=>x.text.length));
    check('memory update in an automation follow-up',memory,`${shown.length-1} commentary messages before the answer`);
    check('the answer after the last tool call is complete',final?.phase==='final_answer'&&final.text.length>=600&&final.text.length>=longest&&/::inbox-item\{/.test(final.text),`answer ${final?.text.length} characters, longest commentary ${longest}: "${final?.text.replace(/\s+/g,' ').slice(0,100)}…"`);
  },
  async idle() {
    // A turn with a tool call over a 25K-token stock list on Opus at xhigh
    // effort, then the idle timer as it fires 54 minutes later. Claude Code
    // compacts a fork of the session from the warm cache. A cold return starts
    // from the summary and still knows the facts; a warm return resumes the
    // full conversation from the cache. A list of random word pairs was stopped
    // by the model's safety classifier, so the list is plain stock.
    const idir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-live-idle-'));const ilogs=[];
    const ib=await startBridge({stateDir:path.join(idir,'state'),token:'live-secret',port:0,auth,idleCompaction:{minTokens:1000},log:(event,data)=>ilogs.push({event,...data})});
    const ipost=(thread,body)=>fetch(ib.url+'/v1/responses',{method:'POST',body:JSON.stringify(body),headers:{Authorization:'Bearer live-secret','Content-Type':'application/json','thread-id':thread}});
    const isettle=async()=>{for(let i=0;i<400&&[...ib.sessions.values()].some(s=>s.child);i++)await new Promise(r=>setTimeout(r,50));};
    const first={...base('claude-opus',runJob),instructions:'You are a careful engineer. Keep answers short.',reasoning:{effort:'xhigh'}};
    const parts=['M3 hex bolt','M4 washer','M5 nut','6 mm dowel pin','608 bearing','M2 screw','spring pin','pop rivet','cable tie','O-ring 20 mm'];
    let seed=7;const rand=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
    const inventory=Array.from({length:900},(_,i)=>`SKU-${String(i).padStart(4,'0')}: ${parts[rand(10)]}, quantity ${100+rand(9900)}, bin ${'ABCDEFGH'[rand(8)]}${1+rand(20)}.`);
    const quantity=/quantity (\d+)/.exec(inventory[234])[1];
    const ask=`Here is the stock list for the HERON-58 assembly line. SKU-0234 matters most.\n${inventory.join('\n')}\nPlease run the job "build" with run_job, then reply in one line with its result.`;
    async function firstTurn(thread) {
      let input=[user(ask,'u1')];let r=await done(await ipost(thread,{...first,input}));
      const call=r.output.find(x=>x.type==='function_call');
      if(!call)throw new Error('no tool call: '+say(r.output));
      input=[...input,...r.output,{type:'function_call_output',call_id:call.call_id,output:'build ok: 412 files, 3 warnings'}];
      r=await done(await ipost(thread,{...first,input}));input=[...input,...r.output];
      await isettle();
      return {input,usage:r.usage};
    }
    // Only this thread's timer fires.
    async function compact(thread) {
      const [key,candidate]=[...ib.idle.candidates].find(([,c])=>c.thread===thread)??[];
      if(!candidate)throw new Error('no idle candidate for '+thread);
      for(const other of [...ib.idle.candidates.keys()])if(other!==key)ib.idle.candidates.delete(other);
      const n=ilogs.length;
      await idleCompactions(ib,candidate.cacheAt+54*60000+1);await Promise.all([...ib.idle.jobs]);
      const session=ib.sessions.get(key),mine=ilogs.slice(n).filter(x=>x.session===session.id.slice(0,12));
      return {session,log:mine.find(x=>x.event==='idle_compacted')??mine.find(x=>x.event.startsWith('idle_'))};
    }
    const notice=output=>output.filter(x=>x.type==='message').find(x=>/^Compacted while idle/.test(x.content[0].text));
    try {
      {
        const thread='live-idle-cold';const {input,usage}=await firstTurn(thread);
        const {session,log}=await compact(thread);
        check('idle compaction on a fork',log?.event==='idle_compacted'&&!!session.record.idle&&session.record.idle.claudeId!==session.record.claudeId,JSON.stringify(log));
        check('idle compaction read the conversation from the cache',log?.cache_read>=0.8*(log?.before??Infinity),`read ${log?.cache_read} of ${log?.before} tokens, wrote ${log?.cache_write}, output ${log?.output}, in ${log?.ms} ms`);
        // As if the cache had expired since.
        session.record.idle.at-=60*60000+1;
        const n=ilogs.length;
        const next=await done(await ipost(thread,{...first,input:[...input,user('What is the assembly line name, what did the build report, and what is the quantity of SKU-0234? One line.','u2')]}));
        const shown=next.output.filter(x=>x.type==='message');const answer=shown.at(-1)?.content[0].text??'';
        check('cold return starts with the notice',shown[0]?.phase==='commentary'&&notice(next.output)===shown[0],`"${shown[0]?.content[0].text}"`);
        check('cold return keeps the facts',/HERON-58/.test(answer)&&/412|ok/i.test(answer)&&answer.includes(quantity),`"${answer}"; SKU-0234 has quantity ${quantity}`);
        check('cold return reads far less context',next.usage.input_tokens<usage.input_tokens/3,`${next.usage.input_tokens} input tokens against ${usage.input_tokens} for the first turn`);
        check('cold return resumes the compacted session',ilogs.slice(n).some(x=>x.event==='idle_compaction_used')&&!ilogs.slice(n).some(x=>/history|rebuilt|error/.test(x.event)),ilogs.slice(n).map(x=>x.event).join(' '));
      }
      {
        const thread='live-idle-warm';const {input,usage}=await firstTurn(thread);
        const {session,log}=await compact(thread);const original=session.record.claudeId;
        check('warm: idle compaction read the cache',log?.event==='idle_compacted'&&log.cache_read>=0.8*log.before,`read ${log?.cache_read} of ${log?.before} tokens`);
        const n=ilogs.length;
        const next=await done(await ipost(thread,{...first,input:[...input,user('What is the assembly line name? One word.','u2')]}));
        check('warm return resumes the full conversation from the cache',!notice(next.output)&&next.usage.input_tokens_details.cached_tokens>=0.8*usage.input_tokens&&session.record.claudeId===original,`${next.usage.input_tokens_details.cached_tokens} of ${next.usage.input_tokens} input tokens from cache, "${say(next.output)}"`);
        check('warm return drops the summary',ilogs.slice(n).some(x=>x.event==='idle_compaction_discarded'&&x.reason==='cache_warm')&&session.record.idle===undefined,ilogs.slice(n).filter(x=>x.event.startsWith('idle_')).map(x=>x.event+' '+(x.reason??'')).join(', '));
      }
    } finally {
      const errors=ilogs.filter(x=>['error','request_error'].includes(x.event));
      console.log(`  idle: ${ilogs.filter(x=>x.event==='turn_complete').length} completed Claude turns on ${[...new Set(ilogs.filter(x=>x.event==='claude_ready').map(x=>x.model))].join(', ')}, ${errors.length} bridge errors`);
      if(errors.length)check('idle without bridge errors',false,errors.map(x=>x.message.slice(0,120)).join(' | '));
      await ib.close();
      // Claude Code's project folder for this run's private working directory.
      try{for(const d of fs.readdirSync(claudeProjects()))if(d.includes(path.basename(idir)))fs.rmSync(path.join(claudeProjects(),d),{recursive:true,force:true});}catch{}
      fs.rmSync(idir,{recursive:true,force:true});
    }
  },
};

try {
  for(const name of wanted.length?wanted:Object.keys(scenarios)) {
    if(!scenarios[name])throw new Error('Unknown scenario '+name+'. Choose from: '+Object.keys(scenarios).join(', '));
    try{await scenarios[name]();}catch(error){check(name,false,error.message);}
    await settle();
  }
} finally {
  const errors=logs.filter(x=>['error','request_error'].includes(x.event));
  console.log(`${results.filter(x=>x.ok).length}/${results.length} passed, ${errors.length} bridge errors${errors.length?': '+errors.map(x=>x.message).join(' | '):''}`);
  await bridge.close();fs.rmSync(dir,{recursive:true,force:true});
  process.exit(results.every(x=>x.ok)&&results.length?0:1);
}
