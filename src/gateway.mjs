// Picker mode. The ChatGPT app's built-in OpenAI provider is pointed at the
// bridge with openai_base_url, so GPT keeps its own provider, login, WebSocket
// transport, remote compaction and backend routes. The bridge relays GPT
// traffic to OpenAI unchanged and answers requests for a catalog Claude model
// itself. Paths carry a private key: /g/<key>/backend-api/codex/...
import http from 'node:http';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {timingSafeEqual} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';
import {digest, uid, openCheckpoint} from './protocol.mjs';
import {catalogEntries, pickTemplate} from './catalog.mjs';

export const GATEWAY_UPSTREAM='https://chatgpt.com/backend-api/codex';
const ROUTE='/backend-api/codex';
const HOP=new Set(['connection','keep-alive','proxy-connection','transfer-encoding','upgrade','te','trailer','proxy-authorization','proxy-authenticate','host','content-length']);
const HANDSHAKE=new Set([...HOP,'sec-websocket-key','sec-websocket-version','sec-websocket-extensions','sec-websocket-protocol','sec-websocket-accept']);
export const BRIDGE_CHECKPOINT='claude-bridge-v1:';

// The subpath after /backend-api/codex for a request carrying the right key,
// '' for the route itself, or null.
export function gatewayPath(pathname,key) {
  const match=/^\/g\/([^/]+)(\/.*)?$/.exec(pathname);
  if(!match||!key)return null;
  const given=Buffer.from(match[1]),expected=Buffer.from(key);
  if(given.length!==expected.length||!timingSafeEqual(given,expected))return null;
  const rest=match[2]??'';
  if(rest!==ROUTE&&!rest.startsWith(ROUTE+'/'))return null;
  return rest.slice(ROUTE.length);
}

// The model list the app caches carries the Claude entries, so its ETag must
// differ from OpenAI's, and the app's own copy is tagged back on the way out.
export const catalogTag=models=>'claude-'+digest(models.list.map(m=>[m.slug,m.claude_model,m.display_name,m.description,m.efforts,m.default_effort,m.context_window])).slice(0,10);
export const tagEtag=(etag,tag)=>typeof etag!=='string'||!etag?etag:etag.endsWith('"')?etag.slice(0,-1)+'-'+tag+'"':etag+'-'+tag;
export const untagEtag=(etag,tag)=>typeof etag!=='string'?etag:etag.split('-'+tag).join('');

export function withClaudeModels(list,models) {
  const template=pickTemplate(list);
  if(!template)return list;
  const own=new Set(models.list.map(m=>m.slug));
  const kept=list.filter(m=>!own.has(m?.slug));
  const last=Math.max(0,...kept.map(m=>Number(m?.priority)||0));
  return [...kept,...catalogEntries(template,models,{priorityStart:last+1})];
}

// A Claude checkpoint in a GPT-bound request becomes its plain summary,
// because only the bridge can open it. Returns null when nothing changed.
export function openBridgeCheckpoints(input,token) {
  if(!Array.isArray(input))return null;
  let changed=false;
  const out=input.map(x=>{
    if(!['compaction','context_compaction'].includes(x?.type)||!String(x.encrypted_content??'').startsWith(BRIDGE_CHECKPOINT))return x;
    changed=true;
    return {type:'message',role:'user',content:[{type:'input_text',text:'<context_checkpoint>\n'+openCheckpoint(x.encrypted_content,token)+'\n</context_checkpoint>\nContinue the existing task from this checkpoint.'}]};
  });
  return changed?out:null;
}

function forwardHeaders(source,drop,host) {
  const headers={};
  for(const [name,value] of Object.entries(source))if(!drop.has(name))headers[name]=value;
  if(host)headers.host=host;
  return headers;
}

