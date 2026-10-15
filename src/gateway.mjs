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
import {digest, uid, isBridgeId, checkpointText} from './protocol.mjs';
import {catalogEntries, pickTemplate} from './catalog.mjs';
import {labeled} from './models.mjs';

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

// Prepares the input of a GPT-bound request. A Claude checkpoint becomes its
// plain summary, because only the bridge can open it, and items Claude wrote
// lose their bridge-made ids, which OpenAI may otherwise look up in storage
// and reject. A search Claude ran through the bridge is left out: OpenAI has
// no record of it, and Claude's own messages carry what it found.
// Returns null when nothing changed.
export function prepareForOpenAI(input,token) {
  if(!Array.isArray(input))return null;
  let checkpoints=0,ids=0;
  const out=input.filter(x=>!(x?.type==='web_search_call'&&isBridgeId(x.id)&&++ids)).map(x=>{
    if(['compaction','context_compaction'].includes(x?.type)&&String(x.encrypted_content??'').startsWith(BRIDGE_CHECKPOINT)) {
      checkpoints++;
      return {type:'message',role:'user',content:[{type:'input_text',text:checkpointText(x.encrypted_content,token)}]};
    }
    if(!isBridgeId(x?.id))return x;
    ids++;
    const {id,...rest}=x;return rest;
  });
  return checkpoints||ids?{input:out,checkpoints,ids}:null;
}

function logPrepared(log,prepared,transport) {
  if(prepared.checkpoints)log('checkpoint_opened_for_gpt',{transport});
  if(prepared.ids)log('claude_ids_removed_for_gpt',{transport,items:prepared.ids});
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
    let clientClosed=false;
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
      // Destroying the upstream request after the app hung up also lands here.
      if(clientClosed)log('gateway_client_closed',{method:req.method,path:url.pathname});
      else log('gateway_upstream_error',{code:error.code,method:req.method,path:url.pathname});
      if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'The bridge could not reach OpenAI ('+(error.code??'network error')+').'}}));}
      else res.destroy();
      resolve();
    });
    res.on('close',()=>{if(!res.writableFinished){clientClosed=true;upstream.destroy();}});
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
  abort(){if(!this.writableEnded){this.destroyed=true;this.emit('close');}}
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
    // An interrupt ends the response at once, but the app can send the next
    // request in the same packet, before the channel has released it.
    while(this.res?.writableEnded)await this.busy;
    if(this.res)return this.error(409,'A Claude response is already streaming on this connection.');
    const {type,previous_response_id:previous,generate,client_metadata,...body}=message;const metadata=client_metadata??{};
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
    let release;this.busy=new Promise(resolve=>{release=resolve;});
    try{await this.serve({headers,method:'POST',gateway:'websocket'},res,{...body,input,stream:true});}
    catch(error){if(!res.writableEnded){res.statusCode=error.statusCode??500;res.end(JSON.stringify({error:{message:error.message}}));}}
    await res.done;
    this.last=res.responseId?{id:res.responseId,input,output:res.output}:null;
    this.res=null;release();
  }
  interrupt(){this.res?.abort();}
}

