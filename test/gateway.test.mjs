import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync} from 'node:zlib';
import {WebSocket, WebSocketServer} from 'ws';
import {startBridge} from '../src/server.mjs';
import {sealCheckpoint} from '../src/protocol.mjs';
import {tagEtag, untagEtag, gatewayPath, withClaudeModels} from '../src/gateway.mjs';
import {loadModels} from '../src/models.mjs';

const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const KEY='fixture-gateway-key';
const gptTemplate={slug:'gpt-fixture',display_name:'GPT Fixture',tool_mode:'code_mode_only',priority:3,visibility:'list',supported_reasoning_levels:[{effort:'low'}],model_messages:{instructions_template:'You are Codex, a coding agent.\nRules.'},context_window:272000};
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));

// A stand-in for OpenAI's Codex backend: HTTP routes and a Responses WebSocket.
async function fakeOpenAI(t) {
  const seen={http:[],ws:[],handshakes:[],paths:[],sockets:[]};
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=Buffer.concat(chunks);seen.http.push({method:req.method,url:req.url,headers:req.headers,body});
    if(req.headers.authorization==='Bearer expired'){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"error":{"message":"expired"}}');}
    if(req.url.startsWith('/backend-api/codex/models')) {
      if(req.headers['if-none-match']==='W/"models-1"'){res.writeHead(304,{etag:'W/"models-1"'});return res.end();}
      res.writeHead(200,{'Content-Type':'application/json',etag:'W/"models-1"'});return res.end(JSON.stringify({models:[{slug:'gpt-plain',priority:1},gptTemplate]}));
    }
    res.writeHead(200,{'Content-Type':'text/event-stream','x-models-etag':'W/"models-1"','x-codex-turn-state':'sticky-1'});
    res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_gpt"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gpt","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"from gpt"}]}]}}\n\n');
  });
  const wss=new WebSocketServer({noServer:true});
  wss.on('headers',headers=>headers.push('x-codex-turn-state: sticky-ws','openai-model: gpt-fixture','x-reasoning-included: true','x-models-etag: W/"models-1"'));
  server.on('upgrade',(req,socket,head)=>{
    seen.handshakes.push(req.headers);seen.paths.push(req.url);
    if(req.headers.authorization==='Bearer expired'){socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"e":"exp"}');return;}
    wss.handleUpgrade(req,socket,head,ws=>{seen.sockets.push(ws);ws.on('message',data=>{
      const message=JSON.parse(data.toString());seen.ws.push(message);
      ws.send(JSON.stringify({type:'codex.response.metadata',headers:{'x-models-etag':'W/"models-1"'}}));
      ws.send(JSON.stringify({type:'response.created',response:{id:'resp_gpt_ws'}}));
      // A response still running, for a close in the middle of it.
      if(JSON.stringify(message).includes('hold-gpt'))return;
      ws.send(JSON.stringify({type:'response.completed',response:{id:'resp_gpt_ws',output:[]}}));
    });});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const c of wss.clients)c.terminate();server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {seen,url:`http://127.0.0.1:${server.address().port}/backend-api/codex`};
}

async function setup(t,{upstream}={}) {
  const openai=upstream?null:await fakeOpenAI(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gateway-'));const logs=[];
  const bridge=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,gatewayKey:KEY,gatewayUpstream:upstream??openai.url,log:(event,data)=>logs.push({event,...data})});
  t.after(async()=>{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=bridge.url+'/g/'+KEY+'/backend-api/codex';
  const app={'Authorization':'Bearer chatgpt-fixture-token','ChatGPT-Account-Id':'acct-fixture','Content-Type':'application/json'};
  const post=(body,headers={},raw)=>fetch(base+'/responses?client_version=9',{method:'POST',headers:{...app,'thread-id':'thread-1',...headers},body:raw??JSON.stringify(body)});
  return {bridge,openai,logs,dir,base,post,app};
}
function connect(url,headers,options={}) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url,{headers,...options});const received=[];let upgrade;
    ws.on('upgrade',r=>{upgrade=r.headers;});
    ws.on('message',d=>received.push(JSON.parse(d.toString())));
    ws.on('open',()=>resolve({ws,received,headers:upgrade,next:async(type,count=1)=>{for(let i=0;i<400;i++){const hits=received.filter(x=>x.type===type);if(hits.length>=count)return hits.at(-1);await new Promise(r=>setTimeout(r,10));}assert.fail('No '+type+' event');}}));
    ws.on('unexpected-response',(req,res)=>reject(Object.assign(new Error('refused'),{status:res.statusCode})));
    ws.on('error',reject);
  });
}
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const tools=[{type:'custom',name:'exec',description:'test'}];

