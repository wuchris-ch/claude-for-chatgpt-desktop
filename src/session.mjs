import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {digest, normalizeTools, mcpResult, systemPrompt, userInput, asPrompt, steeringPrompt, isResult, isIncoming, newNotes, inputKey, historyItems, historyStamp, extendsHistory, historyEnd, afterStop, resumeAfterStop, outputSchema, ResponseStream, CompactionStream, COMPACTION_REQUEST} from './protocol.mjs';
import {effortFor, startedModelMatches} from './models.mjs';
import {boundToolImages, assertModelInputFits} from './image-history.mjs';

// The desktop already sized each tool result for the model. Past its own
// per-tool limit, Claude Code saves a result to a file and tells Claude to page
// through it with a Read tool the bridge does not provide. MAX_MCP_OUTPUT_TOKENS
// in the spawn environment lifts the matching token cap.
const MAX_RESULT_CHARS=1000000;
// Claude Code caches prompts for an hour on a subscription.
const CACHE_TTL_MS=3600000;

// Tool lists are stored by content so a compaction can list exactly the tools
// the session it forks ran with: tool definitions are part of the cached prompt.
export function saveToolSet(stateDir,tools) {
  const id=digest(tools);const dir=path.join(stateDir,'tool-sets');const file=path.join(dir,`${id}.json`);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.existsSync(file)){const now=new Date();fs.utimesSync(file,now,now);}
  else{fs.writeFileSync(file+'.tmp',JSON.stringify(tools),{mode:0o600});fs.renameSync(file+'.tmp',file);}
  return id;
}

