import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {digest, normalizeTools, mcpResult, systemPrompt, userInput, replayImageNote, asPrompt, steeringPrompt, isResult, isCallResult, isHostCall, isIncoming, newNotes, inputKey, historyItems, historyStamp, extendsHistory, historyEnd, afterStop, stoppedTurnNote, resumeAfterStop, resampledSteer, userStopped, userTurn, timeNote, goalToolNote, otherModelTurns, OTHER_MODEL_NOTE, outputSchema, offersWebSearch, ResponseStream, CompactionStream, COMPACTION_REQUEST, afterWithdrawn, API_FAILED, CLAUDE_EXITED} from './protocol.mjs';
import {effortFor, labelFor, startedModelMatches} from './models.mjs';
import {boundToolImages, assertModelInputFits} from './image-history.mjs';
import {WEB_RUN_TOOL, runSearch, searchAction, searchContext} from './search.mjs';

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
// Claude Code records a turn's input just before it reports init: a median of
// 0.43 s and 3.0 s at the 99th percentile over 2,137 starts in the
// separate-window bridge's log from September 24 to October 14, 2026. A Stop
// before then waits this long for init.
const INIT_WAIT_MS=10000;
// The desktop accepted an async question card with four questions, one of them
// 1,100 characters long, and drew nothing, so the user never saw it. Its other
// question cards allow three; GPT's questions stay under about 460 characters.
const CARD_MAX_QUESTIONS=3,CARD_MAX_TITLE=600;
function cardProblem(tool,args) {
  if(tool.originalName!=='request_user_input_async')return null;
  const questions=Array.isArray(args?.questions)?args.questions:[];
  if(questions.length>CARD_MAX_QUESTIONS)return `the desktop shows at most ${CARD_MAX_QUESTIONS} questions in a card and silently drops a larger one. Ask at most ${CARD_MAX_QUESTIONS} now and the rest in a later card.`;
  if(questions.some(q=>String(q?.title??'').length>CARD_MAX_TITLE))return `keep each question under ${CARD_MAX_TITLE} characters so the desktop shows the card. Put long lists in a visible message or a file and refer to them.`;
  return null;
}
// Inherited variables are cleared so the user's shell or service environment
// cannot change the account, endpoint or model. CLAUDE_CONFIG_DIR stays: it
// only says where Claude Code keeps its own login and settings.
const KEEP_ENV=new Set(['CLAUDE_CONFIG_DIR']);
const modelChanged=(actual,expected)=>new Error(`Claude Code answered with ${actual} instead of ${expected}. Its safety classifiers can re-run a flagged request on a fallback model; the bridge stops rather than change models silently. Rephrase the request or pick another model.`);
export class Session {
  constructor(bridge, key) {
    this.bridge = bridge; this.key = key; this.id = digest(key); this.file = path.join(bridge.stateDir, `${this.id}.json`);
    this.record = this.load();
    this.pending = new Map(); this.nativeCalls = []; this.results = new Map(); this.textIndices = []; this.tools = [];this.callWaiters=new Set();this.queued=new Map();this.steers=new Map();this.ack=null;
    this.lastUsed=Date.now();
  }
  // A record that cannot be read is set aside, and the thread is imported
  // again from the desktop's history instead of failing every request.
  load() {
    try {if(fs.existsSync(this.file))return JSON.parse(fs.readFileSync(this.file,'utf8'));}
    catch(error) {fs.renameSync(this.file,this.file+'.unreadable');this.log('session_record_unreadable',{message:error.message});}
    return {claudeId: randomUUID(), seen: [], started: false};
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
      let call;
      try {
        call = await this.matchCall(name,args,extra.signal);
        if(extra.signal.aborted)throw new Error('Tool request cancelled.');
        if(this.results.has(call.id)) return this.takeResult(call.id);
        if(call.tool.local) return await this.runLocal(call,extra.signal);
        return await new Promise((resolve,reject)=> {
          const abort = ()=> {this.pending.delete(call.id);reject(new Error('Tool request cancelled.'));};
          extra.signal.addEventListener('abort',abort,{once:true});
          this.pending.set(call.id,()=> {extra.signal.removeEventListener('abort',abort);resolve(this.takeResult(call.id));});
        });
      } catch(error) {
        // Claude Code cancels a call the host is running when it is
        // interrupted from outside, as by a restart that signals it before
        // the bridge. It records the call as rejected, so the turn is saved
        // as stopped and the host's result goes to the resumed session.
        if(this.mcp===relay&&!this.stopping) {
          const waiting=extra.signal.aborted&&call?.emitted&&!this.stream&&this.ready&&this.record.inflight;
          if(waiting&&this.child)this.cancel(CLAUDE_EXITED);
          // The bridge closing the relay after Claude Code exited on its own,
          // which already saved the turn.
          else if(!(waiting&&this.record.stop))this.fail('Tool relay interrupted: '+error.message);
        }
        throw error;
      }
    });
    await this.mcp.connect(this.transport);
  }
  // A search Claude runs through the bridge. The desktop shows it like one
  // of GPT's own searches, and Claude gets the result directly.
  async runLocal(call,signal) {
    this.showSearch(call);
    // A Stop, a reset or a failure ends a running search too: Claude Code
    // cancels its MCP call only when its own turn is interrupted.
    this.searchAbort??=new AbortController();
    const result=await runSearch({auth:this.searchAuth,commands:call.args,upstream:this.bridge.searchUpstream,timeoutMs:this.bridge.searchTimeoutMs,signal:AbortSignal.any([signal,this.searchAbort.signal])});
    call.done=true;if(call.shown!=null)call.shownIn.searchDone(call.shown);
    this.log('bridge_search',{status:result.status,commands:result.commands});
    return {content:result.content,...(result.ok?{}:{isError:true})};
  }
  // Shown when Claude's message ends, before any host tool call in the same
  // message completes the response, or when the search starts, if sooner.
  showSearch(call) {
    if(call.shown!=null||call.done||!this.stream||this.stream.finished)return;
    const index=this.stream.searchStarted(searchAction(call.args));
    if(index!=null){call.shown=index;call.shownIn=this.stream;}
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
    this.pending.clear();this.results.clear();this.nativeCalls=[];this.resumeItems=null;this.truncate=null;
    this.record={claudeId:randomUUID(),seen:[],started:false,recoveredFrom:this.record.claudeId,lastReplyAt:this.record.lastReplyAt};this.save();
  }
  // A stopped turn leaves a consistent native transcript. Claude Code keeps the
  // partial answer and marks unanswered tool calls as interrupted, even after
  // SIGKILL, so resuming it keeps the prompt cache. Rebuilding from the desktop
  // transcript rewrote the cache, 70k to 495k tokens per Stop. A turn that
  // ended with an API error or because Claude Code exited is saved the same way.
  async resumeOrRecover(body) {
    const stop=!body.__bridge_compaction&&this.record.stop;
    this.resumeItems=stop?afterStop(body.input,this.record.history,stop.seen,this.record.delivered):null;
    if(this.resumeItems){this.log('stopped_turn_resumed',{reason:stop.reason,items:this.resumeItems.length,steer:resampledSteer(this.resumeItems,stop.reason)});return;}
    // A request that no longer contains the stopped turn, as when the user
    // edits or withdraws its message, rebuilt the session 9 times in the
    // separate-window bridge's log from October 5 to 13, 2026. When the request
    // still extends the conversation as it stood before that turn, Claude Code
    // resumes there and drops the turn, so Claude sees what the desktop shows,
    // from the cache. Claude Code refuses if anything else would be dropped. A
    // turn that reached the host with a tool call, and so may also hold
    // mid-turn messages, is rebuilt instead.
    const settled=this.record.settled;
    const added=stop&&settled&&this.record.prompt&&!stop.sent&&!this.record.delivered?.length?afterWithdrawn(body.input,settled.history,this.record.seen):null;
    if(added) {
      this.truncate={at:settled.at,prompt:this.record.prompt};this.record.history=settled.history;
      this.log('withdrawn_turn_dropped',{reason:stop.reason,items:added.length});
      return;
    }
    await this.reset('interrupted_turn_recovery');
  }
  // When agent or user messages arrive while a response streams, the desktop
  // drops that response's tool calls, which never ran, and samples again with
  // the messages appended. Claude is still waiting on those calls, so answer
  // them and pass the messages on instead of rebuilding the whole session.
  supersededCalls(input) {
    const stamp=this.record.historyWithoutCalls;
    if(!this.child||!stamp||!extendsHistory(input,stamp))return null;
    const calls=this.nativeCalls.filter(c=>!c.tool.local&&!this.record.delivered?.includes(c.id));
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
    const keys=fresh.map(inputKey);this.steers.set(uuid,keys);
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{if(this.queued.delete(uuid)){this.log('steering_unconfirmed',{});resolve();}},STEER_CONFIRM_MS);timer.unref();
      this.queued.set(uuid,{keys,release:()=>{clearTimeout(timer);this.queued.delete(uuid);resolve();}});
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
  // cache, up to 459k tokens per compaction. Anything that does not line up
  // keeps the import.
  async compactionFork(input,turnKey) {
    const id=digest(turnKey);
    const live=[...this.bridge.sessions.values()].find(x=>x.id===id);
    // A turn that just completed may still be closing its process.
    if(live?.exiting&&!live.stream)await live.exiting;
    // The desktop compacts in the middle of a turn after running its tool calls,
    // then continues in a new context and never answers the waiting session.
    // Stopping that session, as Stop does, lets the fork read the conversation
    // from the cache instead of importing it at the auto-compact limit.
    let used=null;
    if(live?.child&&!live.stream&&!live.accepting){used=live.lastUsed;live.cancel('compacted_mid_turn');await live.exiting;}
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
    // The record was last saved when the session's turn ended or was stopped. A
    // turn stopped just now last used the cache at its latest response.
    const cold=Date.now()-(used??fs.statSync(path.join(this.bridge.stateDir,`${id}.json`)).mtimeMs)>CACHE_TTL_MS;
    return {from:id.slice(0,12),claudeId:record.claudeId,model,ranModels:record.ranModels??[],effort:record.effort,prompt,tools:JSON.parse(tools),extra,cold,stopped:record.inflight?record.stop:null};
  }
  // After a compaction in the middle of a turn, the desktop continues in a new
  // context window and never answers the old session's pending tool call, so
  // that Claude process waited until the bridge restarted.
  releaseCompactedTurn() {
    const turn=this.turnKey&&this.bridge.sessions.get(this.turnKey);
    if(turn?.child&&!turn.stream&&!turn.accepting)turn.cancel('compacted_mid_turn');
  }
  takeResult(id) {const r=this.results.get(id);this.results.delete(id);this.pending.delete(id);return r;}
  // items are every output the desktop recorded for one call, in order.
  deliverResult(items) {
    const id=items[0].call_id;
    if(!this.nativeCalls.some(c=>c.id===id)) throw new Error(`Unknown tool result ${id}; cannot safely continue this tool cycle.`);
    if(this.record.delivered?.includes(id)) return;
    const result={content:items.flatMap(item=>mcpResult(item.output).content)};
    this.record.delivered ??= []; this.record.delivered.push(id);
    this.results.set(id,result);this.pending.get(id)?.();
    this.log('tool_result',{call_id:id,...(items.length>1?{outputs:items.length}:{})});
  }
  async accept(body,res,onComplete) {
    if(this.accepting)throw new Error('This conversation is already accepting a request.');
    this.accepting=true;
    this.lastUsed=Date.now();
    // The desktop can stop or disconnect while the request is still being set up.
    let gone=!!res.destroyed;const left=()=>{gone=true;};res.once('close',left);
    try {await this.acceptRequest(body,res,onComplete,()=>gone);}
    catch(error){if(this.stream?.res===res)this.fail(error.message);throw error;}
    finally {this.accepting=false;res.off('close',left);}
  }
  async acceptRequest(body,res,onComplete,gone) {
    if(this.exiting) await this.exiting;
    if(this.stream && !this.stream.finished) throw new Error('This conversation already has an active response.');
    this.stopping=false;this.resumeItems=null;this.truncate=null;
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
    // The first process to start an alias reports its version, which renames
    // the model. A process keeps the name it started with, or its next tool
    // result would look like changed instructions and rebuild the session.
    const label=()=>this.child&&this.label?this.label:labelFor(model,this.bridge.startedModels?.get(model.slug));
    // In picker mode the bridge runs Claude's searches itself, with the app's
    // ChatGPT sign-in from this request, kept in memory only.
    const searching=body.__bridge_search;
    if(searching)this.searchAuth={...searching,context:searchContext(body.input)};
    const webSearch=searching?'bridge':this.bridge.webSearch&&offersWebSearch(body.tools)?'host':false;
    let name=label(),prompt=systemPrompt(body,{name,webSearch});
    if(this.child&&this.record.instructions!==digest(prompt)){await this.reset('instructions_changed');name=label();prompt=systemPrompt(body,{name,webSearch});}
    // Stop during host tool execution has no open model HTTP stream to abort.
    // A subsequent user message without results abandons that waiting cycle.
    // The desktop now records the stopped call as "aborted by user" and notes
    // the Stop with <turn_aborted>, so that note ends the cycle too.
    if(this.child&&!superseded&&(userStopped(newNotes(body.input,this.record.history))||!body.input.some(x=>isResult(x)&&this.nativeCalls.some(c=>c.id===x.call_id)&&!this.record.delivered?.includes(x.call_id))&&
      (body.input.some(x=>isIncoming(x)&&!this.pendingSeen.includes(inputKey(x)))||newNotes(body.input,this.record.history).length))) {
      this.cancel('tool_cycle_interrupted');await this.exiting;await this.resumeOrRecover(body);
    }
    const originalInput=body.input;
    const bounded=boundToolImages(originalInput,this.record.imageCutoff??0,this.record.userImageCutoff??0,Buffer.byteLength(JSON.stringify({...body,input:[]})));
    if((bounded.cutoff!==(this.record.imageCutoff??0)||bounded.userCutoff!==(this.record.userImageCutoff??0))&&(this.child||this.record.started||this.resumeItems))await this.reset('image_history_bounded');
    this.record.imageCutoff=bounded.cutoff;this.record.userImageCutoff=bounded.userCutoff;
    body={...body,input:bounded.input};
    assertModelInputFits(body);
    // A new inference request with no new user message can be regeneration.
    // Exact transport retries have already been handled by the response cache.
    if(!this.child&&this.record.started&&!this.resumeItems&&!body.input.some(x=>isIncoming(x)&&!this.record.seen.includes(inputKey(x))))await this.reset('regeneration_rebuilt');
    const tools=[...normalizeTools(body.tools),...(searching?[WEB_RUN_TOOL]:[])];
    if(new Set(tools.map(t=>t.name)).size!==tools.length) throw new Error('Tool names collide after MCP name normalization.');
    this.tools=tools;
    if(tools.length&&!body.__bridge_compaction)this.record.toolSet=saveToolSet(this.bridge.stateDir,tools);
    this.sequential=body.parallel_tool_calls===false;
    this.stream=body.__bridge_compaction?new CompactionStream(res,this.bridge.token,model.slug):new ResponseStream(res,model.slug);this.textIndices=[];this.usage={input_tokens:0,output_tokens:0,total_tokens:0};
    this.stream.onComplete=onComplete;
    this.streamInput=originalInput;
    const activeStream=this.stream;
    res.on('close',()=> {if(!activeStream.finished && this.stream===activeStream)this.cancel('Desktop cancelled or disconnected.');});
    if(gone()){this.cancel('Desktop cancelled or disconnected.');return;}
    if(this.child) {
      await this.mcp.sendToolListChanged().catch(()=>{});
      if(superseded) {
        const fresh=this.withNotes(body.input,body.input.filter(x=>isIncoming(x)&&!this.pendingSeen.includes(inputKey(x))),this.record.historyWithoutCalls);
        this.pendingSeen.push(...fresh.map(inputKey));
        await this.steer(fresh);
        if(this.stream!==activeStream)return;
        for(const call of superseded)this.supersede(call);
        return;
      }
      const results=body.input.filter(isResult).filter(x=>this.nativeCalls.some(c=>c.id===x.call_id));
      if(!results.length) throw new Error('Claude is waiting for a tool result, but the next request supplied none.');
      const fresh=this.withNotes(body.input,body.input.filter(x=>isIncoming(x)&&!this.pendingSeen.includes(inputKey(x))),this.record.history);
      if(fresh.length) {
        this.pendingSeen.push(...fresh.map(inputKey));
        await this.steer(fresh);
        // Stopped while the message waited: the results go to the resumed session.
        if(this.stream!==activeStream)return;
      }
      // Code mode's notify() records extra outputs for the same exec call.
      for(const id of new Set(results.map(x=>x.call_id)))this.deliverResult(results.filter(x=>x.call_id===id));
      // With parallel_tool_calls=false, calls from one Claude message are
      // relayed one per response. Claude waits on the held call's MCP result.
      const held=this.nativeCalls.find(c=>!c.emitted);
      if(held)this.emitCalls([held]);
      return;
    }
    await this.launch({body,originalInput,model,name,prompt,activeStream});
  }
  // Starts Claude Code for the request's turn.
  async launch(context) {
    const {body,originalInput,model,name,prompt,activeStream}=context;
    this.turnKey=body.__bridge_turn_key;
    let fork=body.__bridge_compaction&&!this.record.started&&body.__bridge_turn_key?await this.compactionFork(originalInput,body.__bridge_turn_key):null;
    if(fork?.reason){this.log('compaction_import',{reason:fork.reason});fork=null;}
    if(fork){this.tools=fork.tools;this.log('compaction_fork',{from:fork.from,extra_items:fork.extra.length,cold:fork.cold,stopped:fork.stopped?.reason??null});}
    await this.setupMcp();
    const users=body.input.filter(isIncoming);
    const key=inputKey;
    const fresh=users.filter(x=>!this.record.seen.includes(key(x)));
    let input;
    if(fork) {
      input=[...(fork.stopped?stoppedTurnNote(fork.extra,fork.stopped):[]),...(fork.extra.length?userInput(fork.extra,{replay:true,prefix:false}):[]),{type:'text',text:COMPACTION_REQUEST}];
    } else if(this.resumeItems) {
      input=resumeAfterStop(this.resumeItems,this.record.stop);
    } else if(this.record.started) {
      if(!fresh.length) throw new Error('No new user input. Replaying a completed request would duplicate the turn.');
      const other=otherModelTurns(body.input,this.record.history);
      if(other)this.log('other_model_turns',{items:other.length});
      input=other?[{type:'text',text:OTHER_MODEL_NOTE},...userInput(other,{replay:true,prefix:false}),...replayImageNote(other,{otherModel:true})]:userInput(this.withNotes(body.input,fresh,this.record.history),{prefix:false});
    } else {
      const replay=body.input.some(x=>x.role==='assistant'||isCallResult(x)||['function_call','custom_tool_call'].includes(x.type)&&!isHostCall(x));
      input=[...userInput(body.input,{replay}),...(replay?replayImageNote(body.input):[])];
      if(replay)this.log('history_import',{reason:'new_or_compacted_context'});
    }
    // A message the desktop resent mid-response is a mid-turn message, which gets no time note.
    const steered=!fork&&this.resumeItems&&resampledSteer(this.resumeItems,this.record.stop?.reason);
    // A goal continuation names update_goal, which code mode runs only inside exec.
    if(!body.__bridge_compaction)input=[...input,...goalToolNote(body.input,body.tools)];
    if(!body.__bridge_compaction&&!steered&&userTurn(body.input))input=[...input,timeNote(Date.now(),this.record.lastReplyAt)];
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
    // The config holds the bridge token, which any local user could read from
    // the process list if it were passed inline.
    const mcpFile=path.join(this.bridge.stateDir,`${this.id}.mcp.json`);
    fs.writeFileSync(mcpFile,JSON.stringify(config),{mode:0o600});
    this.record.instructions=digest(fork?.prompt??prompt);this.record.effort=effort;this.record.model=runModel.slug;
    this.schema=outputSchema(body);
    // Claude Code 2.1.300 resumes at a given entry and drops what follows. It
    // refuses when the dropped part holds anything but the named turn, such as
    // a queued message or another turn.
    const truncate=this.truncate;this.truncate=null;
    const args=['-p','--model',runModel.claude_model,...(effort?['--effort',effort]:[]),'--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages',
      '--tools','','--strict-mcp-config','--mcp-config',mcpFile,'--allowedTools','mcp__chatgpt__*','--permission-mode','dontAsk',
      '--setting-sources','','--disable-slash-commands','--system-prompt-snapshot','off','--system-prompt-file',systemFile,
      ...(this.schema?['--json-schema',JSON.stringify(this.schema)]:[]),
      ...(fork?['--resume',fork.claudeId,'--fork-session']:[this.record.started||this.resumeItems?'--resume':'--session-id',this.record.claudeId]),
      ...(truncate?['--resume-session-at',truncate.at,'--resume-drops-turn',truncate.prompt]:[])];
    const env={...process.env};
    for(const name of Object.keys(env))if((name.startsWith('ANTHROPIC_')||name.startsWith('CLAUDE_')||name.startsWith('CODEX_'))&&!KEEP_ENV.has(name))delete env[name];
    // Once Claude Code has reported the model an alias starts, every internal
    // model choice is pinned to it, so one model does all the work.
    const pinned=this.bridge.resolvedModels.get(runModel.slug)??(runModel.family?null:runModel.claude_model);
    if(pinned)Object.assign(env,{ANTHROPIC_DEFAULT_FABLE_MODEL:pinned,ANTHROPIC_DEFAULT_OPUS_MODEL:pinned,ANTHROPIC_DEFAULT_SONNET_MODEL:pinned,ANTHROPIC_DEFAULT_HAIKU_MODEL:pinned,CLAUDE_CODE_SUBAGENT_MODEL:pinned});
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
    if(this.stream!==activeStream)return;
    // Claude Code carries a session's usage totals across --resume and forks,
    // so models the session ran on before are expected in them.
    if(fork)this.record.ranModels=[...new Set([...(this.record.ranModels??[]),...fork.ranModels])];
    this.runModel=runModel;this.activeModel=null;this.label=name;
    this.child=spawn(this.bridge.claude,args,{cwd:this.bridge.claudeCwd,env,stdio:['pipe','pipe','pipe']});
    this.stopping=false;
    const child=this.child;this.stderr='';this.nativeCalls=[];this.ready=false;this.forked=!!fork;
    this.steers.clear();this.deferredStop=null;this.lastAssistant=null;this.apiError=null;this.refusal=null;this.truncating=!!truncate;
    // Where a withdrawn turn returns to: the end of the last completed turn.
    // A truncating resume keeps the same point.
    if(!truncate)this.record.settled=!fork&&this.record.started&&!this.record.inflight&&this.record.turnEnd?{history:this.record.history,at:this.record.turnEnd}:null;
    // Claude Code keeps the uuid of a stream-json message as its transcript entry's uuid.
    const promptId=randomUUID();this.record.prompt=fork?null:promptId;
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
      // Claude Code refused to drop the withdrawn turn, or ended before init:
      // this request rebuilds instead.
      const refused=!!truncate&&!this.ready&&!this.stopping&&this.stream===activeStream&&!activeStream.finished;
      if(refused)this.log('withdrawn_turn_refused',{code,signal,message:(this.refusal||this.stderr).slice(0,300)});
      else if(this.stream&&!this.stream.finished)this.fail(`Claude Code exited before completion (${code??signal}). ${this.stderr}`);
      // Claude Code exited on its own while the host ran a tool: 2 of 3 turns
      // cut off by a restart in the separate-window bridge's log, where the
      // restart signalled Claude Code 2.5 s before the bridge. It records the
      // waiting call as failed.
      else if(!this.stopping&&this.ready&&this.record.inflight&&this.nativeCalls.some(c=>c.emitted&&!c.tool.local&&!this.record.delivered?.includes(c.id)))this.saveStop(CLAUDE_EXITED);
      this.log('claude_exit',{code,signal});
      this.exiting=null;this.lastUsed=Date.now();resolve();
      if(refused)this.relaunch(context);
    }));
    child.stdin.on('error',e=>this.fail(`Claude input closed: ${e.message}`));
    child.stdin.write(JSON.stringify({type:'user',uuid:promptId,message:{role:'user',content:asPrompt(input)},session_id:this.record.claudeId,parent_tool_use_id:null})+'\n');
  }
  async relaunch(context) {
    const {imageCutoff,userImageCutoff,toolSet}=this.record;
    try {
      await this.reset('interrupted_turn_recovery');
      Object.assign(this.record,{imageCutoff,userImageCutoff,toolSet});
      if(this.stream===context.activeStream&&!context.activeStream.finished)await this.launch(context);
    } catch(error){if(this.stream===context.activeStream)this.fail(error.message);}
  }
  onEvent(msg) {
    if(this.stopping) {
      // A turn stopped before init: Claude Code has now recorded its input.
      if(this.deferredStop&&msg.type==='system'&&msg.subtype==='init') {
        const {reason}=this.deferredStop;this.deferredStop=null;this.ready=true;
        this.saveStop(reason);this.log('stopped_at_init',{reason});this.stopChild('SIGINT');
      }
      return;
    }
    if(msg.type==='command_lifecycle') {
      if(msg.state==='queued')this.queued.get(msg.command_uuid)?.release();
      // Claude Code records a queued message once it adds it to the conversation.
      if(msg.state==='started')this.steers.delete(msg.command_uuid);
      return;
    }
    // Claude Code refuses a truncating resume before init.
    if(msg.type==='result'&&msg.is_error&&this.truncating&&!this.ready){this.refusal=String(msg.errors?.join(' ')||msg.result||'');this.child?.stdin.end();return;}
    if(['assistant','stream_event','result'].includes(msg.type)&&!(msg.type==='result'&&msg.queued_turn_count>0)&&(!this.stream||this.stream.finished)) {
      this.fail('Claude advanced without an active desktop response. Recovering from the desktop transcript on the next request.');
      return;
    }
    if(msg.type==='system'&&msg.subtype==='init') {
      if(!startedModelMatches(this.runModel,msg.model))throw new Error(`Claude Code started ${msg.model} for ${this.runModel.display_name} (${this.runModel.claude_model}). The bridge does not switch models silently.`);
      this.activeModel=msg.model;this.bridge.resolvedModels.set(this.runModel.slug,msg.model);this.bridge.modelStarted?.(this.runModel.slug,msg.model);
      const host=msg.mcp_servers?.find(x=>x.name==='chatgpt');
      if(this.tools.length && host?.status!=='connected')throw new Error('Claude could not connect to the desktop tool relay.');
      // Claude Code reports init only after it has recorded the turn's input.
      this.ready=!this.forked;
      this.log('claude_ready',{model:msg.model,tools:msg.tools});
    }
    if(msg.type==='assistant') {
      if(msg.message.model!=='<synthetic>'&&msg.message.model!==this.activeModel)throw modelChanged(msg.message.model,this.activeModel);
      // Claude Code reports an API error as a synthetic message with the error's kind.
      if(msg.message.model==='<synthetic>'&&msg.error)this.apiError=msg.error;
      else if(msg.uuid)this.lastAssistant=msg.uuid;
      for(const c of msg.message.content??[])if(c.type==='tool_use') {
        if(this.schema&&c.name==='StructuredOutput')continue;
        const name=c.name.replace(/^mcp__chatgpt__/, '');const tool=this.tools.find(t=>t.name===name);
        // Claude Code itself answers an unknown tool with an error result and the
        // model retries, so a hallucinated name must not end the turn.
        if(!tool){this.log('unknown_tool',{name:c.name});continue;}
        // A compaction fork lists the session's tools only so the cache matches. Nothing runs.
        const compacting=this.stream instanceof CompactionStream;
        const problem=!compacting&&cardProblem(tool,c.input);
        this.nativeCalls.push({id:c.id,args:c.input,tool,emitted:compacting||!!problem||!!tool.local,message:this.messageCount});
        if(compacting) {
          this.results.set(c.id,{isError:true,content:[{type:'text',text:'Not run: the host is compacting this conversation. Reply only with the checkpoint.'}]});
          this.log('compaction_tool_refused',{name:tool.originalName});
        } else if(problem) {
          this.results.set(c.id,{isError:true,content:[{type:'text',text:'Not shown to the user: '+problem}]});
          this.log('question_card_refused',{questions:c.input?.questions?.length,longest:Math.max(0,...(c.input?.questions??[]).map(q=>String(q?.title??'').length))});
        }
        for(const wake of this.callWaiters)wake();
      }
    }
    if(msg.type==='stream_event') {
      const e=msg.event;
      if(e.type==='message_start') {
        this.messageCount=(this.messageCount??0)+1;
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
        // A search the bridge runs is a tool call too, though not the host's.
        const acting=calls.length||this.nativeCalls.some(x=>x.tool.local&&x.message===this.messageCount);
        // Opus sometimes answers a mid-turn message only in thinking, which the
        // desktop never shows. A short thought before the next tool call is that
        // answer, so it is shown as commentary.
        if(this.ack&&acting&&!this.textIndices.length) {
          const said=this.ack.thinking.trim();
          if(said&&said.length<=ACK_THINKING_MAX){const i=this.stream.startText();this.stream.text(i,said);this.textIndices.push(i);this.log('steering_ack_from_thinking',{chars:said.length});}
          else this.log('steering_unanswered',{thinking_chars:said.length});
        }
        if(this.ack&&(acting||this.textIndices.length))this.ack=null;
        // Under a JSON schema, only the validated structured value is the answer.
        for(const i of this.textIndices)this.stream.finishText(i,!calls.length&&this.stopReason!=='tool_use'&&!this.schema);
        this.textIndices=[];
        for(const c of this.nativeCalls)if(c.tool.local&&!c.done&&!this.results.has(c.id))this.showSearch(c);
        if(calls.length)this.emitCalls(this.sequential?calls.slice(0,1):calls);
      }
    }
    if(msg.type==='result') {
      // Answers were already checked message by message. Other usage would be
      // Claude Code background work, which the pins above normally prevent.
      const others=Object.keys(msg.modelUsage??{}).filter(x=>x!==this.activeModel&&!this.record.ranModels?.includes(x));
      if(others.length)this.log('other_model_usage',{models:others});
      if(this.activeModel)this.record.ranModels=[...new Set([...(this.record.ranModels??[]),this.activeModel])];
      if(msg.is_error) {
        // An API error (an overload, a usage limit, an expired login) rebuilt
        // the session 7 times in the separate-window bridge's log from
        // September 24 to October 6, 2026. Claude Code keeps the turn's input
        // and its queued messages and leaves the error message out of the next
        // request, so the turn resumes instead.
        if(this.ready&&this.record.inflight&&!(this.stream instanceof CompactionStream)&&(msg.api_error_status!=null||this.apiError))
          this.saveStop(API_FAILED,{unseen:[...this.steers.values()].flat(),replied:false,status:msg.api_error_status??null});
        throw new Error(msg.result||msg.errors?.join('\n')||`Claude failed: ${msg.subtype}`);
      }
      if(msg.permission_denials?.length)throw new Error('Claude tool relay permission denied.');
      if(msg.queued_turn_count>0){this.log('queued_user_turn',{count:msg.queued_turn_count});return;}
      if(this.schema) {
        if(msg.structured_output===undefined)throw new Error('Claude did not return the requested structured output.');
        const i=this.stream.startText();this.stream.text(i,JSON.stringify(msg.structured_output));this.stream.finishText(i,true);
      }
      this.record.started=true;this.record.inflight=false;this.record.seen=this.pendingSeen;this.record.turnEnd=this.lastAssistant;this.save();this.log('turn_complete',{model:this.activeModel,context_window:msg.modelUsage?.[this.activeModel]?.contextWindow});
      const compacted=this.stream instanceof CompactionStream&&!!this.stream.summary.trim();
      this.completeStream();
      if(compacted)this.releaseCompactedTurn();
      const child=this.child;
      if(child){this.exiting=this.childDone;child.stdin.end();this.reap(child);}
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
    this.record.lastReplyAt=Date.now();this.save();
    this.usage.total_tokens=this.usage.input_tokens+this.usage.output_tokens;this.stream?.complete(this.usage);
    this.releaseResponse();
  }
  releaseResponse() {
    if(this.stream&&!this.stream.finished)return;
    if(this.stream){this.stream.onComplete=null;this.stream.frames=[];this.stream.output=[];this.stream.res=null;}
    this.stream=null;this.streamInput=null;this.textIndices=[];this.lastUsed=Date.now();
  }
  // Claude Code exits within about 3 s of its input closing (1,919 turns). One
  // that hangs is stopped, or the thread's next request would wait forever.
  reap(child) {
    const grace=this.bridge.exitGraceMs??15000;
    const term=setTimeout(()=>{if(this.child===child){this.log('claude_exit_overdue',{});child.kill('SIGTERM');}},grace);term.unref();
    const kill=setTimeout(()=>{if(this.child===child)child.kill('SIGKILL');},grace+5000);kill.unref();
    this.childDone.finally(()=>{clearTimeout(term);clearTimeout(kill);});
  }
  stopChild(signal) {
    const child=this.child;if(!child)return;
    this.stopping=true;this.exiting=this.childDone;
    child.kill(signal);
    const term=setTimeout(()=>{if(this.child===child)child.kill('SIGTERM');},3000);term.unref();
    const kill=setTimeout(()=>{if(this.child===child)child.kill('SIGKILL');},6000);kill.unref();
    this.childDone.finally(()=>{clearTimeout(term);clearTimeout(kill);});
  }
  fail(message) {this.log('error',{message});this.abortSearches();this.stream?.fail(message);this.releaseResponse();this.stopChild('SIGTERM');}
  // What the stopped session saw, so a resume sends only the rest. By default
  // a mid-turn message Claude Code had not yet queued is sent again on resume.
  saveStop(reason,{unseen=[...this.queued.values()].flatMap(q=>q.keys),replied=!!this.stream,...detail}={}) {
    const sent=this.nativeCalls.filter(c=>c.emitted&&!c.tool.local&&!this.record.delivered?.includes(c.id)).length;
    this.record.stop={reason,seen:this.pendingSeen.filter(k=>!unseen.includes(k)),sent,...detail};if(replied)this.record.lastReplyAt=Date.now();this.save();
  }
  abortSearches() {this.searchAbort?.abort();this.searchAbort=null;}
  cancel(reason) {
    this.log('cancel',{reason});this.abortSearches();
    if(this.child&&!this.stopping&&this.record.inflight) {
      if(this.ready)this.saveStop(reason);
      // Claude Code records a turn's input just before it reports init, and a
      // signal before then leaves nothing. In the separate-window bridge's
      // log, 3 Stops before init left the input recorded in 1 and not in 2.
      // Stopping at init leaves it recorded exactly once.
      else if(!this.forked){this.stream?.end();this.releaseResponse();this.deferStop(reason);return;}
    }
    for(const q of [...this.queued.values()])q.release();
    this.stream?.end();this.releaseResponse();this.stopChild('SIGINT');
  }
  deferStop(reason) {
    const child=this.child;this.stopping=true;this.exiting=this.childDone;this.deferredStop={reason};
    const timer=setTimeout(()=>{
      if(this.child!==child||!this.deferredStop)return;
      this.deferredStop=null;this.log('init_overdue',{});this.stopChild('SIGTERM');
    },this.bridge.initWaitMs??INIT_WAIT_MS);timer.unref();
    this.childDone.finally(()=>clearTimeout(timer));
  }
}