// Relays one HTTP request to OpenAI. finish(status,headers,body) may replace
// a complete response body (the model list); otherwise the response streams.
export function relayHttp(req,res,target,body,{tag,finish,log=()=>{}}={}) {
  const url=new URL(target);
  const headers=forwardHeaders(req.headers,HOP,url.host);
  if(headers['if-none-match']&&tag)headers['if-none-match']=untagEtag(headers['if-none-match'],tag);
  if(finish)headers['accept-encoding']='identity';
  if(body)headers['content-length']=String(body.length);
  return new Promise(resolve=>{
    const upstream=(url.protocol==='https:'?https:http).request(url,{method:req.method,headers},response=>{
      const out=forwardHeaders(response.headers,new Set([...HOP].filter(x=>x!=='content-length')));
      if(tag){
        if(out['x-models-etag'])out['x-models-etag']=tagEtag(out['x-models-etag'],tag);
        if(finish&&out.etag)out.etag=tagEtag(out.etag,tag);
      }
      if(!finish){res.writeHead(response.statusCode,out);response.pipe(res);response.on('end',resolve);response.on('error',()=>{res.destroy();resolve();});return;}
      const chunks=[];response.on('data',c=>chunks.push(c));
      response.on('end',()=>{
        const result=finish(response.statusCode,out,Buffer.concat(chunks));
        if(result.body)result.headers['content-length']=String(result.body.length);
        res.writeHead(result.status,result.headers);res.end(result.body);resolve();
      });
      response.on('error',()=>{res.destroy();resolve();});
    });
    upstream.on('error',error=>{
      log('gateway_upstream_error',{code:error.code});
      if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'The bridge could not reach OpenAI ('+(error.code??'network error')+').'}}));}
      else res.destroy();
      resolve();
    });
    res.on('close',()=>{if(!res.writableFinished)upstream.destroy();});
    upstream.end(body??undefined);
  });
}

// Stands in for an HTTP response when Claude answers over the app's
// WebSocket: each SSE frame becomes one WebSocket message.
export class WsResponse extends EventEmitter {
  constructor(ws) {
    super();this.ws=ws;this.statusCode=200;this.headersSent=false;this.writableEnded=false;this.writableFinished=false;this.destroyed=false;
    this.responseId=null;this.output=[];this.terminal=false;this.pending='';this.done=new Promise(resolve=>{this.resolveDone=resolve;});
  }
  send(value){if(this.ws.readyState===WebSocket.OPEN)this.ws.send(typeof value==='string'?value:JSON.stringify(value));}
  writeHead(status){this.statusCode=status;this.headersSent=true;return this;}
  write(chunk) {
    this.headersSent=true;this.pending+=chunk.toString();
    for(let end=this.pending.indexOf('\n\n');end>=0;end=this.pending.indexOf('\n\n')) {
      const frame=this.pending.slice(0,end);this.pending=this.pending.slice(end+2);
      const line=frame.split('\n').find(x=>x.startsWith('data: '));if(!line)continue;
      const data=line.slice(6);let event;try{event=JSON.parse(data);}catch{continue;}
      if(event.type==='response.created')this.responseId=event.response?.id??this.responseId;
      if(event.type==='response.output_item.done'&&event.item)this.output.push(event.item);
      if(['response.completed','response.failed','response.incomplete'].includes(event.type))this.terminal=true;
      if(event.type==='response.completed'&&Array.isArray(event.response?.output))this.output=event.response.output;
      this.send(data);
    }
    return true;
  }
  end(chunk) {
    if(this.writableEnded)return this;
    if(chunk!=null) {
      const text=chunk.toString();
      if(this.statusCode>=400||!text.includes('data: ')) {
        let message=text;try{message=JSON.parse(text).error?.message??text;}catch{}
        this.send({type:'error',status:this.statusCode>=400?this.statusCode:500,error:{type:'invalid_request_error',message}});this.terminal=true;
      } else this.write(text);
    }
    // A stopped Claude turn still owes the app a terminal event.
    if(!this.terminal&&this.responseId)this.send({type:'response.incomplete',response:{id:this.responseId,object:'response',status:'incomplete',output:[],incomplete_details:{reason:'interrupted'}}});
    this.writableEnded=this.writableFinished=true;this.emit('finish');this.resolveDone();
    return this;
  }
  destroy(){this.destroyed=true;this.end();}
  // The app interrupted or closed the connection: like a closed HTTP stream.
  abort(){if(!this.writableEnded)this.emit('close');}
}