// How long a mid-turn message may wait for Claude Code to confirm it queued,
// and the longest thought shown when Claude answered one only in thinking.
const STEER_CONFIRM_MS=5000,ACK_THINKING_MAX=600;
// Inherited variables are cleared so the user's shell or service environment
// cannot change the account, endpoint or model. CLAUDE_CONFIG_DIR stays: it
// only says where Claude Code keeps its own login and settings.
const KEEP_ENV=new Set(['CLAUDE_CONFIG_DIR']);
const modelChanged=(actual,expected)=>new Error(`Claude Code answered with ${actual} instead of ${expected}. Its safety classifiers can re-run a flagged request on a fallback model; the bridge stops rather than change models silently. Rephrase the request or pick another model.`);
export class Session {
  constructor(bridge, key) {
    this.bridge = bridge; this.key = key; this.id = digest(key); this.file = path.join(bridge.stateDir, `${this.id}.json`);
    this.record = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {claudeId: randomUUID(), seen: [], started: false};
    this.pending = new Map(); this.nativeCalls = []; this.results = new Map(); this.textIndices = []; this.tools = [];this.callWaiters=new Set();this.queued=new Map();this.ack=null;
    this.lastUsed=Date.now();
  }
  save() {
    const temp = this.file+'.tmp'; fs.writeFileSync(temp, JSON.stringify(this.record), {mode:0o600}); fs.renameSync(temp,this.file);
  }
  log(event, detail={}) {this.bridge.log(event, {session:this.id.slice(0,12), ...detail});}
  async setupMcp() {
    const previous=this.mcp;this.mcp=null;
    if(previous)await previous.close();
    this.mcp = new Server({name:'chatgpt-tool-relay',version:'0.1.0'}, {capabilities:{tools:{listChanged:true}}});
    const relay=this.mcp;
    this.transport = new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID, enableJsonResponse:true});
    this.mcp.setRequestHandler(ListToolsRequestSchema, async()=>({tools:this.tools.map(({name,description,inputSchema})=>({name,description,inputSchema,_meta:{'anthropic/maxResultSizeChars':MAX_RESULT_CHARS}}))}));
    this.mcp.setRequestHandler(CallToolRequestSchema, async(req,extra)=> {
      const {name, arguments: args={}} = req.params;
      try {
        const call = await this.matchCall(name,args,extra.signal);
        if(extra.signal.aborted)throw new Error('Tool request cancelled.');
        if(this.results.has(call.id)) return this.takeResult(call.id);
        return await new Promise((resolve,reject)=> {
          const abort = ()=> {this.pending.delete(call.id);reject(new Error('Tool request cancelled.'));};
          extra.signal.addEventListener('abort',abort,{once:true});
          this.pending.set(call.id,()=> {extra.signal.removeEventListener('abort',abort);resolve(this.takeResult(call.id));});
        });
      } catch(error) {
        if(this.mcp===relay&&!this.stopping)this.fail('Tool relay interrupted: '+error.message);
        throw error;
      }
    });
    await this.mcp.connect(this.transport);
  }
  async matchCall(name,args,signal) {
    // stdout and HTTP are independent transports. Either may arrive first.
    const deadline=Date.now()+3000;
    while(true) {
      const call=this.nativeCalls.find(c=>!c.claimed&&c.tool.name===name&&digest(c.args)===digest(args));
      if(signal.aborted)throw new Error('Tool request cancelled.');
      if(call){call.claimed=true;return call;}
      const remaining=deadline-Date.now();
      if(remaining<=0)throw new Error(`Unmatched native tool call ${name}; refusing duplicate or untracked execution.`);
      await new Promise(resolve=>{
        const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);this.callWaiters.delete(done);resolve();};
        const timer=setTimeout(done,remaining);this.callWaiters.add(done);signal.addEventListener('abort',done,{once:true});
      });
    }
  }
  async reset(reason) {
    this.log(reason,{source:'desktop_transcript'});
    const child=this.child;
    if(child){this.cancel(reason);await this.exiting;}
    this.pending.clear();this.results.clear();this.nativeCalls=[];this.resumeItems=null;
    this.record={claudeId:randomUUID(),seen:[],started:false,recoveredFrom:this.record.claudeId};this.save();
  }
  // A stopped turn leaves a consistent native transcript. Claude Code keeps the
  // partial answer and marks unanswered tool calls as interrupted, even after
  // SIGKILL, so resuming it keeps the prompt cache. Rebuilding from the desktop
  // transcript rewrote the cache, 70k to 495k tokens per Stop.
  async resumeOrRecover(body) {
    const stop=!body.__bridge_compaction&&this.record.stop;
    this.resumeItems=stop?afterStop(body.input,this.record.history,stop.seen,this.record.delivered):null;
    if(this.resumeItems)this.log('stopped_turn_resumed',{reason:stop.reason,items:this.resumeItems.length});
    else await this.reset('interrupted_turn_recovery');
  }
  // When agent or user messages arrive while a response streams, the desktop
  // drops that response's tool calls, which never ran, and samples again with
  // the messages appended. Claude is still waiting on those calls, so answer
  // them and pass the messages on instead of rebuilding the whole session.
  supersededCalls(input) {
    const stamp=this.record.historyWithoutCalls;
    if(!this.child||!stamp||!extendsHistory(input,stamp))return null;
    const calls=this.nativeCalls.filter(c=>!this.record.delivered?.includes(c.id));
    if(!calls.length||input.some(x=>calls.some(c=>c.id===x.call_id)))return null;
    const added=historyItems(input).slice(stamp.length);
    return added.length&&added.every(isIncoming)?calls:null;
  }
  supersede(call) {
    call.emitted=true;
    this.record.delivered ??= []; this.record.delivered.push(call.id);
    this.results.set(call.id,{isError:true,content:[{type:'text',text:'Not run: new messages arrived while you were responding, so the host dropped this call. The messages follow. Call the tool again if you still need it.'}]});
    this.pending.get(call.id)?.();
    this.log('tool_superseded',{call_id:call.id});
  }
  // Claude Code reads stdin in chunks, so a message with an image could still
  // be parsing when the tool result returned over MCP. Claude then took its next
  // step without the message. Releasing the result only after Claude Code
  // reports the message queued keeps them together.
  steer(fresh) {
    const uuid=randomUUID();
    this.child.stdin.write(JSON.stringify({type:'user',uuid,message:{role:'user',content:steeringPrompt(fresh)},session_id:this.record.claudeId,parent_tool_use_id:null})+'\n');
    this.log('user_steering',{messages:fresh.length});
    if(fresh.some(x=>x.type==='message'&&x.role==='user'))this.ack={thinking:''};
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{if(this.queued.delete(uuid)){this.log('steering_unconfirmed',{});resolve();}},STEER_CONFIRM_MS);timer.unref();
      this.queued.set(uuid,()=>{clearTimeout(timer);resolve();});
    });
  }
  // New messages for Claude in input order: the given user and agent messages
  // plus developer notes the desktop added after the recorded history.
  withNotes(input,fresh,stamp) {
    const notes=newNotes(input,stamp);if(!notes.length)return fresh;
    const add=new Set([...fresh,...notes]);return input.filter(x=>add.has(x));
  }
  // A compaction at a turn boundary forks the thread's native session with
  // the same system prompt, tools and effort, so the prompt cache covers the
  // conversation. Importing it as text into a fresh session rewrote the whole
  // cache, up to 459k tokens per compaction. Anything that does not line up,
  // including a tool cycle in progress, keeps the import.
  async compactionFork(input,turnKey) {
    const id=digest(turnKey);
    const live=[...this.bridge.sessions.values()].find(x=>x.id===id);
    // A turn that just completed may still be closing its process.
    if(live?.exiting&&!live.stream)await live.exiting;
    if(live&&(live.child||live.accepting||live.stream))return {reason:'turn_in_progress'};
    const read=file=>{try{return fs.readFileSync(path.join(this.bridge.stateDir,file),'utf8');}catch{return null;}};
    const record=JSON.parse(read(`${id}.json`)??'null'),prompt=read(`${id}.system.txt`);
    // A turn that was stopped can be forked like a completed one.
    if(!(record?.started||record?.stop)||record.inflight&&!record.stop)return {reason:'no_completed_turn'};
    const model=this.bridge.models.get(record.model);
    if(!model||record.effort===undefined||!record.toolSet||!prompt||digest(prompt)!==record.instructions)return {reason:'session_settings_unknown'};
    if(!extendsHistory(input,record.history))return {reason:'history_differs'};
    const tools=read(path.join('tool-sets',`${record.toolSet}.json`));
    if(!tools)return {reason:'tool_list_missing'};
    const extra=record.inflight?afterStop(input,record.history,record.stop.seen,record.delivered):input.slice(historyEnd(input,record.history));
    // The record was last saved when the session's turn ended or was stopped.
    const cold=Date.now()-fs.statSync(path.join(this.bridge.stateDir,`${id}.json`)).mtimeMs>CACHE_TTL_MS;
    return {from:id.slice(0,12),claudeId:record.claudeId,model,effort:record.effort,prompt,tools:JSON.parse(tools),extra,cold};
  }
  // After a compaction in the middle of a turn, the desktop continues in a new
  // context window and never answers the old session's pending tool call, so
  // that Claude process waited until the bridge restarted.
  releaseCompactedTurn() {
    const turn=this.turnKey&&this.bridge.sessions.get(this.turnKey);
    if(turn?.child&&!turn.stream&&!turn.accepting)turn.cancel('compacted_mid_turn');
  }
  takeResult(id) {const r=this.results.get(id);this.results.delete(id);this.pending.delete(id);return r;}
  deliverResult(item) {
    if(!this.nativeCalls.some(c=>c.id===item.call_id)) throw new Error(`Unknown tool result ${item.call_id}; cannot safely continue this tool cycle.`);
    if(this.record.delivered?.includes(item.call_id)) return;
    const result=mcpResult(item.output);
    this.record.delivered ??= []; this.record.delivered.push(item.call_id);
    this.results.set(item.call_id,result);this.pending.get(item.call_id)?.();
    this.log('tool_result',{call_id:item.call_id});
  }
  async accept(body,res,onComplete) {
    if(this.accepting)throw new Error('This conversation is already accepting a request.');
    this.accepting=true;
    this.lastUsed=Date.now();
    try {await this.acceptRequest(body,res,onComplete);}
    catch(error){if(this.stream?.res===res)this.fail(error.message);throw error;}
    finally {this.accepting=false;}
  }
  async acceptRequest(body,res,onComplete) {
    if(this.exiting) await this.exiting;
    if(this.stream && !this.stream.finished) throw new Error('This conversation already has an active response.');
    this.stopping=false;this.resumeItems=null;
    // A killed process cannot restore an in-flight MCP promise. A stopped turn
    // resumes its native session. Anything else recovers from the host's
    // authoritative transcript in a new one, preserving observed tool results
    // rather than silently rerunning the old call.
    if(!this.child&&this.record.inflight)await this.resumeOrRecover(body);
    let superseded=null;
    if((this.record.started||this.child)&&!extendsHistory(body.input,this.record.history)) {
      superseded=this.supersededCalls(body.input);
      if(!superseded)await this.reset('history_branch_rebuilt');
    }
    const model=body.__bridge_model;
    // The desktop keeps one model for a turn. A different model while a
    // native process waits on a tool result restarts from the transcript.
    if(this.child&&this.record.model!==model.slug)await this.reset('model_changed');
    const prompt=systemPrompt(body,{name:model.display_name,webSearch:this.bridge.webSearch});
    if(this.child&&this.record.instructions!==digest(prompt))await this.reset('instructions_changed');
    // Stop during host tool execution has no open model HTTP stream to abort.
    // A subsequent user message without results abandons that waiting cycle.
    if(this.child&&!superseded&&!body.input.some(x=>isResult(x)&&this.nativeCalls.some(c=>c.id===x.call_id)&&!this.record.delivered?.includes(x.call_id))&&
      (body.input.some(x=>isIncoming(x)&&!this.pendingSeen.includes(inputKey(x)))||newNotes(body.input,this.record.history).length)) {
      this.cancel('tool_cycle_interrupted');await this.exiting;await this.resumeOrRecover(body);
    }
    const originalInput=body.input;
    const bounded=boundToolImages(originalInput,this.record.imageCutoff??0);
    if(bounded.cutoff!==(this.record.imageCutoff??0)&&(this.child||this.record.started||this.resumeItems))await this.reset('image_history_bounded');
    this.record.imageCutoff=bounded.cutoff;
    body={...body,input:bounded.input};
    assertModelInputFits(body);
    // A new inference request with no new user message can be regeneration.
    // Exact transport retries have already been handled by the response cache.
    if(!this.child&&this.record.started&&!this.resumeItems&&!body.input.some(x=>isIncoming(x)&&!this.record.seen.includes(inputKey(x))))await this.reset('regeneration_rebuilt');
    const tools=normalizeTools(body.tools);
    if(new Set(tools.map(t=>t.name)).size!==tools.length) throw new Error('Tool names collide after MCP name normalization.');
    this.tools=tools;
    if(tools.length&&!body.__bridge_compaction)this.record.toolSet=saveToolSet(this.bridge.stateDir,tools);
    this.sequential=body.parallel_tool_calls===false;
    this.stream=body.__bridge_compaction?new CompactionStream(res,this.bridge.token,model.slug):new ResponseStream(res,model.slug);this.textIndices=[];this.usage={input_tokens:0,output_tokens:0,total_tokens:0};
    this.stream.onComplete=onComplete;
    this.streamInput=originalInput;
    const activeStream=this.stream;
    res.on('close',()=> {if(!activeStream.finished && this.stream===activeStream)this.cancel('Desktop cancelled or disconnected.');});
    if(this.child) {
      await this.mcp.sendToolListChanged().catch(()=>{});
      if(superseded) {
        const fresh=this.withNotes(body.input,body.input.filter(x=>isIncoming(x)&&!this.pendingSeen.includes(inputKey(x))),this.record.historyWithoutCalls);
        this.pendingSeen.push(...fresh.map(inputKey));
        await this.steer(fresh);
        for(const call of superseded)this.supersede(call);
        return;
      }
      const results=body.input.filter(isResult).filter(x=>this.nativeCalls.some(c=>c.id===x.call_id));
      if(!results.length) throw new Error('Claude is waiting for a tool result, but the next request supplied none.');
      const fresh=this.withNotes(body.input,body.input.filter(x=>isIncoming(x)&&!this.pendingSeen.includes(inputKey(x))),this.record.history);
      if(fresh.length) {
        this.pendingSeen.push(...fresh.map(inputKey));
        await this.steer(fresh);
      }
      for(const item of results)this.deliverResult(item);
      // With parallel_tool_calls=false, calls from one Claude message are
      // relayed one per response. Claude waits on the held call's MCP result.
      const held=this.nativeCalls.find(c=>!c.emitted);
      if(held)this.emitCalls([held]);
      return;
    }
    this.turnKey=body.__bridge_turn_key;
    let fork=body.__bridge_compaction&&!this.record.started&&body.__bridge_turn_key?await this.compactionFork(originalInput,body.__bridge_turn_key):null;
    if(fork?.reason){this.log('compaction_import',{reason:fork.reason});fork=null;}
    if(fork){this.tools=fork.tools;this.log('compaction_fork',{from:fork.from,extra_items:fork.extra.length,cold:fork.cold});}
    await this.setupMcp();
    const users=body.input.filter(isIncoming);
    const key=inputKey;
    const fresh=users.filter(x=>!this.record.seen.includes(key(x)));
    let input;
    if(fork) {
      input=[...(fork.extra.length?userInput(fork.extra,{replay:true,prefix:false}):[]),{type:'text',text:COMPACTION_REQUEST}];
    } else if(this.resumeItems) {
      input=resumeAfterStop(this.resumeItems,this.record.stop);
    } else if(this.record.started) {
      if(!fresh.length) throw new Error('No new user input. Replaying a completed request would duplicate the turn.');
      input=userInput(this.withNotes(body.input,fresh,this.record.history),{prefix:false});
    } else {
      const replay=body.input.some(x=>x.role==='assistant'||isResult(x)||['function_call','custom_tool_call'].includes(x.type));
      input=userInput(body.input,{replay});
      if(replay)this.log('history_import',{reason:'new_or_compacted_context'});
    }
    this.pendingSeen=[...new Set([...this.record.seen,...users.map(key)])];
    // A fork keeps the session's model and effort: changing either misses the cache.
    const runModel=fork?.model??model;
    const effort=fork?fork.effort:effortFor(runModel,body.reasoning?.effort);
    // Switching Claude models between turns resumes the same native session
    // on the new model. Its first request cannot reuse the old model's cache.
    if(!fork&&(this.record.started||this.resumeItems)&&this.record.model&&this.record.model!==runModel.slug)this.log('model_switched',{from:this.record.model,to:runModel.slug});
    const config={mcpServers:{chatgpt:{type:'http',url:`${this.bridge.url}/mcp/${this.id}`,headers:{Authorization:`Bearer ${this.bridge.token}`}}}};
    const systemFile=path.join(this.bridge.stateDir,`${this.id}.system.txt`);
    fs.writeFileSync(systemFile,fork?.prompt??prompt,{mode:0o600});
    this.record.instructions=digest(fork?.prompt??prompt);this.record.effort=effort;this.record.model=runModel.slug;
    this.schema=outputSchema(body);
    const args=['-p','--model',runModel.claude_model,...(effort?['--effort',effort]:[]),'--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages',
      '--tools','','--strict-mcp-config','--mcp-config',JSON.stringify(config),'--allowedTools','mcp__chatgpt__*','--permission-mode','dontAsk',
      '--setting-sources','','--disable-slash-commands','--system-prompt-snapshot','off','--system-prompt-file',systemFile,
      ...(this.schema?['--json-schema',JSON.stringify(this.schema)]:[]),
      ...(fork?['--resume',fork.claudeId,'--fork-session']:[this.record.started||this.resumeItems?'--resume':'--session-id',this.record.claudeId])];
    const env={...process.env};
    for(const name of Object.keys(env))if((name.startsWith('ANTHROPIC_')||name.startsWith('CLAUDE_')||name.startsWith('CODEX_'))&&!KEEP_ENV.has(name))delete env[name];
    // Once Claude Code has reported the model an alias starts, every internal
    // model choice is pinned to it, so one model does all the work.
    const pinned=this.bridge.resolvedModels.get(runModel.slug)??(runModel.family?null:runModel.claude_model);
    if(pinned)Object.assign(env,{ANTHROPIC_DEFAULT_OPUS_MODEL:pinned,ANTHROPIC_DEFAULT_SONNET_MODEL:pinned,ANTHROPIC_DEFAULT_HAIKU_MODEL:pinned,CLAUDE_CODE_SUBAGENT_MODEL:pinned});
    Object.assign(env,{CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',DISABLE_AUTOUPDATER:'1',
      // The desktop owns tool timeouts and yields. Claude Code's ~60 s MCP default
      // otherwise abandons long host tools while the desktop keeps running them.
      MCP_TOOL_TIMEOUT:'86400000',
      // Claude Code also aborts an HTTP MCP call after 300 s without a response
      // or progress, so a long clock.sleep or build ended the native session.
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT:'0',
      // The desktop sizes tool output for the model. Claude Code's 25k-token cap
      // otherwise moves large results, such as browser snapshots, to a file.
      MAX_MCP_OUTPUT_TOKENS:'200000',
      // Code mode documents every nested tool (shell, apply_patch, web__run, apps)
      // inside the exec description, ~355k chars. Claude Code cuts MCP
      // descriptions at 2048 chars by default, hiding almost all of it.
      CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH:'4000000'});
    // Nothing reads a fork's cache afterwards. Once the session's own cache
    // has expired, writing one costs twice the plain input price for the whole
    // conversation, 441k tokens in one compaction of an idle thread.
    if(fork?.cold)env.DISABLE_PROMPT_CACHING='1';
    // Login mode runs the user's own Claude Code login. API key mode hands
    // Claude Code the configured key, which it then uses instead of a login.
    if(this.bridge.auth.mode==='api_key') {
      const key=this.bridge.auth.apiKey();
      if(!key)throw new Error('API key mode is on, but no ANTHROPIC_API_KEY is available to the bridge.');
      env.ANTHROPIC_API_KEY=key;
    }
    this.runModel=runModel;this.activeModel=null;
    this.child=spawn(this.bridge.claude,args,{cwd:this.bridge.claudeCwd,env,stdio:['pipe','pipe','pipe']});
    this.stopping=false;
    const child=this.child;this.stderr='';this.nativeCalls=[];this.ready=false;this.forked=!!fork;
    // Until a response completes, the native session has seen this request's input.
    if(!fork){this.record.history=historyStamp(originalInput);this.record.historyWithoutCalls=null;}
    this.record.delivered=[];this.record.stop=null;this.record.inflight=true;this.save();
    this.log('claude_start',{model:runModel.slug,claude_model:runModel.claude_model,resume:!!(this.record.started||this.resumeItems),effort,auth:this.bridge.auth.mode});
    child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-4000);});
    createInterface({input:child.stdout}).on('line',line=>{
      try{this.onEvent(JSON.parse(line));}catch(error){this.fail(error.message);}
    });
    child.on('error',e=>this.fail(e.message));
    this.childDone=new Promise(resolve=>child.once('close',(code,signal)=>{
      if(this.child===child)this.child=null;
      if(this.stream&&!this.stream.finished)this.fail(`Claude Code exited before completion (${code??signal}). ${this.stderr}`);
      this.log('claude_exit',{code,signal});
      this.exiting=null;this.lastUsed=Date.now();resolve();
    }));
    child.stdin.on('error',e=>this.fail(`Claude input closed: ${e.message}`));
    child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:asPrompt(input)},session_id:this.record.claudeId,parent_tool_use_id:null})+'\n');
  }
  onEvent(msg) {
    if(this.stopping)return;
    if(msg.type==='command_lifecycle'&&msg.state==='queued') {
      const release=this.queued.get(msg.command_uuid);if(release){this.queued.delete(msg.command_uuid);release();}
      return;
    }
    if(['assistant','stream_event','result'].includes(msg.type)&&!(msg.type==='result'&&msg.queued_turn_count>0)&&(!this.stream||this.stream.finished)) {
      this.fail('Claude advanced without an active desktop response. Recovering from the desktop transcript on the next request.');
      return;
    }
    if(msg.type==='system'&&msg.subtype==='init') {
      if(!startedModelMatches(this.runModel,msg.model))throw new Error(`Claude Code started ${msg.model} for ${this.runModel.display_name} (${this.runModel.claude_model}). The bridge does not switch models silently.`);
      this.activeModel=msg.model;this.bridge.resolvedModels.set(this.runModel.slug,msg.model);
      const host=msg.mcp_servers?.find(x=>x.name==='chatgpt');
      if(this.tools.length && host?.status!=='connected')throw new Error('Claude could not connect to the desktop tool relay.');
      // Claude Code reports init only after it has recorded the turn's input.
      this.ready=!this.forked;
      this.log('claude_ready',{model:msg.model,tools:msg.tools});
    }
    if(msg.type==='assistant') {
      if(msg.message.model!=='<synthetic>'&&msg.message.model!==this.activeModel)throw modelChanged(msg.message.model,this.activeModel);
      for(const c of msg.message.content??[])if(c.type==='tool_use') {
        if(this.schema&&c.name==='StructuredOutput')continue;
        const name=c.name.replace(/^mcp__chatgpt__/, '');const tool=this.tools.find(t=>t.name===name);
        // Claude Code itself answers an unknown tool with an error result and the
        // model retries, so a hallucinated name must not end the turn.
        if(!tool){this.log('unknown_tool',{name:c.name});continue;}
        // A compaction fork lists the session's tools only so the cache matches. Nothing runs.
        const compacting=this.stream instanceof CompactionStream;
        this.nativeCalls.push({id:c.id,args:c.input,tool,emitted:compacting});
        if(compacting) {
          this.results.set(c.id,{isError:true,content:[{type:'text',text:'Not run: the host is compacting this conversation. Reply only with the checkpoint.'}]});
          this.log('compaction_tool_refused',{name:tool.originalName});
        }
        for(const wake of this.callWaiters)wake();
      }
    }
    if(msg.type==='stream_event') {
      const e=msg.event;
      if(e.type==='message_start') {
        this.currentText=null;this.stopReason=null;if(this.ack)this.ack.thinking='';
        // Only the last message of a compaction is the checkpoint.
        if(this.stream instanceof CompactionStream)this.stream.summary='';
        const u=e.message.usage??{};
        this.usage.input_tokens=(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0);
        this.usage.input_tokens_details={cached_tokens:u.cache_read_input_tokens??0};
      }
      if(e.type==='content_block_start'&&e.content_block.type==='text') {
        this.currentText=this.stream.startText();this.textIndices.push(this.currentText);
        if(e.content_block.text)this.stream.text(this.currentText,e.content_block.text);
      }
      if(e.type==='content_block_delta'&&e.delta.type==='thinking_delta'&&this.ack)this.ack.thinking+=e.delta.thinking;
      if(e.type==='content_block_delta'&&e.delta.type==='text_delta') {
        if(this.currentText==null){this.currentText=this.stream.startText();this.textIndices.push(this.currentText);}
        this.stream.text(this.currentText,e.delta.text);
      }
      if(e.type==='message_delta') {this.stopReason=e.delta.stop_reason;this.usage.output_tokens=e.usage?.output_tokens??0;}
      if(e.type==='message_stop') {
        const calls=this.nativeCalls.filter(x=>!x.emitted);
        // Opus sometimes answers a mid-turn message only in thinking, which the
        // desktop never shows. A short thought before the next tool call is that
        // answer, so it is shown as commentary.
        if(this.ack&&calls.length&&!this.textIndices.length) {
          const said=this.ack.thinking.trim();
          if(said&&said.length<=ACK_THINKING_MAX){const i=this.stream.startText();this.stream.text(i,said);this.textIndices.push(i);this.log('steering_ack_from_thinking',{chars:said.length});}
          else this.log('steering_unanswered',{thinking_chars:said.length});
        }
        if(this.ack&&(calls.length||this.textIndices.length))this.ack=null;
        // Under a JSON schema, only the validated structured value is the answer.
        for(const i of this.textIndices)this.stream.finishText(i,!calls.length&&this.stopReason!=='tool_use'&&!this.schema);
        this.textIndices=[];
        if(calls.length)this.emitCalls(this.sequential?calls.slice(0,1):calls);
      }
    }
    if(msg.type==='result') {
      // Answers were already checked message by message. Other usage would be
      // Claude Code background work, which the pins above normally prevent.
      const others=Object.keys(msg.modelUsage??{}).filter(x=>x!==this.activeModel);
      if(others.length)this.log('other_model_usage',{models:others});
      if(msg.is_error)throw new Error(msg.result||msg.errors?.join('\n')||`Claude failed: ${msg.subtype}`);
      if(msg.permission_denials?.length)throw new Error('Claude tool relay permission denied.');
      if(msg.queued_turn_count>0){this.log('queued_user_turn',{count:msg.queued_turn_count});return;}
      if(this.schema) {
        if(msg.structured_output===undefined)throw new Error('Claude did not return the requested structured output.');
        const i=this.stream.startText();this.stream.text(i,JSON.stringify(msg.structured_output));this.stream.finishText(i,true);
      }
      this.record.started=true;this.record.inflight=false;this.record.seen=this.pendingSeen;this.save();this.log('turn_complete',{model:this.activeModel,context_window:msg.modelUsage?.[this.activeModel]?.contextWindow});
      const compacted=this.stream instanceof CompactionStream&&!!this.stream.summary.trim();
      this.completeStream();
      if(compacted)this.releaseCompactedTurn();
      const child=this.child;
      if(child){this.exiting=this.childDone;child.stdin.end();}
    }
    if(msg.type==='system'&&msg.subtype==='api_retry')this.log('upstream_retry',{attempt:msg.attempt,status:msg.error?.status});
  }
  emitCalls(calls) {
    for(const c of calls){c.emitted=true;this.stream.tool(c.tool,c.id,c.args);this.log('tool_call',{name:c.tool.originalName,call_id:c.id});if(c.tool.originalName==='clock.sleep')this.watchSleep(c);}
    this.completeStream();
  }
  // A Stop while the desktop runs a host tool sends the bridge nothing, so
  // Claude Code waited on a stopped clock.sleep indefinitely, holding the
  // session active. A sleep states its length: once that and a grace period
  // pass without a result, the turn is stopped as if the desktop had cancelled
  // it. A result that arrives later is sent to the resumed session.
  watchSleep(call) {
    const ms=Number(call.args?.duration_ms);if(!Number.isFinite(ms)||ms<0)return;
    const child=this.child;
    const timer=setTimeout(()=>{
      if(this.child!==child||this.stream||this.accepting||this.record.delivered?.includes(call.id))return;
      this.log('host_sleep_abandoned',{call_id:call.id,duration_ms:ms});
      this.cancel('The desktop never returned a clock.sleep result.');
    },ms+(this.bridge.sleepGraceMs??300000));
    timer.unref();
  }
  completeStream() {
    if(this.stream?.finished)return;
    this.record.history=historyStamp([...this.streamInput,...this.stream.output]);
    const calls=this.stream.output.filter(x=>['function_call','custom_tool_call'].includes(x.type));
    this.record.historyWithoutCalls=calls.length?historyStamp([...this.streamInput,...this.stream.output.filter(x=>!calls.includes(x))]):null;
    this.save();
    this.usage.total_tokens=this.usage.input_tokens+this.usage.output_tokens;this.stream?.complete(this.usage);
    this.releaseResponse();
  }
  releaseResponse() {
    if(this.stream&&!this.stream.finished)return;
    if(this.stream){this.stream.onComplete=null;this.stream.frames=[];this.stream.output=[];this.stream.res=null;}
    this.stream=null;this.streamInput=null;this.textIndices=[];this.lastUsed=Date.now();
  }
  stopChild(signal) {
    const child=this.child;if(!child)return;
    this.stopping=true;this.exiting=this.childDone;
    child.kill(signal);
    const term=setTimeout(()=>{if(this.child===child)child.kill('SIGTERM');},3000);term.unref();
    const kill=setTimeout(()=>{if(this.child===child)child.kill('SIGKILL');},6000);kill.unref();
    this.childDone.finally(()=>{clearTimeout(term);clearTimeout(kill);});
  }
  fail(message) {this.log('error',{message});this.stream?.fail(message);this.releaseResponse();this.stopChild('SIGTERM');}
  cancel(reason) {
    this.log('cancel',{reason});
    // What the stopped session saw, so a resume sends only the rest.
    if(this.child&&this.ready&&!this.stopping&&this.record.inflight) {
      const sent=this.nativeCalls.filter(c=>c.emitted&&!this.record.delivered?.includes(c.id)).length;
      this.record.stop={reason,seen:this.pendingSeen,sent};this.save();
    }
    this.stream?.end();this.releaseResponse();this.stopChild('SIGINT');
  }
}
