import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startBridge} from '../src/server.mjs';
import {uid} from '../src/protocol.mjs';
import {pickerSearch, searchAction, searchContext} from '../src/search.mjs';

const fixture=fileURLToPath(new URL('./fake-claude.mjs',import.meta.url));fs.chmodSync(fixture,0o755);
const KEY='fixture-gateway-key';
const TOKEN='Bearer chatgpt-fixture-token';
const events=text=>text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
const user=(text,id)=>({type:'message',id,role:'user',content:[{type:'input_text',text}]});
const exec={type:'custom',name:'exec',description:'test'};
const webSearch={type:'web_search',external_web_access:true,user_location:{type:'approximate',country:'CA'}};

// Stand-ins for OpenAI: the Codex backend GPT goes to, and the search endpoint.
async function listen(t,handler) {
  const seen=[];
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();seen.push({method:req.method,url:req.url,headers:req.headers,body});await handler(req,res,body);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {seen,url:`http://127.0.0.1:${server.address().port}`};
}
async function setup(t,{search=(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({output:'Fixture result: the answer is 42 [wordlim 50]',results:[{type:'text_result',ref_id:'turn0search0'}]}));}}={}) {
  const openai=await listen(t,(req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gpt","output":[]}}\n\n');
  });
  const searcher=await listen(t,search);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-picker-search-'));const logs=[];
  const bridge=await startBridge({stateDir:dir,token:'fixture-secret',port:0,claude:fixture,gatewayKey:KEY,gatewayUpstream:openai.url+'/backend-api/codex',searchUpstream:searcher.url+'/backend-api/codex/alpha/search',searchTimeoutMs:5000,log:(event,data)=>logs.push({event,...data})});
  t.after(async()=>{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});});
  const app={'Authorization':TOKEN,'ChatGPT-Account-Id':'acct-fixture','Content-Type':'application/json'};
  const post=async(body,headers={})=>events(await(await fetch(bridge.url+'/g/'+KEY+'/backend-api/codex/responses',{method:'POST',headers:{...app,'thread-id':'thread-1',...headers},body:JSON.stringify({stream:true,...body})})).text());
  return {bridge,openai,searcher,logs,dir,post};
}
const finalText=frames=>frames.at(-1).response.output.filter(x=>x.type==='message').map(x=>x.content[0].text).join('');
const reported=frames=>JSON.parse(finalText(frames).replace(/^SEARCHED /,''));