test('the gateway path needs the exact key and the Codex route',()=>{
 assert.equal(gatewayPath('/g/'+KEY+'/backend-api/codex/responses',KEY),'/responses');
 assert.equal(gatewayPath('/g/'+KEY+'/backend-api/codex',KEY),'');
 for(const bad of ['/g/other/backend-api/codex/responses','/g/'+KEY+'/v1/responses','/g/'+KEY+'/backend-api/codexx','/v1/responses'])assert.equal(gatewayPath(bad,KEY),null);
 assert.equal(gatewayPath('/g/'+KEY+'/backend-api/codex/models',null),null);
 assert.equal(tagEtag('W/"abc"','claude-1'),'W/"abc-claude-1"');assert.equal(untagEtag('W/"abc-claude-1"','claude-1'),'W/"abc"');assert.equal(tagEtag(undefined,'x'),undefined);
});

test('picker mode relays GPT over HTTP byte for byte',async t=>{
 const {openai,post,logs}=await setup(t);
 const raw=zstdCompressSync(Buffer.from(JSON.stringify({model:'gpt-fixture',stream:true,input:[user('hi','u1')],tools})));
 const response=await post(null,{'Content-Encoding':'zstd','x-codex-turn-metadata':'{"turn_id":"t1"}'},raw);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('x-codex-turn-state'),'sticky-1');
 assert.match(response.headers.get('x-models-etag'),/^W\/"models-1-claude-[0-9a-f]{10}"$/);
 assert.equal(events(await response.text()).at(-1).response.output[0].content[0].text,'from gpt');
 const sent=openai.seen.http[0];
 assert.equal(sent.url,'/backend-api/codex/responses?client_version=9');
 assert.ok(sent.body.equals(raw));assert.equal(sent.headers['content-encoding'],'zstd');
 assert.equal(sent.headers.authorization,'Bearer chatgpt-fixture-token');assert.equal(sent.headers['chatgpt-account-id'],'acct-fixture');
 assert.equal(sent.headers['x-codex-turn-metadata'],'{"turn_id":"t1"}');assert.ok(!sent.url.includes(KEY));
 assert.equal(logs.some(x=>x.event==='claude_start'),false);
});

test('the model list gains the Claude entries and keeps its cache validation',async t=>{
 const {openai,base,app}=await setup(t);
 const response=await fetch(base+'/models?client_version=9',{headers:app});
 const etag=response.headers.get('etag');assert.match(etag,/^W\/"models-1-claude-[0-9a-f]{10}"$/);
 const list=(await response.json()).models;
 assert.deepEqual(list.map(m=>m.slug),['gpt-plain','gpt-fixture','claude-fable','claude-opus','claude-sonnet','claude-haiku']);
 const opus=list[3];
 assert.deepEqual([opus.display_name,opus.priority,opus.context_window,opus.auto_compact_token_limit,opus.tool_mode],['Claude Opus 5.5',5,1000000,800000,'code_mode_only']);
 assert.match(opus.model_messages.instructions_template,/^You are Claude Opus 5\.5, running as the main assistant in ChatGPT Desktop\..*\nRules\.$/s);
 assert.deepEqual(list.slice(2).map(m=>m.display_name),['Claude Fable 5.1','Claude Opus 5.5','Claude Sonnet 5.5','Claude Haiku 5.5']);
 assert.equal(openai.seen.http[0].headers['accept-encoding'],'identity');
 const again=await fetch(base+'/models?client_version=9',{headers:{...app,'If-None-Match':etag}});
 assert.equal(again.status,304);assert.equal(again.headers.get('etag'),etag);
 assert.equal(openai.seen.http[1].headers['if-none-match'],'W/"models-1"');
 assert.deepEqual(withClaudeModels([{slug:'no-template'}],loadModels()),[{slug:'no-template'}]);
});