// Claude's side of one app WebSocket. The app sends a response.create per
// request; after the first, it sends only new items with previous_response_id.
class ClaudeChannel {
  constructor({client,req,serve,log}) {this.client=client;this.req=req;this.serve=serve;this.log=log;this.last=null;this.res=null;}
  owns(id){return !!this.res&&(!id||this.res.responseId===id);}
  error(status,message,code) {
    if(this.client.readyState===WebSocket.OPEN)this.client.send(JSON.stringify({type:'error',status,error:{type:'invalid_request_error',code,message}}));
  }
  async create(message) {
    if(this.res)return this.error(409,'A Claude response is already streaming on this connection.');
    const {type,previous_response_id:previous,generate,client_metadata:metadata={},...body}=message;
    let input=Array.isArray(body.input)?body.input:[];
    if(previous) {
      if(this.last?.id!==previous)return this.error(400,'The previous Claude response is not on this connection.','previous_response_not_found');
      input=[...this.last.input,...this.last.output,...input];
    }
    // A prewarm opens the connection without inference.
    if(generate===false) {
      const id=uid('resp'),response={id,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',output:[]};
      this.client.send(JSON.stringify({type:'response.created',response:{...response,status:'in_progress'}}));
      this.client.send(JSON.stringify({type:'response.completed',response:{...response,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}));
      this.last={id,input,output:[]};return;
    }
    const headers={...this.req.headers};
    if(metadata['x-codex-turn-metadata'])headers['x-codex-turn-metadata']=metadata['x-codex-turn-metadata'];
    if(metadata.thread_id)headers['thread-id']=metadata.thread_id;
    const res=new WsResponse(this.client);this.res=res;
    try{await this.serve({headers,method:'POST',gateway:'websocket'},res,{...body,input,stream:true});}
    catch(error){if(!res.writableEnded){res.statusCode=error.statusCode??500;res.end(JSON.stringify({error:{message:error.message}}));}}
    await res.done;
    this.last=res.responseId?{id:res.responseId,input,output:res.output}:null;
    this.res=null;this.onIdle?.();
  }
  interrupt(){this.res?.abort();}
}

export function createGateway({bridge,key,upstream=GATEWAY_UPSTREAM,serve,log=()=>{}}) {
  const tag=catalogTag(bridge.models);
  // GPT responses in flight, so an install or restart can wait for them.
  let active=0;
  const track=promise=>{active++;return Promise.resolve(promise).finally(()=>{active--;});};
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:true,maxPayload:256*1024*1024});
  const handshakeHeaders=new WeakMap();
  wss.on('headers',(headers,req)=>{const extra=handshakeHeaders.get(req);if(extra)headers.push(...extra);});

  function models(status,headers,body) {
    if(status!==200)return {status,headers,body};
    try {
      const data=JSON.parse(body.toString());
      if(!Array.isArray(data.models))return {status,headers,body};
      delete headers['content-encoding'];
      return {status,headers,body:Buffer.from(JSON.stringify({...data,models:withClaudeModels(data.models,bridge.models)}))};
    } catch {return {status,headers,body};}
  }

  // HTTP: Claude requests are answered here, everything else goes to OpenAI.
  async function handleHttp(req,res,sub,url,raw,decoded) {
    const target=upstream+sub+url.search;
    if(req.method==='POST'&&sub==='/responses'&&decoded&&bridge.models.get(decoded.model))return serve({headers:req.headers,method:req.method,gateway:'http'},res,decoded);
    if(req.method==='GET'&&sub==='/models')return relayHttp(req,res,target,null,{tag,finish:models,log});
    let body=raw;
    if(req.method==='POST'&&sub==='/responses'&&decoded) {
      const input=openBridgeCheckpoints(decoded.input,bridge.token);
      if(input){body=Buffer.from(JSON.stringify({...decoded,input}));delete req.headers['content-encoding'];log('checkpoint_opened_for_gpt',{transport:'http'});}
    }
    return track(relayHttp(req,res,target,body,{tag,log}));
  }

