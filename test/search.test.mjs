import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {zstdCompressSync} from 'node:zlib';
import {startBridge} from '../src/server.mjs';

async function setup(t,handler,options={}) {
 const upstream=http.createServer(handler);await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-search-test-'));const logs=[];
 const bridge=await startBridge({stateDir,token:'local-fixture-key',port:0,webSearch:true,searchUpstream:`http://127.0.0.1:${upstream.address().port}/alpha/search`,log:(event,data)=>logs.push({event,...data}),...options});
 t.after(async()=>{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));fs.rmSync(stateDir,{recursive:true,force:true});});
 const post=(body,headers={},raw)=>fetch(bridge.url+'/v1/alpha/search',{method:'POST',headers:{'X-Claude-Bridge-Key':'local-fixture-key',Authorization:'Bearer isolated-fixture-token','Content-Type':'application/json',...headers},body:raw??JSON.stringify(body)});
 return {bridge,post,logs,stateDir};
}

test('search and open preserve payloads and forward only isolated request credentials',async t=>{
 const received=[];const answer={results:[{text:'private-fixture-result'}]};
 const {post,logs,stateDir}=await setup(t,async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;received.push({headers:req.headers,body:JSON.parse(raw)});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(answer));
 });
 const search={commands:{search_query:[{q:'private-fixture-query'}],response_length:'short'},conversation_id:'fixture-context'};
 const a=await post(search,{'ChatGPT-Account-Id':'isolated-account',Cookie:'must-not-forward',Originator:'incoming'});
 assert.deepEqual(await a.json(),answer);assert.equal(a.status,200);
 assert.deepEqual(received[0].body,search);
 assert.equal(received[0].headers.authorization,'Bearer isolated-fixture-token');
 assert.equal(received[0].headers['chatgpt-account-id'],'isolated-account');
 assert.equal(received[0].headers['x-claude-bridge-key'],undefined);assert.equal(received[0].headers.cookie,undefined);
 const open={commands:{open:[{ref_id:'https://example.com/private-fixture-url'}]}};
 const b=await post(open,{'content-encoding':'zstd'},zstdCompressSync(Buffer.from(JSON.stringify(open))));
 assert.equal(b.status,200);assert.deepEqual(received[1].body,open);assert.equal(received[1].headers['chatgpt-account-id'],undefined);
 assert.equal(logs.filter(x=>x.event==='search_header_names').length,1);
 assert.ok(JSON.parse(fs.readFileSync(path.join(stateDir,'search-header-names.json'))).includes('authorization'));
 assert.deepEqual(logs.filter(x=>x.event==='search_request').map(x=>({status:x.status,commands:x.commands})),[{status:200,commands:['search_query']},{status:200,commands:['open']}]);
 const metadata=JSON.stringify(logs);
 for(const secret of ['private-fixture-query','private-fixture-result','private-fixture-url','isolated-fixture-token','isolated-account','local-fixture-key'])assert.ok(!metadata.includes(secret));
});

test('local key and independent ChatGPT authorization are both required',async t=>{
 let hits=0;const {post}=await setup(t,(req,res)=>{hits++;res.end();});
 const body={commands:{search_query:[{q:'fixture'}]}};
 assert.equal((await post(body,{'X-Claude-Bridge-Key':'wrong'})).status,401);
 const missing=await post(body,{Authorization:''});assert.equal(missing.status,401);assert.match((await missing.json()).error.message,/Sign into the Claude window/);
 assert.equal((await post(body,{Authorization:'Bearer local-fixture-key'})).status,401);
 assert.equal((await post(body,{Origin:'https://example.com'})).status,403);
 assert.equal(hits,0);
});

test('upstream login errors instruct sign-in without exposing upstream messages',async t=>{
 const {post,logs}=await setup(t,(req,res)=>{res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"private-token-or-result"}');});
 const response=await post({commands:{open:[{ref_id:'private-url'}]}});
 assert.equal(response.status,401);assert.match((await response.json()).error.message,/Sign into the Claude window/);
 assert.ok(!JSON.stringify(logs).includes('private-token-or-result'));
});

test('changed endpoints, invalid responses and redirects fail explicitly',async t=>{
 for(const fixture of [{status:404},{status:410},{status:302},{status:200,type:'text/html',data:'private-result'},{status:200,type:'application/json',data:'private-invalid-json'},{status:200,type:'application/json',data:'null'}]) {
  await t.test(JSON.stringify({status:fixture.status,type:fixture.type,dataType:fixture.data?'fixture':'none'}),async t=>{
   let hits=0;const {post,logs}=await setup(t,(req,res)=>{hits++;res.writeHead(fixture.status,{'Content-Type':fixture.type??'application/json',Location:'/do-not-follow'});res.end(fixture.data??'{}');});
   const response=await post({commands:{open:[{ref_id:'private-url'}]}});assert.equal(response.status,502);
   assert.match((await response.json()).error.message,/endpoint may have changed/i);assert.equal(hits,1);
   assert.ok(!JSON.stringify(logs).includes('private-'));
  });
 }
});

test('malformed input and upstream timeouts do not leak payloads into logs',async t=>{
 const {post,logs}=await setup(t,()=>{}, {searchTimeoutMs:30});
 const invalid=await post(null,{},'{"commands":{"search_query":"private-query');assert.equal(invalid.status,400);
 assert.equal((await post({commands:{search_query:[{q:'private-query'}]}})).status,502);
 assert.ok(!JSON.stringify(logs).includes('private-query'));
});

test('web search is off unless the bridge opts in, and then nothing is forwarded',async t=>{
 let hits=0;const {post}=await setup(t,(req,res)=>{hits++;res.end('{}');},{webSearch:false});
 const response=await post({commands:{search_query:[{q:'fixture'}]}});
 assert.equal(response.status,404);assert.match((await response.json()).error.message,/Web search is turned off for this bridge\. Run setup again with --web-search/);
 assert.equal(hits,0);
});