test('a new Claude version renames its entry and makes the app download the list again',async t=>{
 const {bridge,openai,base,app}=await setup(t);
 const first=await fetch(base+'/models?client_version=9',{headers:app});
 const etag=first.headers.get('etag');await first.json();
 bridge.modelStarted('claude-fable','claude-fable-5-5');
 const after=await fetch(base+'/models?client_version=9',{headers:{...app,'If-None-Match':etag}});
 assert.equal(after.status,200);
 assert.notEqual(after.headers.get('etag'),etag);assert.match(after.headers.get('etag'),/^W\/"models-1-claude-[0-9a-f]{10}"$/);
 const fable=(await after.json()).models.find(m=>m.slug==='claude-fable');
 assert.equal(fable.display_name,'Claude Fable 5.5');
 assert.match(fable.model_messages.instructions_template,/^You are Claude Fable 5\.5, running/);
 assert.equal(openai.seen.http.length,2);
});

test('a wrong key is refused before anything reaches OpenAI',async t=>{
 const {openai,bridge,app}=await setup(t);
 assert.equal((await fetch(bridge.url+'/g/wrong-key/backend-api/codex/responses',{method:'POST',headers:app,body:'{}'})).status,401);
 assert.equal((await fetch(bridge.url+'/g/'+KEY+'/backend-api/codex/responses',{method:'POST',headers:{...app,Origin:'https://example.com'},body:'{}'})).status,403);
 await assert.rejects(connect(bridge.url.replace('http','ws')+'/g/wrong-key/backend-api/codex/responses',app),e=>e.status===401);
 assert.equal(openai.seen.http.length+openai.seen.handshakes.length,0);
});

test('Claude requests over HTTP are answered locally, without the hosted tools GPT gets',async t=>{
 const {openai,post,logs}=await setup(t);
 const response=await post({model:'claude-opus',stream:true,input:[user('echo-input hello','u1')],tools:[...tools,{type:'web_search'},{type:'image_generation'}]});
 const out=events(await response.text()).at(-1).response.output;
 assert.match(out[0].content[0].text,/ECHO .*hello/);
 assert.equal(openai.seen.http.length,0);
 assert.deepEqual(logs.find(x=>x.event==='hosted_tools_omitted').types,['web_search','image_generation']);
 assert.equal(logs.find(x=>x.event==='request').picker,'http');
});

test('GPT over WebSocket passes the handshake headers and events through',async t=>{
 const {openai,bridge,app}=await setup(t);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses?v=2',{...app,'OpenAI-Beta':'responses_websockets=v2','session_id':'s-1'});
 assert.equal(c.headers['x-codex-turn-state'],'sticky-ws');assert.equal(c.headers['openai-model'],'gpt-fixture');assert.equal(c.headers['x-reasoning-included'],'true');
 assert.match(c.headers['x-models-etag'],/models-1-claude-/);
 const create={type:'response.create',model:'gpt-fixture',input:[user('hi','u1')],tools,stream:true,client_metadata:{thread_id:'thread-ws'}};
 c.ws.send(JSON.stringify(create));
 await c.next('response.completed');
 assert.deepEqual(openai.seen.ws[0],create);
 const hs=openai.seen.handshakes[0];
 assert.equal(hs.authorization,'Bearer chatgpt-fixture-token');assert.equal(hs['openai-beta'],'responses_websockets=v2');assert.equal(hs['session_id'],'s-1');
 assert.match(c.received.find(x=>x.type==='codex.response.metadata').headers['x-models-etag'],/models-1-claude-/);
 const health=await(await fetch(bridge.url+'/health',{headers:{Authorization:'Bearer fixture-secret'}})).json();
 assert.equal(health.picker,true);assert.equal(health.active_relays,0);
 c.ws.close();
});