  // WebSocket: OpenAI is connected first, so the handshake headers the app
  // reads (turn state, server model, reasoning) arrive as before.
  function handleUpgrade(req,socket,head,sub,url) {
    const fail=(status,text)=>{socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
    if(sub!=='/responses')return fail(404,'Not Found');
    const target=new URL(upstream.replace(/^http/,'ws')+'/responses'+url.search);
    const up=new WebSocket(target,{headers:forwardHeaders(req.headers,HANDSHAKE),perMessageDeflate:true,handshakeTimeout:15000,maxPayload:256*1024*1024});
    let settled=false,extra=[];
    up.on('upgrade',response=>{
      for(const [name,value] of Object.entries(response.headers)) {
        if(HANDSHAKE.has(name)||name==='set-cookie'||name==='date'||name==='server')continue;
        for(const v of [value].flat())extra.push(`${name}: ${name==='x-models-etag'?tagEtag(v,tag):v}`);
      }
    });
    up.on('unexpected-response',(request,response)=>{
      settled=true;const chunks=[];
      response.on('data',c=>chunks.push(c));
      response.on('end',()=>{
        const body=Buffer.concat(chunks);
        const lines=[`HTTP/1.1 ${response.statusCode} ${response.statusMessage??''}`];
        for(const [name,value] of Object.entries(response.headers))if(!HOP.has(name))for(const v of [value].flat())lines.push(`${name}: ${v}`);
        lines.push('Connection: close','Content-Length: '+body.length,'','');
        socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')),body]));
        log('gateway_ws_refused',{status:response.statusCode});
      });
      request.destroy();
    });
    up.on('error',error=>{if(!settled){settled=true;log('gateway_upstream_error',{code:error.code,transport:'websocket'});fail(502,'Bad Gateway');}});
    up.on('open',()=>{
      settled=true;handshakeHeaders.set(req,extra);
      wss.handleUpgrade(req,socket,head,client=>relay(client,up,req));
    });
    socket.on('error',()=>up.terminate());
  }

  function relay(client,up,req) {
    const claude=new ClaudeChannel({client,req,serve,log});
    let upClosed=null,pending=0;
    const settle=count=>{active-=count;pending-=count;};
    client.on('message',(data,isBinary)=>{
      let message=null;
      if(!isBinary)try{message=JSON.parse(data.toString());}catch{}
      if(message?.type==='response.create'&&bridge.models.get(message.model)){claude.create(message);return;}
      if(message?.type==='response.interrupt'&&claude.owns(message.response_id)){claude.interrupt();return;}
      if(message?.type==='response.create') {
        const input=openBridgeCheckpoints(message.input,bridge.token);
        if(input){data=Buffer.from(JSON.stringify({...message,input}));log('checkpoint_opened_for_gpt',{transport:'websocket'});}
        if(up.readyState===WebSocket.OPEN){pending++;active++;}
      }
      if(up.readyState===WebSocket.OPEN)up.send(data,{binary:isBinary});
      else client.send(JSON.stringify({type:'error',status:502,error:{type:'server_error',message:'The connection to OpenAI closed. Retry the request.'}}));
    });
    up.on('message',(data,isBinary)=>{
      if(pending&&!isBinary&&/"type"\s*:\s*"(response\.(completed|failed|incomplete)|error)"/.test(data.toString().slice(0,200)))settle(1);
      if(!isBinary&&data.includes('x-models-etag'))try{
        const event=JSON.parse(data.toString());const headers=event.headers;
        if(headers&&typeof headers==='object')for(const name of Object.keys(headers))if(name.toLowerCase()==='x-models-etag')headers[name]=tagEtag(headers[name],tag);
        data=Buffer.from(JSON.stringify(event));
      }catch{}
      if(client.readyState===WebSocket.OPEN)client.send(data,{binary:isBinary});
    });
    const closeClient=()=>{try{client.close(upClosed.code>=1000&&upClosed.code<5000&&![1004,1005,1006].includes(upClosed.code)?upClosed.code:1000,upClosed.reason);}catch{client.terminate();}};
    // A Claude response finishes before the app's connection follows OpenAI's.
    up.on('close',(code,reason)=>{upClosed={code,reason};if(claude.res)claude.onIdle=closeClient;else closeClient();});
    client.on('close',()=>{settle(pending);claude.interrupt();if(up.readyState===WebSocket.OPEN||up.readyState===WebSocket.CONNECTING)up.close();});
    up.on('close',()=>settle(pending));
    up.on('error',()=>{});client.on('error',()=>{});
  }

  return {tag,handleHttp,handleUpgrade,active:()=>active,close:()=>{for(const c of wss.clients)c.terminate();wss.close();}};
}
