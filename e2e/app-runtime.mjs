#!/usr/bin/env node
// The app's own runtime against this bridge's source, with real Claude Code.
// The runtime logs in with a placeholder API key, never your ChatGPT login, in
// a throwaway profile. Search and GPT go to stand-ins for OpenAI.
//   node e2e/app-runtime.mjs [window|window-no-search|picker ...]
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';import readline from 'node:readline';
import {WebSocketServer} from 'ws';
import {startBridge,providerKey} from '../src/server.mjs';
import {BRIDGE_CHECKPOINT} from '../src/gateway.mjs';

const CODEX=process.env.CODEX_BIN??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const ROOT=path.dirname(path.dirname(new URL(import.meta.url).pathname));
const SOURCE=process.env.CODEX_HOME??path.join(os.homedir(),'.codex');
const MODEL=process.env.E2E_MODEL??'claude-haiku';
const token='e2e-runtime-token';
const results=[];const check=(name,ok,detail='')=>{results.push({name,ok:!!ok});console.log(ok?'PASS':'FAIL',name,detail);};
// The Claude catalog as setup builds it, from the app's downloaded model list.
const catalog=file=>{execFileSync('python3',['-I','-c',`
import json,pathlib,sys
sys.path.insert(0,sys.argv[1]+'/scripts')
from sync_runtime import model_catalog
from bridge_config import load_models
available=json.loads((pathlib.Path(sys.argv[2])/'models_cache.json').read_text())['models']
template=next(m for m in available if m.get('tool_mode')=='code_mode_only')
pathlib.Path(sys.argv[3]).write_text(json.dumps({'models':model_catalog(template,load_models())}))`,ROOT,SOURCE,file]);};

// One app-server process with the JSON-RPC calls the checks need.
function runtime(home,cwd) {
  const server=spawn(CODEX,['app-server'],{env:{...process.env,CODEX_HOME:home,RUST_LOG:'codex_core::client=warn'},cwd,stdio:['pipe','pipe','pipe']});
  const stderr=[];server.stderr.on('data',d=>stderr.push(String(d)));
  let next=1;const pending=new Map(),notes=[],waiters=[];
  readline.createInterface({input:server.stdout}).on('line',line=>{
    let msg;try{msg=JSON.parse(line);}catch{return;}
    if(msg.id!=null&&pending.has(msg.id)){const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(new Error(JSON.stringify(msg.error))):resolve(msg.result);return;}
    if(msg.id!=null&&msg.method){server.stdin.write(JSON.stringify({id:msg.id,result:{decision:'accept'}})+'\n');return;}
    if(msg.method){notes.push(msg);for(const w of [...waiters])if(w.test(msg)){waiters.splice(waiters.indexOf(w),1);w.resolve(msg);}}
  });
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=next++;pending.set(id,{resolve,reject});server.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const wait=(test,ms=300000)=>new Promise((resolve,reject)=>{const w={test,resolve};waiters.push(w);setTimeout(()=>reject(new Error('timed out waiting')),ms).unref();});
  const text=threadId=>notes.filter(n=>n.method==='item/completed'&&n.params.threadId===threadId&&n.params.item?.type==='agentMessage').map(n=>n.params.item.text).at(-1)??'';
  async function turn(threadId,prompt,extra={}) {
    const done=wait(n=>n.method==='turn/completed'&&n.params.threadId===threadId);
    await call('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],...extra});
    const completed=await done;return {status:completed.params.turn?.status,error:completed.params.turn?.error,text:text(threadId)};
  }
  const ready=call('initialize',{clientInfo:{name:'bridge-runtime-e2e',version:'1'},capabilities:{experimentalApi:true}}).then(()=>server.stdin.write(JSON.stringify({method:'initialized'})+'\n'));
  return {server,stderr,notes,call,wait,turn,ready};
}
const stop=async r=>{if(!r||r.server.exitCode!==null)return;r.server.kill('SIGTERM');await new Promise(x=>r.server.once('exit',x));};
const login=home=>execFileSync(CODEX,['login','--with-api-key'],{env:{...process.env,CODEX_HOME:home},input:'sk-bridge-e2e-placeholder\n',stdio:['pipe','ignore','inherit']});
function folders() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-runtime-e2e-'));
  const home=path.join(dir,'codex'),work=path.join(dir,'work');
  for(const d of [home,work])fs.mkdirSync(d,{recursive:true});
  return {dir,home,work,state:path.join(dir,'state')};
}
const noProblems=(name,notes,logs)=>{
  // Turned on in the window's config, and always reported as in development.
  const problems=notes.filter(n=>n.method==='error'||/warning|deprecat/i.test(n.method)&&!/Under-development features enabled/.test(n.params?.message??''));
  check(name+': no error or warning notifications',!problems.length,JSON.stringify(problems.map(n=>[n.method,JSON.stringify(n.params).slice(0,200)])));
  const errors=logs.filter(x=>['error','request_error'].includes(x.event));
  check(name+': no bridge errors',!errors.length,JSON.stringify(errors).slice(0,300));
};

