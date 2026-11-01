import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge,providerKey,keyedPath} from '../src/server.mjs';
import {sealCheckpoint,openCheckpoint} from '../src/protocol.mjs';
const MODEL='claude-opus';
const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const tools=[{type:'custom',name:'exec',description:'test'}];
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const request=(text,id='user1')=>({model:MODEL,stream:true,tools,instructions:'fixture',input:[user(text,id)]});
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const output=text=>events(text).findLast(x=>x.type==='response.completed')?.response.output;
const said=out=>JSON.stringify(out.map(x=>x.content?.map(c=>c.text).join('')));
// scripts/sync_runtime.py derives the same key; test_sync_runtime.py checks this value too.
const KEY='AZQLNBomdte7YldDsmgV25qTOMu3Jc_hJu_EihHrYRY';
async function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-provider-test-'));const logs=[];
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,webSearch:true,log:(event,data)=>logs.push({event,...data}),...options});
 t.after(async()=>{await b.close();fs.rmSync(dir,{recursive:true,force:true});});
 // The app's own provider sends its ChatGPT login and no bridge header.
 const keyed=(body,headers={},key=KEY)=>fetch(`${b.url}/k/${key}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer chatgpt-login','Content-Type':'application/json','thread-id':'fixture',...headers},body:JSON.stringify(body)});
 const bridged=(body,headers={})=>fetch(b.url+'/v1/responses',{method:'POST',headers:{'X-Claude-Bridge-Key':'fixture-secret',Authorization:'Bearer chatgpt-login','Content-Type':'application/json','thread-id':'fixture',...headers},body:JSON.stringify(body)});
 return {b,dir,logs,keyed,bridged};
}
const upgrade=(url,pathname)=>new Promise((resolve,reject)=>{
 const {port}=new URL(url);const socket=net.connect(port,'127.0.0.1');let got='';
 socket.on('data',d=>{got+=d;});socket.on('end',()=>resolve(got));socket.on('error',reject);
 socket.setTimeout(3000,()=>{socket.destroy();reject(new Error(`No answer to the upgrade on ${pathname}: ${got}`));});
 socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
});

test('the path key is derived from the bridge token and only opens the v1 routes',()=>{
 assert.equal(providerKey('fixture-secret'),KEY);
 assert.notEqual(providerKey('other-token'),KEY);
 assert.equal(keyedPath(`/k/${KEY}/v1/responses`,KEY),'/v1/responses');
 assert.equal(keyedPath(`/k/${KEY}/v1/alpha/search`,KEY),'/v1/alpha/search');
 assert.equal(keyedPath(`/k/${KEY}x/v1/responses`,KEY),null);
 assert.equal(keyedPath(`/k//v1/responses`,KEY),null);
 assert.equal(keyedPath(`/k/${KEY}/mcp/session`,KEY),null);
 assert.equal(keyedPath(`/k/${KEY}`,KEY),null);
});