test('Claude over WebSocket: prewarm, a tool cycle sent as increments, then the answer',async t=>{
 const {openai,bridge,app,dir,logs}=await setup(t);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app);
 const base={type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-ws-claude','x-codex-turn-metadata':'{"turn_id":"t1"}'}};
 const first=[user('invoke-tool','u1')];
 c.ws.send(JSON.stringify({...base,input:first,generate:false}));
 const warm=await c.next('response.completed');assert.deepEqual(warm.response.output,[]);
 c.ws.send(JSON.stringify({...base,input:[],previous_response_id:warm.response.id}));
 const call=(await c.next('response.completed',2)).response.output[0];
 assert.equal(call.type,'custom_tool_call');
 c.ws.send(JSON.stringify({...base,previous_response_id:(await c.next('response.created',2)).response.id,input:[{type:'custom_tool_call_output',call_id:call.call_id,output:'ran once'}]}));
 const final=(await c.next('response.completed',3)).response.output;
 assert.match(JSON.stringify(final),/RESULT.*ran once/);
 assert.equal(fs.readFileSync(path.join(dir,'fake-starts'),'utf8').trim().split('\n').length,1);
 assert.equal(openai.seen.ws.length,0);assert.equal(logs.some(x=>x.event==='history_branch_rebuilt'),false);
 c.ws.send(JSON.stringify({...base,input:[],previous_response_id:'resp_unknown'}));
 const error=await c.next('error');assert.equal(error.error.code,'previous_response_not_found');
 c.ws.close();
});