// New chats in the separate window: the app's provider, with the key in the path.
async function windowMode(search) {
  const name=search?'window':'window-no-search';
  const {dir,home,work,state}=folders();
  const searches=[];
  const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;searches.push(JSON.parse(raw));
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({encrypted_output:'fixture',output:'Result 1: "Kestrel harbor report 7731" (fixture.example)',results:[{type:'text_result',ref_id:'turn0search0',url:'https://fixture.example/kestrel'}]}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const logs=[];
  const b=await startBridge({stateDir:state,token,port:0,webSearch:search,searchUpstream:`http://127.0.0.1:${upstream.address().port}/alpha/search`,log:(event,data)=>logs.push({event,...data})});
  catalog(path.join(home,'models.json'));
  const configPath=path.join(home,'config.toml');
  const config=`model = "${MODEL}"
model_catalog_json = ${JSON.stringify(path.join(home,'models.json'))}
model_reasoning_effort = "low"
model_reasoning_summary = "none"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "${search?'live':'disabled'}"
openai_base_url = "${b.url}/k/${providerKey(token)}/v1"

[features]
standalone_web_search = ${search}
memories = false

[model_providers.claude_bridge]
name = "Claude"
base_url = "${b.url}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 600000
supports_standalone_web_search = ${search}

[model_providers.claude_bridge.http_headers]
X-Claude-Bridge-Key = "${token}"
`;
  fs.writeFileSync(configPath,config);
  login(home);
  const requests=()=>logs.filter(x=>x.event==='request');
  const first=runtime(home,work);let second=null,old=null;
  try {
    await first.ready;
    const {thread}=await first.call('thread/start',{model:MODEL,cwd:work,approvalPolicy:'never',sandbox:'workspace-write'});
    const a=await first.turn(thread.id,'Use your shell to run `echo runtime-e2e-ok-4417` and reply with exactly what it printed.');
    check(name+': shell turn on the app provider',a.status==='completed'&&a.text.includes('runtime-e2e-ok-4417'),JSON.stringify(a).slice(0,200));
    check(name+': WebSocket refused, then HTTP',logs.some(x=>x.event==='websocket_refused')&&requests().every(x=>x.app_provider),`refused ${logs.filter(x=>x.event==='websocket_refused').length}`);
    if(search) {
      const s=await first.turn(thread.id,'Search the web for "kestrel harbor report" and tell me the number in the first result title.');
      check(name+': web search through the app provider',s.status==='completed'&&searches.length>0&&s.text.includes('7731'),JSON.stringify({searches:searches.length,text:s.text.slice(0,160)}));
    }
    const compacted=first.wait(n=>n.method==='turn/completed'&&n.params.threadId===thread.id);
    await first.call('thread/compact/start',{threadId:thread.id});
    const c=await compacted;
    check(name+': remote compaction',c.params.turn?.status==='completed'&&requests().some(x=>x.request_kind==='compaction'&&x.app_provider),JSON.stringify(c.params.turn?.error??null));
    const recall='What exact text did the shell command print earlier in this conversation? Reply with only that text.';
    const after=await first.turn(thread.id,recall);
    check(name+': next window recalls from the checkpoint',after.status==='completed'&&after.text.includes('runtime-e2e-ok-4417'),after.text.slice(0,160));
    await stop(first);
    // A chat from before the window moved to the app's provider, which
    // Codex 0.166.0-alpha.6 no longer starts beside it.
    fs.writeFileSync(configPath,'model_provider = "claude_bridge"\n'+config);
    old=runtime(home,work);await old.ready;
    const legacy=await old.call('thread/start',{model:MODEL,cwd:work,approvalPolicy:'never',sandbox:'workspace-write'});
    const l=await old.turn(legacy.thread.id,'Reply with the single word legacy-provider-ok.');
    check(name+': a chat on the claude_bridge provider',l.status==='completed'&&l.text.includes('legacy-provider-ok')&&requests().at(-1).app_provider===false,l.text.slice(0,120));
    await stop(old);
    // That runtime resumes a chat only on the provider the window selects, so
    // it refuses the claude_bridge chat until the installer moves it, with the
    // runtime still running as the app would be.
    fs.writeFileSync(configPath,config);
    second=runtime(home,work);await second.ready;
    const refused=await second.call('thread/resume',{threadId:legacy.thread.id,excludeTurns:true}).then(()=>null,error=>error.message);
    check(name+': before the move, the claude_bridge chat is refused',/modelProviderMismatch/.test(refused??''),String(refused).slice(0,200));
    const moved=execFileSync('python3',['-I','-c','import sys;sys.path.insert(0,sys.argv[1]);from sync_runtime import follow_window_provider;print(follow_window_provider(sys.argv[2],sys.argv[3],int(sys.argv[4])))',
      path.join(ROOT,'scripts'),home,token,new URL(b.url).port],{encoding:'utf8'}).trim();
    check(name+': the installer moves the claude_bridge chat to the app provider',moved==='1',`moved ${moved}`);
    await second.call('thread/resume',{threadId:legacy.thread.id,excludeTurns:true});
    const r1=await second.turn(legacy.thread.id,'Reply with the single word resumed-legacy-ok.');
    check(name+': the moved chat resumes on the app provider',r1.status==='completed'&&r1.text.includes('resumed-legacy-ok')&&requests().at(-1).app_provider===true,r1.text.slice(0,120));
    await second.call('thread/resume',{threadId:thread.id,excludeTurns:true});
    const r2=await second.turn(thread.id,recall);
    check(name+': a resumed app-provider chat stays on it and keeps its checkpoint',r2.status==='completed'&&r2.text.includes('runtime-e2e-ok-4417')&&requests().at(-1).app_provider===true,r2.text.slice(0,120));
    noProblems(name,[...first.notes,...old.notes,...second.notes],logs);
  } catch(error){check(name,false,error.message);}
  finally {
    await stop(first);await stop(old);await stop(second);await b.close();upstream.closeAllConnections();upstream.close();
    console.log('requests:',JSON.stringify(requests().map(x=>[x.app_provider?'app':'bridge',x.request_kind,x.tools,x.items])));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

// Picker mode: GPT is relayed to a stand-in for OpenAI, Claude answers in the same chat.
async function pickerMode() {
  const name='picker';
  const {dir,home,work,state}=folders();
  const available=JSON.parse(fs.readFileSync(path.join(SOURCE,'models_cache.json'),'utf8')).models;
  const gptSlug=available.find(m=>m.tool_mode==='code_mode_only'&&m.visibility==='list')?.slug??available[0].slug;
  const seen={http:0,ws:0,paths:new Set(),bodies:[]};
  const frames=(id,text)=>[{type:'response.created',response:{id}},
    {type:'response.output_item.done',output_index:0,item:{type:'message',id:'msg_'+id,role:'assistant',status:'completed',content:[{type:'output_text',text}],phase:'final_answer'}},
    {type:'response.completed',response:{id,status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  const openai=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    seen.http++;seen.paths.add(req.url.split('?')[0]);
    if(req.url.includes('/models')){res.writeHead(200,{'Content-Type':'application/json',etag:'W/"e2e"'});return res.end(JSON.stringify({models:available}));}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const f of frames('resp_http','gpt-standin-ok'))res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
    res.end();
  });
  const wss=new WebSocketServer({noServer:true});
  openai.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>ws.on('message',data=>{
    const message=JSON.parse(data.toString());seen.ws++;seen.bodies.push(JSON.stringify(message));
    if(message.type!=='response.create')return;
    const quiet=message.generate===false;
    for(const f of quiet?frames('resp_warm','').filter(x=>x.type!=='response.output_item.done'):frames('resp_ws'+seen.ws,'gpt-standin-ok'))ws.send(JSON.stringify(f));
  })));
  await new Promise(r=>openai.listen(0,'127.0.0.1',r));
  const logs=[];const key='e2e-gateway-key';
  const b=await startBridge({stateDir:state,token,port:0,gatewayKey:key,gatewayUpstream:`http://127.0.0.1:${openai.address().port}/backend-api/codex`,log:(event,data)=>logs.push({event,...data})});
  // An API key login never fetches the model list, so the catalog stands in for
  // the list the app downloads through the bridge with a ChatGPT login.
  catalog(path.join(home,'claude.json'));
  const claude=JSON.parse(fs.readFileSync(path.join(home,'claude.json'),'utf8')).models;
  fs.writeFileSync(path.join(home,'models.json'),JSON.stringify({models:[...available.filter(m=>!m.slug.startsWith('claude-')),...claude]}));
  fs.writeFileSync(path.join(home,'config.toml'),`model = "${gptSlug}"
model_catalog_json = ${JSON.stringify(path.join(home,'models.json'))}
model_reasoning_effort = "low"
model_reasoning_summary = "none"
approval_policy = "never"
sandbox_mode = "workspace-write"
openai_base_url = "${b.url}/g/${key}/backend-api/codex"

[features]
memories = false
`);
  login(home);
  const requests=()=>logs.filter(x=>x.event==='request');
  const r=runtime(home,work);
  try {
    await r.ready;
    const {thread}=await r.call('thread/start',{model:MODEL,cwd:work,approvalPolicy:'never',sandbox:'workspace-write'});
    const a=await r.turn(thread.id,'Use your shell to run `echo picker-e2e-ok-5521` and reply with exactly what it printed.');
    check(name+': Claude runs a shell tool',a.status==='completed'&&a.text.includes('picker-e2e-ok-5521')&&requests().every(x=>x.picker),JSON.stringify(a).slice(0,200));
    const g=await r.turn(thread.id,'Say hello.',{model:gptSlug});
    check(name+': GPT in the same chat goes to OpenAI, not Claude',g.status==='completed'&&g.text.includes('gpt-standin-ok')&&seen.ws+seen.http>0,JSON.stringify({text:g.text.slice(0,100),ws:seen.ws,http:seen.http}));
    const back=await r.turn(thread.id,'What exact text did the shell command print earlier? Reply with only that text.',{model:MODEL});
    check(name+': back on Claude it recalls the earlier turn',back.status==='completed'&&back.text.includes('picker-e2e-ok-5521'),back.text.slice(0,120));
    const compacted=r.wait(n=>n.method==='turn/completed'&&n.params.threadId===thread.id);
    await r.call('thread/compact/start',{threadId:thread.id});
    const c=await compacted;
    check(name+': compaction on Claude',c.params.turn?.status==='completed'&&requests().some(x=>x.request_kind==='compaction'),JSON.stringify(c.params.turn?.error??null));
    const n=seen.bodies.length;
    const g2=await r.turn(thread.id,'Say hello again.',{model:gptSlug});
    const sent=seen.bodies.slice(n).join('');
    check(name+': GPT after a Claude checkpoint gets it as text',g2.status==='completed'&&g2.text.includes('gpt-standin-ok')&&!sent.includes(BRIDGE_CHECKPOINT)&&sent.includes('picker-e2e-ok-5521'),`${sent.length} characters relayed`);
    noProblems(name,r.notes,logs);
  } catch(error){check(name,false,error.message);}
  finally {
    await stop(r);await b.close();for(const c of wss.clients)c.terminate();openai.closeAllConnections();openai.close();
    console.log('paths at the stand-in:',[...seen.paths].join(', '),'| websocket messages:',seen.ws);
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

const wanted=process.argv.slice(2);const want=x=>!wanted.length||wanted.includes(x);
console.log(execFileSync(CODEX,['--version'],{encoding:'utf8'}).trim());
if(want('window'))await windowMode(true);
if(want('window-no-search'))await windowMode(false);
if(want('picker'))await pickerMode();
const failed=results.filter(x=>!x.ok);
console.log(failed.length?'FAILURES: '+failed.map(x=>x.name).join(', '):`ALL PASS (${results.length})`);
process.exit(failed.length?1:0);