test('picker mode gives Claude a web search tool that runs with the app\'s ChatGPT sign-in',async t=>{
  const {searcher,logs,dir,post}=await setup(t);
  const input=[user('<environment_context>cwd</environment_context>','u-env'),user('Plan my trip.','u0'),
    {type:'message',id:'msg_a',role:'assistant',content:[{type:'output_text',text:'Where to?'}]},user('web-search-tool Lisbon in May','u1')];
  const frames=await post({model:'claude-opus',input,tools:[exec,webSearch]});
  const added=frames.find(e=>e.type==='response.output_item.added'&&e.item.type==='web_search_call');
  const done=frames.find(e=>e.type==='response.output_item.done'&&e.item.type==='web_search_call');
  assert.deepEqual(added.item.action,{type:'search',query:'bridge fixture query'});
  assert.equal(added.item.status,'in_progress');assert.equal(done.item.status,'completed');assert.equal(done.item.id,added.item.id);
  assert.ok(frames.indexOf(done)<frames.findIndex(e=>e.type==='response.completed'));
  const out=frames.at(-1).response.output;
  assert.equal(out.some(x=>['function_call','custom_tool_call'].includes(x.type)),false);
  const report=reported(frames);
  assert.equal(report.found.content[0].text,'Fixture result: the answer is 42 [wordlim 50]');assert.equal(report.found.isError,undefined);
  assert.ok(report.tools.includes('web_run'));assert.equal(report.prompt,true);
  // The request matches the app's own web.run: thread id, model, conversation tail, settings.
  assert.equal(searcher.seen.length,1);const sent=searcher.seen[0];
  assert.equal(sent.method,'POST');assert.equal(sent.url,'/backend-api/codex/alpha/search');
  assert.equal(sent.headers.authorization,TOKEN);assert.equal(sent.headers['chatgpt-account-id'],'acct-fixture');assert.equal(sent.headers.originator,'codex_cli_rs');
  assert.equal(sent.headers['x-claude-bridge-key'],undefined);
  assert.deepEqual(JSON.parse(sent.body),{id:'thread-1',model:'claude-opus',
    input:[{type:'message',role:'user',content:[{type:'input_text',text:'Plan my trip.'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:'Where to?'}]},{type:'message',role:'user',content:[{type:'input_text',text:'web-search-tool Lisbon in May'}]}],
    commands:{search_query:[{q:'bridge fixture query'}]},settings:{allowed_callers:['direct'],external_web_access:true,user_location:{type:'approximate',country:'CA'}},max_output_tokens:10000});
  assert.deepEqual(logs.filter(x=>x.event==='bridge_search').map(x=>[x.status,x.commands]),[[200,['search_query']]]);
  // The sign-in stays in memory: not in the log or any file the bridge writes.
  assert.equal(JSON.stringify(logs).includes('chatgpt-fixture-token'),false);
  const files=fs.readdirSync(dir,{recursive:true}).map(f=>path.join(dir,f)).filter(f=>fs.statSync(f).isFile());
  assert.ok(files.length);for(const f of files)assert.equal(fs.readFileSync(f).includes('chatgpt-fixture-token'),false,f);
});

test('the next turn resumes with the search in history, whether or not the app keeps the item',async t=>{
  for(const keep of [true,false]) {
    const {logs,post}=await setup(t);
    const input=[user('web-search-tool first','u1')];
    const first=await post({model:'claude-opus',input,tools:[exec,webSearch]});
    const output=first.at(-1).response.output.filter(x=>keep||x.type!=='web_search_call');
    assert.equal(output.some(x=>x.type==='web_search_call'),keep);
    const second=await post({model:'claude-opus',input:[...input,...output,user('echo-input next','u2')],tools:[exec,webSearch]});
    assert.match(finalText(second),/ECHO .*next/);
    const starts=logs.filter(x=>x.event==='claude_start');
    assert.deepEqual(starts.map(x=>x.resume),[false,true],'keep='+keep);
    assert.equal(logs.some(x=>['other_model_turns','regeneration_rebuilt','instructions_changed'].includes(x.event)),false,'keep='+keep);
  }
});

test('a search still running when Claude also calls a host tool finishes and is shown as done',async t=>{
  const {post,logs}=await setup(t,{search:async(req,res)=>{await new Promise(r=>setTimeout(r,400));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({output:'late result'}));}});
  const input=[user('web-search-tool with-exec','u1')];
  const first=await post({model:'claude-opus',input,tools:[exec,webSearch]});
  const out=first.at(-1).response.output;const call=out.find(x=>x.type==='custom_tool_call');
  assert.equal(call.name,'exec');
  const search=out.find(x=>x.type==='web_search_call');assert.equal(search.status,'completed');
  const second=await post({model:'claude-opus',input:[...input,...out,{type:'custom_tool_call_output',call_id:call.call_id,output:'side done'}],tools:[exec,webSearch]});
  const report=reported(second);
  assert.equal(report.found.content[0].text,'late result');assert.match(JSON.stringify(report.side),/side done/);
  assert.equal(logs.filter(x=>x.event==='bridge_search').length,1);
});