export function createGateway({bridge,key,upstream=GATEWAY_UPSTREAM,serve,log=()=>{}}) {
  // Entries are named after the model each alias last started, and the tag
  // changes with the names, so the app downloads the list again.
  const current=()=>labeled(bridge.models,bridge.startedModels);
  const tagNow=()=>catalogTag(current());
  // GPT responses in flight, so an install or restart can wait for them.
  let active=0;
  const track=promise=>{active++;return Promise.resolve(promise).finally(()=>{active--;});};
  // The app's side of each connection takes the subprotocol OpenAI accepted.
  const protocols=new WeakMap();
  const wss=new WebSocketServer({noServer:true,perMessageDeflate:true,maxPayload:256*1024*1024,handleProtocols:(offered,req)=>protocols.get(req)||false});
  const handshakeHeaders=new WeakMap();
  wss.on('headers',(headers,req)=>{const extra=handshakeHeaders.get(req);if(extra)headers.push(...extra);});

  function models(status,headers,body) {
    if(status!==200)return {status,headers,body};
    try {
      const data=JSON.parse(body.toString());
      if(!Array.isArray(data.models))return {status,headers,body};
      delete headers['content-encoding'];
      return {status,headers,body:Buffer.from(JSON.stringify({...data,models:withClaudeModels(data.models,current())}))};
    } catch {return {status,headers,body};}
  }

  // HTTP: Claude requests are answered here, everything else goes to OpenAI.
  async function handleHttp(req,res,sub,url,raw,decoded) {
    const target=upstream+sub+url.search;
    if(req.method==='POST'&&sub==='/responses'&&decoded&&bridge.models.get(decoded.model))return serve({headers:req.headers,method:req.method,gateway:'http'},res,decoded);
    if(req.method==='GET'&&sub==='/models')return relayHttp(req,res,target,null,{tag:tagNow(),finish:models,log});
    let body=raw;
    if(req.method==='POST'&&sub.startsWith('/responses')&&decoded) {
      const prepared=prepareForOpenAI(decoded.input,bridge.token);
      if(prepared){body=Buffer.from(JSON.stringify({...decoded,input:prepared.input}));delete req.headers['content-encoding'];logPrepared(log,prepared,'http');}
    }
    return track(relayHttp(req,res,target,body,{tag:tagNow(),log}));
  }

  // WebSocket: OpenAI is connected first, so the handshake headers the app
  // reads (turn state, server model, reasoning) arrive as before.
  function handleUpgrade(req,socket,head,sub,url) {
    const fail=(status,text)=>{socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
    const target=new URL(upstream.replace(/^http/,'ws')+sub+url.search);
    const offered=[...new Set(String(req.headers['sec-websocket-protocol']??'').split(',').map(x=>x.trim()).filter(Boolean))];
    const up=new WebSocket(target,offered.length?offered:undefined,{headers:forwardHeaders(req.headers,HANDSHAKE),perMessageDeflate:true,handshakeTimeout:15000,maxPayload:256*1024*1024});
    let settled=false,extra=[];
    up.on('upgrade',response=>{
      for(const [name,value] of Object.entries(response.headers)) {
        if(HANDSHAKE.has(name)||name==='set-cookie'||name==='date'||name==='server')continue;
        for(const v of [value].flat())extra.push(`${name}: ${name==='x-models-etag'?tagEtag(v,tagNow()):v}`);
      }
    });
    // A refusal, such as an expired login or a usage limit, reaches the app
    // with OpenAI's explanation. The body is read in full before the upstream
    // request is closed, and a body that never ends is cut off.
    up.on('unexpected-response',(request,response)=>{
      settled=true;const chunks=[];let sent=false;
      const send=()=>{
        if(sent)return;sent=true;clearTimeout(timer);
        const body=Buffer.concat(chunks);
        const lines=[`HTTP/1.1 ${response.statusCode} ${response.statusMessage??''}`];
        for(const [name,value] of Object.entries(response.headers))if(!HOP.has(name))for(const v of [value].flat())lines.push(`${name}: ${v}`);
        lines.push('Connection: close','Content-Length: '+body.length,'','');
        socket.end(Buffer.concat([Buffer.from(lines.join('\r\n')),body]));
        log('gateway_ws_refused',{status:response.statusCode});
        request.destroy();
      };
      const timer=setTimeout(send,10000);
      response.on('data',c=>chunks.push(c));
      response.on('end',send);response.on('error',send);response.on('aborted',send);
    });
    up.on('error',error=>{if(!settled){settled=true;log('gateway_upstream_error',{code:error.code,transport:'websocket'});fail(502,'Bad Gateway');}});
    let handed=false,gone=false;
    up.on('open',()=>{
      settled=true;handshakeHeaders.set(req,extra);if(up.protocol)protocols.set(req,up.protocol);
      if(gone||socket.destroyed){up.terminate();socket.destroy();return;}
      handed=true;wss.handleUpgrade(req,socket,head,client=>sub==='/responses'?relay(client,up,req):pipe(client,up,sub));
    });
    socket.on('error',()=>up.terminate());
    // The app gave up before OpenAI answered: nothing else would close OpenAI's side.
    const leave=()=>{if(handed)return;gone=true;up.terminate();socket.destroy();};
    socket.on('end',leave);socket.on('close',leave);
  }

  function relay(client,up,req) {
    const claude=new ClaudeChannel({client,req,serve,log});
    // last is the kind of model the app last asked for on this connection.
    let upClosed=null,pending=0,last=null;const opened=Date.now();
    const settle=count=>{active-=count;pending-=count;};
    const closeClient=()=>{const {code,reason}=upClosed??{code:1000,reason:''};try{client.close(code>=1000&&code<5000&&![1004,1005,1006].includes(code)?code:1000,reason);}catch{client.terminate();}};
    // An error here would end the whole bridge, and with it every chat.
    client.on('message',(data,isBinary)=>{try{
      let message=null;
      if(!isBinary)try{message=JSON.parse(data.toString());}catch{}
      if(message?.type==='response.create'&&bridge.models.get(message.model)) {
        last='claude';
        claude.create(message).catch(error=>{log('gateway_ws_error',{message:error.message});claude.res=null;claude.error(500,'The bridge could not answer this request: '+error.message);});
        return;
      }
      if(message?.type==='response.interrupt'&&claude.owns(message.response_id)){claude.interrupt();return;}
      // OpenAI's side closed while Claude had the connection. Closing the app's
      // side makes the app send the GPT request again on a new connection.
      if(up.readyState!==WebSocket.OPEN) {
        if(message?.type==='response.create'){log('gateway_ws_reconnect_for_gpt',{});closeClient();}
        return;
      }
      if(message?.type==='response.create') {
        last='gpt';
        const prepared=prepareForOpenAI(message.input,bridge.token);
        if(prepared){data=Buffer.from(JSON.stringify({...message,input:prepared.input}));logPrepared(log,prepared,'websocket');}
        pending++;active++;
      }
      up.send(data,{binary:isBinary});
    }catch(error){
      log('gateway_ws_error',{message:error.message});
      if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'error',status:500,error:{type:'server_error',message:'The bridge could not relay this request: '+error.message}}));
    }});
    up.on('message',(data,isBinary)=>{
      const head=isBinary?'':data.toString().slice(0,200);
      // With no GPT request waiting, nothing OpenAI sends belongs to a Claude
      // connection, and the app would read it as part of Claude's next response.
      if(!pending&&last==='claude'){log('gateway_ws_openai_message_dropped',{type:/"type"\s*:\s*"([^"]{1,80})"/.exec(head)?.[1]??null});return;}
      if(pending&&/"type"\s*:\s*"(response\.(completed|failed|incomplete)|error)"/.test(head))settle(1);
      if(!isBinary&&data.includes('x-models-etag'))try{
        const event=JSON.parse(data.toString());const headers=event.headers;
        if(headers&&typeof headers==='object')for(const name of Object.keys(headers))if(name.toLowerCase()==='x-models-etag')headers[name]=tagEtag(headers[name],tagNow());
        data=Buffer.from(JSON.stringify(event));
      }catch{}
      if(client.readyState===WebSocket.OPEN)client.send(data,{binary:isBinary});
    });
    // OpenAI closes idle connections, and Claude's turns leave this one idle.
    // Claude answers without OpenAI, so the app's side stays open when Claude
    // was last asked; otherwise it follows OpenAI's, as without the bridge.
    up.on('close',(code,reason)=>{
      upClosed={code,reason};const gptPending=pending;settle(pending);
      if(client.readyState!==WebSocket.OPEN)return;
      const kept=last==='claude';
      log('gateway_ws_openai_closed',{code,reason:String(reason??'').slice(0,200),open_s:Math.round((Date.now()-opened)/1000),gpt_pending:gptPending,kept_open:kept});
      if(!kept)closeClient();
    });
    client.on('close',()=>{settle(pending);claude.interrupt();if(up.readyState===WebSocket.OPEN||up.readyState===WebSocket.CONNECTING)up.close();});
    up.on('error',()=>{});client.on('error',()=>{});
  }

  // Other WebSockets on the Codex route, such as voice, go to OpenAI unchanged.
  function pipe(client,up,sub) {
    log('gateway_ws_relayed',{path:sub});
    const code=c=>c>=1000&&c<5000&&![1004,1005,1006].includes(c)?c:1000;
    up.on('message',(data,isBinary)=>{if(client.readyState===WebSocket.OPEN)client.send(data,{binary:isBinary});});
    client.on('message',(data,isBinary)=>{if(up.readyState===WebSocket.OPEN)up.send(data,{binary:isBinary});});
    up.on('close',(c,reason)=>{try{client.close(code(c),reason);}catch{client.terminate();}});
    client.on('close',(c,reason)=>{if(up.readyState===WebSocket.OPEN)up.close(code(c),reason);else if(up.readyState===WebSocket.CONNECTING)up.terminate();});
    up.on('error',()=>{});client.on('error',()=>{});
  }

  return {get tag(){return tagNow();},handleHttp,handleUpgrade,active:()=>active,close:()=>{for(const c of wss.clients)c.terminate();wss.close();}};
}
