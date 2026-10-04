import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync, gunzipSync, inflateSync} from 'node:zlib';
import {Session} from './session.mjs';
import {createSearchHandler} from './search.mjs';
import {createGateway, gatewayPath, BRIDGE_CHECKPOINT, GATEWAY_UPSTREAM} from './gateway.mjs';
import {digest, openCheckpoint, sealCheckpoint, validateRequestOptions} from './protocol.mjs';
import {loadModels, effortFor, labelFor} from './models.mjs';
const VERSION=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const MAX_REQUEST_BYTES=256*1024*1024;
export const DEFAULT_PORT=19480;
export const AUTH_MODES=['claude_login','api_key'];

// CLAUDE_BIN wins; otherwise the first executable `claude` on PATH, then the
// usual install locations, which a LaunchAgent's short PATH can miss.
export const CLAUDE_FALLBACK_DIRS=[path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin'];
export function findClaude(env=process.env,fallbacks=CLAUDE_FALLBACK_DIRS) {
  if(env.CLAUDE_BIN)return env.CLAUDE_BIN;
  const dirs=[...(env.PATH??'').split(path.delimiter),...fallbacks];
  for(const dir of dirs.filter(Boolean)) {
    const file=path.join(dir,'claude');
    try{fs.accessSync(file,fs.constants.X_OK);if(fs.statSync(file).isFile())return file;}catch{}
  }
  throw new Error('Claude Code was not found. Install it from https://code.claude.com/docs/en/setup or set CLAUDE_BIN to its path.');
}

export async function evictIdleSessions(bridge,now=Date.now()) {
  for(const [key,session] of bridge.sessions) {
    if(session.child||session.accepting||session.exiting||session.stream||now-session.lastUsed<300000)continue;
    bridge.sessions.delete(key);
    await session.mcp?.close();
  }
}

export function pruneResponseCache(directory,now=Date.now()) {
  const entries=fs.readdirSync(directory).map(name=>{const file=path.join(directory,name);return {file,name,stat:fs.statSync(file)};}).filter(x=>x.stat.isFile()).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
  let bytes=0;
  for(const {file,name,stat} of entries) {
    bytes+=stat.size;
    if(!name.endsWith('.sealed')||now-stat.mtimeMs>86400000||bytes>256*1024*1024)fs.unlinkSync(file);
  }
}

export function pruneToolSets(directory,now=Date.now()) {
  if(!fs.existsSync(directory))return;
  for(const name of fs.readdirSync(directory)){const file=path.join(directory,name);if(now-fs.statSync(file).mtimeMs>86400000)fs.unlinkSync(file);}
}

// auth.mode claude_login runs the user's own `claude` login untouched; api_key
// passes auth.apiKey() to Claude Code as ANTHROPIC_API_KEY. The bridge never
// reads Claude Code's credentials.
// gatewayKey turns on picker mode, where the app's own OpenAI provider is
// pointed at /g/<gatewayKey>/backend-api/codex (see gateway.mjs).
export async function startBridge({stateDir,token,port=DEFAULT_PORT,claude=null,models=loadModels(),auth={mode:'claude_login'},webSearch=false,gatewayKey=null,gatewayUpstream=GATEWAY_UPSTREAM,log=()=>{},searchUpstream,searchTimeoutMs,sleepGraceMs=300000}) {
  if(!AUTH_MODES.includes(auth?.mode))throw new Error(`Unknown auth mode ${auth?.mode}. Use one of: ${AUTH_MODES.join(', ')}.`);
  if(auth.mode==='api_key'&&typeof auth.apiKey!=='function')throw new Error('API key mode needs an apiKey function.');
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  const claudeCwd=path.join(stateDir,'empty-workspace');fs.mkdirSync(claudeCwd,{recursive:true,mode:0o700});
  const cacheDir=path.join(stateDir,'response-cache');fs.mkdirSync(cacheDir,{recursive:true,mode:0o700});
  const toolSetDir=path.join(stateDir,'tool-sets');
  pruneResponseCache(cacheDir);pruneToolSets(toolSetDir);
  const cacheTimer=setInterval(()=>{try{pruneResponseCache(cacheDir);pruneToolSets(toolSetDir);}catch(error){log('cache_cleanup_error',{message:error.message});}},900000);cacheTimer.unref();
  // resolvedModels maps a catalog slug to the model Claude Code last started
  // for it, so later processes pin aliases to the same version.
  const bridge={stateDir,token,claudeCwd,log,auth,models,webSearch:!!webSearch,resolvedModels:new Map(),sleepGraceMs,sessions:new Map(),url:`http://127.0.0.1:${port}`};
  // startedModels keeps the same record across restarts, for the names the
  // picker shows only. Pinning starts empty, so an alias still follows Claude
  // Code to a new release after a restart.
  const startedFile=path.join(stateDir,'started-models.json');
  let started={};
  try{started=JSON.parse(fs.readFileSync(startedFile,'utf8'));}catch{}
  bridge.startedModels=new Map(Object.entries(started).filter(([slug,id])=>models.get(slug)&&typeof id==='string'));
  bridge.modelStarted=(slug,id)=>{
    if(bridge.startedModels.get(slug)===id)return;
    bridge.startedModels.set(slug,id);
    try{const temp=startedFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(Object.fromEntries(bridge.startedModels),null,2),{mode:0o600});fs.renameSync(temp,startedFile);}
    catch(error){log('started_models_persist_error',{message:error.message});}
  };
  bridge.label=model=>labelFor(model,bridge.startedModels.get(model.slug));
  // Looked up on first use, so a bridge without Claude Code fails per request
  // with an install hint. The service passes the path it found at startup.
  let claudePath=claude;
  Object.defineProperty(bridge,'claude',{get:()=>claudePath??=findClaude()});
  const sessionTimer=setInterval(()=>evictIdleSessions(bridge).catch(error=>log('session_cleanup_error',{message:error.message})),60000);sessionTimer.unref();
  // The desktop retains its ordinary account Authorization header. Authenticate
  // the local hop separately. Only standalone search forwards desktop auth,
  // directly to OpenAI; model inference and Claude never receive that token.
  const authenticated=req=>{const actual=Buffer.from(req.headers['x-claude-bridge-key']??req.headers.authorization??'');const expected=Buffer.from(req.headers['x-claude-bridge-key']?token:`Bearer ${token}`);return actual.length===expected.length&&timingSafeEqual(actual,expected);};
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const headerFile=path.join(stateDir,'search-header-names.json');
  let capturedHeaders=fs.existsSync(headerFile);
  const search=createSearchHandler({token,log,upstream:searchUpstream,timeoutMs:searchTimeoutMs,headerNames:names=>{
    if(capturedHeaders)return;
    fs.writeFileSync(headerFile,JSON.stringify(names),{mode:0o600});capturedHeaders=true;
    log('search_header_names',{names});
  }});
  const readBody=async req=>{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>MAX_REQUEST_BYTES)throw Object.assign(new Error('Desktop request exceeds 256 MiB.'),{statusCode:413});chunks.push(chunk);}
    return Buffer.concat(chunks);
  };
  const decode=(bytes,encoding)=>{
    if(encoding==='zstd')return zstdDecompressSync(bytes,{maxOutputLength:MAX_REQUEST_BYTES});
    if(encoding==='gzip')return gunzipSync(bytes,{maxOutputLength:MAX_REQUEST_BYTES});
    if(encoding==='deflate')return inflateSync(bytes,{maxOutputLength:MAX_REQUEST_BYTES});
    if(encoding&&encoding!=='identity')throw new Error(`Unsupported content encoding ${encoding}`);
    return bytes;
  };
  // One Claude request: from the separate window (/v1/responses), or from the
  // app's own OpenAI provider in picker mode, over HTTP or WebSocket.
  async function serveClaude(req,res,body) {
    const model=models.get(body.model);
    if(!model)return json(res,400,{error:{message:`Unknown model ${body.model}. This bridge serves ${models.list.map(m=>m.slug).join(', ')}. There is no fallback model.`}});
    if(!Array.isArray(body.input)||body.stream!==true)return json(res,400,{error:{message:'Streaming Responses requests with an input array are required.'}});
    const metadata=JSON.parse(req.headers['x-codex-turn-metadata']??'{}');
    // Remote compaction, which the app uses with its own provider, ends the
    // input with a compaction_trigger item.
    const kind=metadata.request_kind==='compaction'||body.input.at(-1)?.type==='compaction_trigger'?'compaction':metadata.request_kind??'turn';
    // In picker mode the tool list is the one GPT gets, which can include
    // tools OpenAI runs on its servers. Claude cannot use those.
    if(req.gateway&&Array.isArray(body.tools)) {
      const hosted=body.tools.filter(t=>!['function','custom','namespace'].includes(t.type));
      if(hosted.length){body={...body,tools:body.tools.filter(t=>!hosted.includes(t))};log('hosted_tools_omitted',{types:hosted.map(t=>t.type)});}
    }
    validateRequestOptions(kind==='compaction'?{...body,tools:[]}:body);
    effortFor(model,body.reasoning?.effort);
    const thread=req.headers['thread-id']??req.headers['session-id']??req.headers.session_id??body.prompt_cache_key;
    if(!thread)return json(res,400,{error:{message:'A stable desktop thread identifier is required.'}});
    const cacheFile=path.join(cacheDir,digest([thread,metadata.context_window_id,metadata.turn_id,kind,body])+'.sealed');
    if(fs.existsSync(cacheFile)&&Date.now()-fs.statSync(cacheFile).mtimeMs<=86400000) {
      const frames=openCheckpoint(fs.readFileSync(cacheFile,'utf8'),token);
      bridge.log('response_replayed',{thread});res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.end(frames);return;
    }
    const checkpoints=body.input.filter(x=>x.type==='compaction'||x.type==='context_compaction');
    const checkpointKey=checkpoints.length?digest(checkpoints.at(-1).encrypted_content):'none';
    // A checkpoint written by GPT is encrypted by OpenAI and cannot be read here.
    body={...body,input:body.input.map(x=>!['compaction','context_compaction'].includes(x.type)?x
      :{type:'message',id:x.id,role:'user',content:[{type:'input_text',text:String(x.encrypted_content??'').startsWith(BRIDGE_CHECKPOINT)
        ?'<context_checkpoint>\n'+openCheckpoint(x.encrypted_content,token)+'\n</context_checkpoint>\nContinue the existing task from this checkpoint.'
        :'<context_checkpoint>Earlier conversation was compacted by another model. Its summary is encrypted for that model and is not available here; the messages kept after it follow. Ask the user if something important is missing.</context_checkpoint>'}]})};
    if(kind==='compaction') {body.__bridge_compaction=true;body.tools=[];body.__bridge_turn_key=[thread,metadata.context_window_id??'default','turn',checkpointKey].join(':');}
    body.__bridge_model=model;
    const key=[thread,metadata.context_window_id??'default',kind,checkpointKey].join(':');
    bridge.log('request',{model:model.slug,request_kind:kind,picker:req.gateway??false,window:metadata.window_number,tools:body.tools?.length,items:body.input.length});
    if(!bridge.sessions.has(key))bridge.sessions.set(key,new Session(bridge,key));
    await bridge.sessions.get(key).accept(body,res,frames=>{
      try{const temp=cacheFile+'.tmp';fs.writeFileSync(temp,sealCheckpoint(frames,token),{mode:0o600});fs.renameSync(temp,cacheFile);}
      catch(error){bridge.log('cache_persist_error',{message:error.message});}
    });
  }
  const gateway=gatewayKey?createGateway({bridge,key:gatewayKey,upstream:gatewayUpstream,serve:serveClaude,log}):null;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.headers.origin)return json(res,403,{error:{message:'Browser-origin requests are not allowed.'}});
      const url=new URL(req.url,bridge.url);
      // Picker mode: the path carries the key, because the app's built-in
      // provider cannot add headers.
      if(url.pathname.startsWith('/g/')) {
        const sub=gateway?gatewayPath(url.pathname,gatewayKey):null;
        if(sub===null)return json(res,401,{error:{message:'Bridge authentication required.'}});
        const raw=['GET','HEAD'].includes(req.method)?null:await readBody(req);
        let decoded=null;
        if(req.method==='POST'&&sub==='/responses'&&raw)try{decoded=JSON.parse(decode(raw,req.headers['content-encoding']).toString());}catch{}
        return await gateway.handleHttp(req,res,sub,url,raw,decoded);
      }
      if(!authenticated(req))return json(res,401,{error:{message:'Bridge authentication required.'}});
      if(url.pathname==='/health')return json(res,200,{status:'ok',version:VERSION,models:models.list.map(m=>m.slug),auth:auth.mode,web_search:bridge.webSearch,picker:!!gateway,sessions:bridge.sessions.size,
        active_sessions:[...bridge.sessions.values()].filter(x=>x.child||x.accepting).length,active_relays:gateway?.active()??0});
      if(url.pathname==='/v1/models')return json(res,200,{object:'list',data:models.list.map(m=>({id:m.slug,object:'model',owned_by:'anthropic',display_name:bridge.label(m)}))});
      if(req.method==='POST'&&url.pathname==='/v1/alpha/search') {
        if(!bridge.webSearch)return json(res,404,{error:{message:'Web search is turned off for this bridge. Run setup again with --web-search to turn it on.'}});
        return await search(req,res);
      }
      let body;
      if(req.method==='POST') {
        const bytes=decode(await readBody(req),req.headers['content-encoding']);
        // Name the endpoint when a desktop feature posts a non-JSON body, so an
        // unsupported route can be identified from the log.
        try{body=JSON.parse(bytes.toString());}
        catch{
          bridge.log('unsupported_body',{path:url.pathname,content_type:req.headers['content-type']?.split(';')[0],bytes:bytes.length});
          return json(res,url.pathname==='/v1/responses'?400:404,{error:{message:`Unsupported non-JSON request to ${url.pathname}`}});
        }
      }
      if(url.pathname.startsWith('/mcp/')) {
        const id=url.pathname.split('/')[2];const session=[...bridge.sessions.values()].find(x=>x.id===id);
        if(!session?.transport)return json(res,404,{error:{message:'Unknown tool relay session.'}});
        return await session.transport.handleRequest(req,res,body);
      }
      if(req.method!=='POST'||url.pathname!=='/v1/responses'){
        bridge.log('unsupported_endpoint',{path:url.pathname,fields:body?Object.keys(body):[],stream:body?.stream});
        return json(res,404,{error:{message:`Unsupported endpoint ${url.pathname}`}});
      }
      return await serveClaude(req,res,body);
    } catch(error) {
      bridge.log('request_error',{message:error.message});
      if(!res.headersSent)json(res,error.statusCode??(error.code==='ERR_BUFFER_TOO_LARGE'?413:500),{error:{message:error.message}});
      else if(!res.writableEnded){res.write(`event: error\ndata: ${JSON.stringify({type:'error',message:error.message})}\n\n`);res.end();}
    }
  });
  server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url,bridge.url);
    const sub=gateway&&!req.headers.origin?gatewayPath(url.pathname,gatewayKey):null;
    if(sub===null){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    gateway.handleUpgrade(req,socket,head,sub,url);
  });
  server.requestTimeout=0;server.timeout=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  bridge.url=`http://127.0.0.1:${server.address().port}`;
  bridge.close=async()=>{clearInterval(cacheTimer);clearInterval(sessionTimer);gateway?.close();for(const s of bridge.sessions.values()){s.cancel('Bridge shutting down.');await s.exiting;await s.mcp?.close();}server.closeAllConnections();await new Promise(r=>server.close(r));};
  log('bridge_ready',{url:bridge.url,models:models.list.map(m=>m.slug),auth:auth.mode,web_search:bridge.webSearch,picker:!!gateway});return bridge;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const runtime=process.env.CLAUDE_BRIDGE_RUNTIME;
  if(!runtime)throw new Error('Set CLAUDE_BRIDGE_RUNTIME to a private runtime directory.');
  const token=fs.readFileSync(path.join(runtime,'token'),'utf8').trim();
  const mode=process.env.CLAUDE_BRIDGE_AUTH??'claude_login';
  if(mode==='api_key'&&!process.env.ANTHROPIC_API_KEY)throw new Error('CLAUDE_BRIDGE_AUTH=api_key needs ANTHROPIC_API_KEY in the bridge environment.');
  const auth=mode==='api_key'?{mode,apiKey:()=>process.env.ANTHROPIC_API_KEY}:{mode};
  // Picker mode is on once scripts/picker.py has created the gateway key.
  const keyFile=path.join(runtime,'gateway-key');
  const gatewayKey=fs.existsSync(keyFile)?fs.readFileSync(keyFile,'utf8').trim():null;
  const bridge=await startBridge({stateDir:path.join(runtime,'sessions'),token,port:Number(process.env.CLAUDE_BRIDGE_PORT??DEFAULT_PORT),claude:findClaude(),auth,
    webSearch:process.env.CLAUDE_BRIDGE_WEB_SEARCH==='1',gatewayKey,gatewayUpstream:process.env.CLAUDE_BRIDGE_GATEWAY_UPSTREAM||GATEWAY_UPSTREAM,
    log:(event,data)=>process.stdout.write(JSON.stringify({time:new Date().toISOString(),event,...data})+'\n')});
  fs.writeFileSync(path.join(runtime,'bridge.pid'),String(process.pid),{mode:0o600});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>bridge.close().then(()=>process.exit(0)));
}