test('search errors reach Claude as tool errors, without credentials',async t=>{
  for(const [status,body,type,expected] of [[401,'{"error":"expired"}','application/json',/login expired.*Sign in to ChatGPT again/],
    [200,'{"results":[]}','application/json',/incompatible response/],[200,'<html>','text/html',/non-JSON/],[500,'{}','application/json',/HTTP 500/]]) {
    const {post,logs}=await setup(t,{search:(req,res)=>{res.writeHead(status,{'Content-Type':type});res.end(body);}});
    const report=reported(await post({model:'claude-sonnet',input:[user('web-search-tool','u1')],tools:[exec,webSearch]}));
    assert.equal(report.found.isError,true);assert.match(report.found.content[0].text,expected);
    assert.equal(JSON.stringify(report).includes('chatgpt-fixture-token'),false);
    assert.equal(logs.find(x=>x.event==='bridge_search').status,status===200?502:status);
  }
});

test('Claude gets no search tool when the app offers no web search or no ChatGPT sign-in',async t=>{
  const {post,searcher}=await setup(t);
  const probe=async(tools,headers,thread)=>JSON.parse(finalText(await post({model:'claude-opus',input:[user('model-probe','u1')],tools},{'thread-id':thread,...headers})).replace(/^MODEL /,'')).webSearch;
  assert.equal(await probe([exec,webSearch],{},'t-on'),true);
  assert.equal(await probe([exec],{},'t-off'),false);
  assert.equal(await probe([exec,webSearch],{'Authorization':''},'t-anon'),false);
  assert.equal(searcher.seen.length,0);
});

test('GPT requests leave out the searches the bridge ran for Claude',async t=>{
  const {openai,post}=await setup(t);
  const mine={type:'web_search_call',id:uid('ws'),status:'completed',action:{type:'search',query:'claude'}};
  const gpts={type:'web_search_call',id:'ws_0123',status:'completed',action:{type:'search',query:'gpt'}};
  await post({model:'gpt-fixture',input:[user('hi','u1'),mine,gpts,user('again','u2')],tools:[exec,webSearch]});
  const sent=JSON.parse(openai.seen[0].body).input;
  assert.deepEqual(sent.filter(x=>x.type==='web_search_call').map(x=>x.id),['ws_0123']);
  assert.equal(sent.length,3);
});

test('unknown commands and null values are left out of the search, as the app\'s web.run does',async t=>{
  const {searcher}=await setup(t);
  const {runSearch}=await import('../src/search.mjs');
  const result=await runSearch({auth:{authorization:TOKEN,thread:'t',model:'claude-opus',settings:{allowed_callers:['direct'],external_web_access:false}},
    commands:{search_query:[{q:'a',recency:null},null],source:'x',response_length:'medium',open:null},upstream:searcher.url+'/s',timeoutMs:5000});
  assert.equal(result.ok,true);assert.deepEqual(result.commands,['search_query']);
  assert.deepEqual(JSON.parse(searcher.seen[0].body).commands,{search_query:[{q:'a'}],response_length:'medium'});
  assert.equal((await runSearch({auth:null,commands:{}})).ok,false);
});

test('the search shown in the app follows the app\'s own web.run labels',()=>{
  assert.deepEqual(searchAction({search_query:[{q:'a'}]}),{type:'search',query:'a'});
  assert.deepEqual(searchAction({search_query:[{q:'a'},{q:'b'}],open:[{ref_id:'https://x.test'}]}),{type:'search',queries:['a','b']});
  assert.deepEqual(searchAction({image_query:[{q:'falls'}]}),{type:'search',query:'falls'});
  assert.deepEqual(searchAction({open:[{ref_id:'https://x.test/a'}]}),{type:'open_page',url:'https://x.test/a'});
  assert.deepEqual(searchAction({open:[{ref_id:'turn0search0'}],find:[{ref_id:'turn0fetch1',pattern:'p'}]}),{type:'find_in_page',pattern:'p'});
  assert.deepEqual(searchAction({finance:[{ticker:'AMD',type:'equity'}]}),{type:'other'});
  assert.deepEqual(searchAction(null),{type:'other'});
});