test('an interrupt on a Claude WebSocket response ends it as incomplete and the next turn resumes',async t=>{
 const {bridge,app,logs}=await setup(t);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app);
 const base={type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-stop'}};
 const first=[user('slow-response','u1')];
 c.ws.send(JSON.stringify({...base,input:first}));
 await c.next('response.output_text.delta');
 const id=(await c.next('response.created')).response.id;
 c.ws.send(JSON.stringify({type:'response.interrupt',response_id:id,mode:'discard_partial_items'}));
 const incomplete=await c.next('response.incomplete');assert.equal(incomplete.response.id,id);
 for(let i=0;i<200&&!logs.some(x=>x.event==='claude_exit');i++)await new Promise(r=>setTimeout(r,10));
 const note={type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted/>'}]};
 c.ws.send(JSON.stringify({...base,input:[...first,note,user('continue','u2')]}));
 const out=(await c.next('response.completed')).response.output;
 assert.match(out[0].content[0].text,/^RESUMED .*turn_stopped.*continue/);
 assert.ok(logs.some(x=>x.event==='stopped_turn_resumed'));
 c.ws.close();
});

test('a Claude WebSocket request the app drops at once leaves no Claude process running',async t=>{
 const {bridge,app,logs}=await setup(t);
 for(let i=0;i<5;i++) {
  const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app,{perMessageDeflate:false});
  c.ws.send(JSON.stringify({type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-drop-'+i},input:[user('slow-response','u1')]}));
  c.ws.terminate();
 }
 await new Promise(r=>setTimeout(r,500));
 // A process that started before the drop is stopped once it reports init.
 for(let i=0;i<500&&[...bridge.sessions.values()].some(s=>s.child);i++)await new Promise(r=>setTimeout(r,10));
 for(const session of bridge.sessions.values())assert.ok(!session.child,'a Claude process was left running');
 assert.equal(logs.filter(x=>x.event==='claude_start').length,logs.filter(x=>x.event==='stopped_at_init').length);
});
test('a message sent with the interrupt, in the same packet, starts the next Claude response',async t=>{
 const {bridge,app}=await setup(t);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app,{perMessageDeflate:false});
 const base={type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-race'}};
 const first=[user('slow-response','u1')];
 c.ws.send(JSON.stringify({...base,input:first}));
 await c.next('response.output_text.delta');
 const id=(await c.next('response.created')).response.id;
 c.ws._socket.cork();
 c.ws.send(JSON.stringify({type:'response.interrupt',response_id:id}));
 c.ws.send(JSON.stringify({...base,input:[...first,user('also this','u2')]}));
 process.nextTick(()=>c.ws._socket.uncork());
 await c.next('response.completed');
 assert.equal(c.received.some(x=>x.type==='error'),false);
 c.ws.close();
});
// OpenAI closes connections that sit idle, as they do while Claude answers.
const until=async(check,what)=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for '+what);};
const closed=ws=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('The app connection stayed open')),3000);ws.once('close',(code,reason)=>{clearTimeout(timer);resolve({code,reason:reason.toString()});});});
test('OpenAI closing its side leaves a Claude connection open, and a GPT request after it gets a new connection',async t=>{
 const {openai,bridge,app,logs}=await setup(t);
 const url=bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses';
 const c=await connect(url,app);
 const base={type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-idle'}};
 c.ws.send(JSON.stringify({...base,input:[user('echo-input one','u1')]}));
 const first=await c.next('response.completed');
 openai.seen.sockets[0].close(1000,'idle');
 await until(()=>logs.some(x=>x.event==='gateway_ws_openai_closed'),'the close log');
 assert.equal(logs.find(x=>x.event==='gateway_ws_openai_closed').kept_open,true);
 c.ws.send(JSON.stringify({...base,previous_response_id:first.response.id,input:[user('echo-input two','u2')]}));
 assert.match(JSON.stringify((await c.next('response.completed',2)).response.output),/ECHO.*two/);
 assert.equal(c.ws.readyState,WebSocket.OPEN);
 const gone=closed(c.ws);
 c.ws.send(JSON.stringify({type:'response.create',model:'gpt-fixture',input:[user('hi','u3')],tools,stream:true}));
 assert.equal((await gone).code,1000);
 assert.equal(c.received.some(x=>x.type==='error'),false);assert.equal(openai.seen.ws.length,0);
 const again=await connect(url,app);
 again.ws.send(JSON.stringify({type:'response.create',model:'gpt-fixture',input:[user('hi','u3')],tools,stream:true}));
 await again.next('response.completed');assert.equal(openai.seen.ws.length,1);
 assert.equal((await(await fetch(bridge.url+'/health',{headers:{Authorization:'Bearer fixture-secret'}})).json()).active_relays,0);
 again.ws.close();
});

test('OpenAI closing its side while Claude answers does not cut the answer off',async t=>{
 const {openai,bridge,app}=await setup(t);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app);
 c.ws.send(JSON.stringify({type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-mid'},input:[user('silent-think-400','u1')]}));
 await c.next('response.created');
 openai.seen.sockets[0].close(1001,'going away');
 assert.match(JSON.stringify((await c.next('response.completed')).response.output),/AWAKE/);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(c.ws.readyState,WebSocket.OPEN);assert.equal(c.received.some(x=>x.type==='error'),false);
 c.ws.close();
});

test('a message OpenAI sends on its own to a Claude connection does not reach the app',async t=>{
 const {openai,bridge,app,logs}=await setup(t);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app);
 const base={type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-stray'}};
 c.ws.send(JSON.stringify({...base,input:[user('echo-input one','u1')]}));
 const first=await c.next('response.completed');
 openai.seen.sockets[0].send(JSON.stringify({type:'error',status:400,error:{code:'websocket_connection_limit_reached',message:'limit'}}));
 await until(()=>logs.some(x=>x.event==='gateway_ws_openai_message_dropped'),'the drop log');
 assert.equal(logs.find(x=>x.event==='gateway_ws_openai_message_dropped').type,'error');
 c.ws.send(JSON.stringify({...base,previous_response_id:first.response.id,input:[user('echo-input two','u2')]}));
 const second=await c.next('response.completed',2);
 // And in the middle of a Claude response.
 c.ws.send(JSON.stringify({...base,previous_response_id:second.response.id,input:[user('silent-think-300','u3')]}));
 await c.next('response.created',3);
 openai.seen.sockets[0].send(JSON.stringify({type:'error',status:500,error:{message:'stray'}}));
 assert.match(JSON.stringify((await c.next('response.completed',3)).response.output),/AWAKE/);
 assert.equal(c.received.some(x=>x.type==='error'),false);
 assert.equal(logs.filter(x=>x.event==='gateway_ws_openai_message_dropped').length,2);
 c.ws.close();
});

test('a connection follows OpenAI closing it before any request, after GPT, and in the middle of a GPT response',async t=>{
 const {openai,bridge,app,logs}=await setup(t);
 const url=bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses';
 const claude=input=>JSON.stringify({type:'response.create',model:'claude-opus',stream:true,tools,instructions:'fixture',client_metadata:{thread_id:'thread-gpt'},input});
 const gpt=text=>JSON.stringify({type:'response.create',model:'gpt-fixture',input:[user(text,'g1')],tools,stream:true});
 const relays=async()=>(await(await fetch(bridge.url+'/health',{headers:{Authorization:'Bearer fixture-secret'}})).json()).active_relays;
 // The app opens its connection at startup, before its first request.
 const fresh=await connect(url,app);let gone=closed(fresh.ws);
 openai.seen.sockets.at(-1).close(1008,'refused');
 assert.deepEqual(await gone,{code:1008,reason:'refused'});
 // Claude, then GPT, then an idle close.
 const c=await connect(url,app);
 c.ws.send(claude([user('echo-input one','u1')]));await c.next('response.completed');
 c.ws.send(gpt('hi'));await c.next('response.completed',2);
 gone=closed(c.ws);
 openai.seen.sockets.at(-1).close(4000,'limit');
 assert.deepEqual(await gone,{code:4000,reason:'limit'});
 // A close while a GPT response is still running.
 const held=await connect(url,app);
 held.ws.send(gpt('hold-gpt'));await held.next('response.created');
 assert.equal(await relays(),1);
 gone=closed(held.ws);
 openai.seen.sockets.at(-1).close(1011,'server error');
 assert.deepEqual(await gone,{code:1011,reason:'server error'});
 assert.equal(await relays(),0);
 assert.deepEqual(logs.filter(x=>x.event==='gateway_ws_openai_closed').map(x=>[x.kept_open,x.gpt_pending]),[[false,0],[false,0],[false,1]]);
 // GPT, then Claude, then an idle close: Claude still has the connection.
 const mixed=await connect(url,app);
 mixed.ws.send(gpt('hi'));await mixed.next('response.completed');
 mixed.ws.send(claude([user('echo-input two','u2')]));await mixed.next('response.completed',2);
 openai.seen.sockets.at(-1).close(1000,'idle');
 await until(()=>logs.filter(x=>x.event==='gateway_ws_openai_closed').length===4,'the fourth close');
 assert.equal(logs.filter(x=>x.event==='gateway_ws_openai_closed').at(-1).kept_open,true);
 assert.equal(mixed.ws.readyState,WebSocket.OPEN);
 mixed.ws.close();
});

test('remote compaction of a Claude thread returns one checkpoint item that GPT can then read',async t=>{
 const {openai,post}=await setup(t);
 const history=[user('remember amber pine 742','u1'),{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}];
 const out=events(await(await post({model:'claude-sonnet',stream:true,tools,input:[...history,{type:'compaction_trigger'}]},{'x-codex-turn-metadata':'{"request_kind":"compaction"}'})).text()).at(-1).response.output;
 const items=out.filter(x=>x.type==='compaction');assert.equal(items.length,1);
 assert.match(items[0].encrypted_content,/^claude-bridge-v1:/);
 // The thread switches to GPT: OpenAI receives the summary as text.
 const gpt=await post({model:'gpt-fixture',stream:true,input:[user('remember amber pine 742','u1'),items[0],user('next','u3')]});
 assert.equal(gpt.status,200);await gpt.text();
 const sent=JSON.parse(openai.seen.http[0].body.toString());
 assert.equal(sent.input[1].type,'message');assert.match(sent.input[1].content[0].text,/<context_checkpoint>\nREPLAY/);
 assert.equal(openai.seen.http[0].headers['content-encoding'],undefined);
 // A checkpoint GPT wrote cannot be opened by the bridge; Claude gets a note.
 const foreign=events(await(await post({model:'claude-opus',stream:true,tools,input:[{type:'compaction',encrypted_content:'gAAAA-openai'},user('echo-input after gpt compaction','u4')]},{'thread-id':'thread-2'})).text()).at(-1).response.output;
 assert.match(JSON.stringify(foreign),/compacted by another model/);
 void sealCheckpoint;
});

test('requests for GPT drop the ids of items Claude wrote and keep every other id',async t=>{
 const {openai,post,bridge,app,logs}=await setup(t);
 const claude=events(await(await post({model:'claude-opus',stream:true,tools,input:[user('echo-input hello','u1')]})).text()).at(-1).response.output;
 assert.match(claude[0].id,/^msg_claude[0-9a-f]{32}$/);
 const fromGpt={type:'message',id:'msg_0cf69a12',role:'assistant',content:[{type:'output_text',text:'from gpt'}]};
 const input=[user('echo-input hello','u1'),...claude,fromGpt,user('next','u2')];
 const check=sent=>{
  assert.deepEqual(sent.input.map(x=>x.id),['u1',...claude.map(()=>undefined),'msg_0cf69a12','u2']);
  assert.deepEqual(sent.input.slice(1,1+claude.length),claude.map(({id,...rest})=>rest));
 };
 await(await post({model:'gpt-fixture',stream:true,input})).text();
 check(JSON.parse(openai.seen.http[0].body.toString()));
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses?v=2',{...app,'OpenAI-Beta':'responses_websockets=v2'});
 c.ws.send(JSON.stringify({type:'response.create',model:'gpt-fixture',input,tools,stream:true}));
 await c.next('response.completed');
 check(openai.seen.ws[0]);
 assert.deepEqual(logs.filter(x=>x.event==='claude_ids_removed_for_gpt').map(x=>x.transport),['http','websocket']);
 c.ws.close();
});

test('a Claude checkpoint sealed by an earlier installation becomes a note, and the bridge keeps serving',async t=>{
 const {openai,post,bridge,app,logs}=await setup(t);
 const stale={type:'compaction',encrypted_content:sealCheckpoint('old summary','an-earlier-token')};
 const input=[user('remember amber pine 742','u1'),stale,user('next','u2')];
 await(await post({model:'gpt-fixture',stream:true,input})).text();
 assert.match(JSON.parse(openai.seen.http[0].body.toString()).input[1].content[0].text,/sealed by an earlier installation/);
 const c=await connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app);
 c.ws.send(JSON.stringify({type:'response.create',model:'gpt-fixture',input,stream:true}));
 await c.next('response.completed');
 assert.match(openai.seen.ws[0].input[1].content[0].text,/sealed by an earlier installation/);
 c.ws.close();
 const claude=events(await(await post({model:'claude-opus',stream:true,tools,input:[stale,user('echo-input after reinstall','u3')]},{'thread-id':'thread-2'})).text()).at(-1).response.output;
 assert.match(JSON.stringify(claude),/sealed by an earlier installation/);
 assert.equal(logs.some(x=>['request_error','gateway_ws_error'].includes(x.event)),false);
});

test('other WebSockets on the Codex route, such as voice, are relayed to OpenAI unchanged',async t=>{
 const {openai,bridge,app,logs}=await setup(t);
 const ws=new WebSocket(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/realtime?call_id=call_1',['realtime'],{headers:app});
 const received=[];ws.on('message',d=>received.push(JSON.parse(d.toString())));
 await new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject);});
 assert.equal(ws.protocol,'realtime');
 ws.send(JSON.stringify({type:'session.update',session:{voice:'fixture'}}));
 for(let i=0;i<200&&!received.some(x=>x.type==='response.completed');i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(received.map(x=>x.type),['codex.response.metadata','response.created','response.completed']);
 assert.deepEqual(openai.seen.ws,[{type:'session.update',session:{voice:'fixture'}}]);
 assert.equal(openai.seen.paths.at(-1),'/backend-api/codex/realtime?call_id=call_1');
 assert.equal(openai.seen.handshakes.at(-1).authorization,'Bearer chatgpt-fixture-token');
 assert.ok(logs.some(x=>x.event==='gateway_ws_relayed'&&x.path==='/realtime'));
 ws.close();
});

test('when OpenAI cannot be reached, HTTP gets 502 and the WebSocket handshake fails',async t=>{
 const closed=http.createServer();await new Promise(r=>closed.listen(0,'127.0.0.1',r));const port=closed.address().port;await new Promise(r=>closed.close(r));
 const {bridge,post,app,logs}=await setup(t,{upstream:`http://127.0.0.1:${port}/backend-api/codex`});
 const response=await post({model:'gpt-fixture',stream:true,input:[]});
 assert.equal(response.status,502);assert.match((await response.json()).error.message,/could not reach OpenAI/);
 await assert.rejects(connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',app));
 assert.ok(logs.some(x=>x.event==='gateway_upstream_error'));
});

test('an expired ChatGPT login reaches the app as OpenAI sent it',async t=>{
 const {bridge,post,app}=await setup(t);
 const response=await post({model:'gpt-fixture',stream:true,input:[]},{Authorization:'Bearer expired'});
 assert.equal(response.status,401);assert.equal((await response.json()).error.message,'expired');
 await assert.rejects(connect(bridge.url.replace('http','ws')+'/g/'+KEY+'/backend-api/codex/responses',{...app,Authorization:'Bearer expired'}),e=>e.status===401);
});