test('the app provider reaches Claude with the key in the path, and a wrong key is a 403, never a 401',async t=>{
 const {b,logs,keyed,bridged}=await setup(t);
 const out=output(await(await keyed(request('echo-input hello'))).text());
 assert.match(said(out),/hello/);
 assert.equal(logs.find(x=>x.event==='request').app_provider,true);
 assert.equal((await keyed(request('x'),{},KEY.slice(1)+'A')).status,403);
 assert.equal((await keyed(request('x'),{},'')).status,403);
 assert.equal((await fetch(`${b.url}/k/${KEY}/mcp/anything`,{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(`${b.url}/k/${KEY}/v1/responses`,{method:'POST',headers:{Origin:'https://example.com'},body:'{}'})).status,403);
 // The claude_bridge provider keeps its header, for threads started on it.
 assert.match(said(output(await(await bridged(request('echo-input still here','user2'))).text())),/still here/);
 assert.equal(logs.filter(x=>x.event==='request').at(-1).app_provider,false);
 assert.equal((await fetch(b.url+'/v1/responses',{method:'POST',body:'{}'})).status,401);
 const health=await(await fetch(`${b.url}/k/${KEY}/v1/models`)).json();
 assert.deepEqual(health.data.map(x=>x.id).slice(0,2),['claude-fable','claude-opus']);
 assert.equal((await(await fetch(b.url+'/health',{headers:{Authorization:'Bearer fixture-secret'}})).json()).app_provider,true);
});

test('a WebSocket upgrade on the key route gets 426, so the app streams over HTTP',async t=>{
 const {b}=await setup(t);
 for(const route of [`/k/${KEY}/v1/responses`,'/k/wrong/v1/responses'])
  assert.match(await upgrade(b.url,route),/^HTTP\/1\.1 426 /);
 assert.match(await upgrade(b.url,'/v1/responses'),/^HTTP\/1\.1 404 /);
 // The server keeps serving afterwards.
 assert.equal((await fetch(b.url+'/health',{headers:{Authorization:'Bearer fixture-secret'}})).status,200);
});

test('failures through the app provider are final, and the claude_bridge provider keeps its code',async t=>{
 const {keyed,bridged}=await setup(t);
 const failed=async res=>events(await res.text()).find(x=>x.type==='response.failed')?.response.error;
 const app=await failed(await keyed(request('plain-error'),{'thread-id':'app-fail'}));
 assert.equal(app.code,'invalid_prompt');assert.ok(app.message);
 const old=await failed(await bridged(request('plain-error'),{'thread-id':'bridge-fail'}));
 assert.equal(old.code,'claude_bridge_error');
 // An exception before any stream: a 5xx would be retried by the app's provider.
 const early=await keyed(request('x'),{'thread-id':'early','x-codex-turn-metadata':'{not json'});
 assert.equal(early.status,200);
 const error=await failed(early);assert.equal(error.code,'invalid_prompt');assert.match(error.message,/JSON/);
 const before=await bridged(request('x'),{'thread-id':'early-bridge','x-codex-turn-metadata':'{not json'});
 assert.equal(before.status,500);
 // Client errors stay plain 4xx, which the provider does not retry.
 assert.equal((await keyed({...request('x'),model:'gpt-elsewhere'})).status,400);
});

test('remote compaction ends with a compaction_trigger and returns the sealed checkpoint',async t=>{
 const {keyed,logs}=await setup(t);
 const first=request('hello');
 const answer=output(await(await keyed(first)).text());
 const res=await keyed({...first,input:[...first.input,...answer,{type:'compaction_trigger'}]});
 const out=output(await res.text());
 const item=out.find(x=>x.type==='compaction');assert.ok(item);
 assert.ok(openCheckpoint(item.encrypted_content,'fixture-secret').length>0);
 assert.equal(logs.filter(x=>x.event==='request').at(-1).request_kind,'compaction');
 assert.equal(logs.filter(x=>x.event==='request').at(-1).tools,0);
 // The next window carries the checkpoint item itself.
 const next=output(await(await keyed({...first,input:[item,user('echo-input after','user3')]},{'x-codex-turn-metadata':JSON.stringify({context_window_id:'w2'})})).text());
 assert.match(said(next),/Continue the existing task from this checkpoint/);assert.match(said(next),/after/);
});

test('a checkpoint that cannot be opened becomes a note instead of failing every request',async t=>{
 const {keyed}=await setup(t);
 const sealed=sealCheckpoint('REPLAY','another-token');
 for(const [value,note] of [[sealed,/cannot be read here/],['claude-bridge-v1:garbage',/cannot be read here/],['gAAAA-openai',/another model/]]) {
  const res=await keyed({...request('x'),input:[{type:'compaction',encrypted_content:value},user('echo-input go on','u2')]},{'thread-id':'note-'+value.length});
  assert.equal(res.status,200);
  const out=said(output(await res.text()));
  assert.match(out,note);assert.match(out,/go on/);
 }
});

test('web search through the app provider is forwarded without the bridge header',async t=>{
 const received=[];
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received.push(req.headers);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"results":[]}');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
 const {b,logs}=await setup(t,{searchUpstream:`http://127.0.0.1:${upstream.address().port}/alpha/search`});
 const search=(key,headers={})=>fetch(`${b.url}/k/${key}/v1/alpha/search`,{method:'POST',headers:{Authorization:'Bearer chatgpt-login','Content-Type':'application/json',...headers},body:JSON.stringify({commands:{search_query:[{q:'x'}]}})});
 const ok=await search(KEY);assert.equal(ok.status,200);
 assert.equal(received[0].authorization,'Bearer chatgpt-login');
 assert.equal((await search('wrong')).status,403);
 // Without a ChatGPT login there is nothing to forward.
 assert.equal((await fetch(`${b.url}/k/${KEY}/v1/alpha/search`,{method:'POST',body:'{}'})).status,401);
 assert.equal(received.length,1);
 assert.ok(logs.some(x=>x.event==='search_request'&&x.status===200));
});

test('a client that resets a refused upgrade does not crash the bridge',async t=>{
 const {b}=await setup(t);const {port}=new URL(b.url);
 for(let i=0;i<40;i++)await new Promise(resolve=>{
  const socket=net.connect(port,'127.0.0.1',()=>{
   socket.write(`GET /k/${KEY}/v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
   socket.resetAndDestroy();resolve();
  });socket.on('error',resolve);
 });
 assert.equal((await fetch(b.url+'/health',{headers:{Authorization:'Bearer fixture-secret'}})).status,200);
});

test('a restart mid-reply ends the app provider stream with a failure it shows, not one it retries',async t=>{
 const {b,keyed,bridged}=await setup(t);
 const started=async res=>{const reader=res.body.getReader();let text='';while(!text.includes('waiting')){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);}return {reader,text};};
 const rest=async({reader,text})=>{for(;;){const {value,done}=await reader.read();if(done)return text;text+=new TextDecoder().decode(value);}};
 const app=await started(await keyed(request('slow-response'),{'thread-id':'restart-app'}));
 const old=await started(await bridged(request('slow-response','user2'),{'thread-id':'restart-bridge'}));
 await b.close();
 const error=events(await rest(app)).find(x=>x.type==='response.failed')?.response.error;
 assert.equal(error?.code,'invalid_prompt');assert.match(error.message,/restarted while replying/);
 // The claude_bridge provider never retries, so its stream still just ends.
 assert.equal(events(await rest(old)).some(x=>x.type==='response.failed'),false);
});

test('tools only OpenAI can run are left out on the app provider instead of failing the turn',async t=>{
 const {keyed,bridged,logs}=await setup(t);
 const body={...request('echo-input hosted'),tools:[...tools,{type:'image_generation'},{type:'web_search'}]};
 assert.match(said(output(await(await keyed(body,{'thread-id':'hosted-app'})).text())),/hosted/);
 assert.deepEqual(logs.find(x=>x.event==='hosted_tools_omitted').types,['image_generation','web_search']);
 // The claude_bridge provider never gets these from the app, and still refuses them.
 const refused=await bridged(body,{'thread-id':'hosted-bridge'});
 assert.equal(refused.status,500);assert.match((await refused.json()).error.message,/Unsupported provider-native tool/);
});

test('web search stays off on the app provider until it is turned on',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-bridge-provider-test-'));
 const b=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture});
 t.after(async()=>{await b.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal((await fetch(`${b.url}/k/${KEY}/v1/alpha/search`,{method:'POST',headers:{Authorization:'Bearer chatgpt-login'},body:'{}'})).status,404);
});

test('a key route without picker mode leaves the gateway routes closed',async t=>{
 const {b}=await setup(t);
 assert.equal((await fetch(`${b.url}/g/${KEY}/backend-api/codex/models`)).status,401);
 assert.match(await upgrade(b.url,`/g/${KEY}/backend-api/codex/responses`),/^HTTP\/1\.1 401 /);
});