test('the search service gets the same conversation tail the app sends',()=>{
  const long='x'.repeat(6000);
  const tail=searchContext([user('one','a'),{type:'message',role:'assistant',content:[{type:'output_text',text:'r1'}]},
    user('two','b'),{type:'message',role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,AA'},{type:'input_text',text:'<turn_aborted>'}]},
    {type:'message',role:'developer',content:[{type:'input_text',text:'dev'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:long}]},
    {type:'function_call',name:'exec',arguments:'{}',call_id:'c'},user('three','c')]);
  assert.deepEqual(tail.map(m=>[m.role,m.content[0].text.length]),[['user',3],['assistant',4003],['user',5]]);
  assert.match(tail[1].content[0].text,/^x{2000}\n…\nx{2000}$/);
  assert.deepEqual(searchContext([]),[]);
});

test('the tail stops at the current message, keeps user text that starts with a tag and includes agent messages',()=>{
  const tail=searchContext([user('<div class="a"> is not centered, why?','a'),{type:'message',role:'assistant',content:[{type:'output_text',text:'Use flex.'}]},
    {type:'agent_message',author:'/root/helper',content:[{type:'input_text',text:'Checked the CSS.'}]},{type:'agent_message',author:'x',content:[{type:'encrypted_content',encrypted_content:'gAAA'}]},
    {type:'message',role:'user',content:[{type:'input_text',text:'still broken'},{type:'input_text',text:'<skill>\nname: css\n</skill>'}]},
    user('And on Safari?','b'),{type:'message',role:'assistant',content:[{type:'output_text',text:'Checking now.'}]}]);
  assert.deepEqual(tail.map(m=>m.content[0].text),['<div class="a"> is not centered, why?','Use flex.','Agent message from /root/helper:\nChecked the CSS.','And on Safari?']);
});

test('a Stop ends a running search',async t=>{
  let closed=null;
  const {bridge,logs}=await setup(t,{search:(req,res)=>{req.socket.on('close',()=>{closed??=Date.now();});setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"output":"too late"}');}},8000);}});
  const abort=new AbortController();
  const response=await fetch(bridge.url+'/g/'+KEY+'/backend-api/codex/responses',{method:'POST',signal:abort.signal,headers:{'Authorization':TOKEN,'Content-Type':'application/json','thread-id':'thread-stop'},
    body:JSON.stringify({model:'claude-opus',stream:true,input:[user('web-search-tool','u1')],tools:[exec,webSearch]})});
  const reader=response.body.getReader();
  for(let i=0;i<100&&!logs.some(x=>x.event==='tool_call'||x.event==='claude_ready');i++)await new Promise(r=>setTimeout(r,20));
  await new Promise(r=>setTimeout(r,300));const stopped=Date.now();abort.abort();await reader.read().catch(()=>{});
  for(let i=0;i<150&&!logs.some(x=>x.event==='bridge_search');i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(closed&&closed-stopped<2000,'the search request was not ended by the Stop');
  assert.notEqual(logs.find(x=>x.event==='bridge_search')?.status,200);
});

test('the app\'s web search settings carry over: cached by default, live, indexed, location and domains',()=>{
  const headers={authorization:TOKEN,'chatgpt-account-id':'acct'};
  assert.deepEqual(pickerSearch([{type:'web_search'}],headers,'secret').settings,{allowed_callers:['direct'],external_web_access:false});
  assert.deepEqual(pickerSearch([{type:'web_search',external_web_access:true,indexed_web_access:true,search_context_size:'high',filters:{allowed_domains:['a.test']}}],headers,'secret').settings,
    {allowed_callers:['direct'],external_web_access:'indexed',search_context_size:'high',filters:{allowed_domains:['a.test']}});
  assert.equal(pickerSearch([{type:'image_generation'}],headers,'secret'),null);
  assert.equal(pickerSearch([{type:'web_search'}],{authorization:'Bearer secret'},'secret'),null);
  assert.equal(pickerSearch([{type:'web_search'}],{},'secret'),null);
  assert.equal(pickerSearch([{type:'web_search'}],headers,'secret').accountId,'acct');
});
