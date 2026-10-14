#!/usr/bin/env node
// Live checks with real Claude Code through this bridge, run in-process on a
// random port with a temporary state folder. Each scenario sends a few short,
// low-effort requests and uses your normal claude login (or ANTHROPIC_API_KEY
// with CLAUDE_BRIDGE_AUTH=api_key).
//   node e2e/live.mjs [models|tools|steer|image|switch|stop|compact|midturn|time|resample|visualize|toolwait ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deflateSync, crc32} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {startBridge, evictIdleSessions} from '../src/server.mjs';

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
