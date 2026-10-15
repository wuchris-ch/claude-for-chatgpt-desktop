#!/usr/bin/env node
// A deterministic protocol peer used only by the integration tests.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
// Like Claude Code, an alias resolves through the ANTHROPIC_DEFAULT_*_MODEL
// pins or its built-in table. FAKE_CLAUDE_MODEL simulates a substituted model.
const ALIASES={fable:'claude-fable-5-1',opus:'claude-opus-5-5',sonnet:'claude-sonnet-5-5',haiku:'claude-haiku-5-5'};
const PINS={fable:process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,opus:process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL};
const requested=arg('--model');
const model=process.env.FAKE_CLAUDE_MODEL||PINS[requested]||ALIASES[requested]||requested;
// Like Claude Code, --mcp-config takes a file path or inline JSON.
const mcpArg=arg('--mcp-config');
const config=JSON.parse(mcpArg.trimStart().startsWith('{')?mcpArg:fs.readFileSync(mcpArg,'utf8')).mcpServers.chatgpt;
const countFile=path.join(path.dirname(arg('--system-prompt-file')),'fake-starts');
fs.appendFileSync(countFile,'start\n');
// Like a Claude Code transcript: every prompt and assistant message by uuid, in order.
const entriesFile=path.join(path.dirname(arg('--system-prompt-file')),'fake-entries');
const entry=x=>fs.appendFileSync(entriesFile,JSON.stringify({session:process.argv.includes('--resume')?arg('--resume'):arg('--session-id'),...x})+'\n');
const entries=()=>fs.existsSync(entriesFile)?fs.readFileSync(entriesFile,'utf8').trim().split('\n').map(l=>JSON.parse(l)):[];
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const event=x=>send({type:'stream_event',event:x});
const assistant=content=>{const uuid=randomUUID();entry({kind:'assistant',uuid});send({type:'assistant',uuid,message:{model,content}});};
const start=()=>event({type:'message_start',message:{model,usage:{input_tokens:10}}});
const finish=()=>{event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}});event({type:'message_stop'});send({type:'result',is_error:false,modelUsage:{[model]:{contextWindow:1000000}},permission_denials:[]});};
const text=value=>{start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:value}});assistant([{type:'text',text:value}]);finish();};
// Mirrors Claude Code 2.1.300: an API error is a synthetic message, then an error result naming the status.
const apiError=status=>{send({type:'assistant',uuid:randomUUID(),error:status===429?'rate_limit':'server_error',message:{model:'<synthetic>',content:[{type:'text',text:`API Error: ${status} Overloaded.`}]}});
 send({type:'result',subtype:'success',is_error:true,api_error_status:status,result:`API Error: ${status} Overloaded.`,modelUsage:{},permission_denials:[]});};
const client=new Client({name:'fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
const listed=await client.listTools();
const input=readline.createInterface({input:process.stdin});
// Like Claude Code, input that arrives while a tool call waits joins the same turn after the result.
// linger-after-turn: a process that keeps running after its input closes.
let busy=false,linger=false,initialized=false;const queued=[],queuedIds=[];
// Mirrors Claude Code: a queued message is added to the conversation with the tool result.
const attachQueued=()=>{for(const id of queuedIds.splice(0))send({type:'command_lifecycle',command_uuid:id,state:'started'});};
input.on('line',async line=>{
 const msg=JSON.parse(line);const request=JSON.stringify(msg.message.content);
 if(!initialized) {
  initialized=true;
  // Claude Code 2.1.300 refuses a truncating resume before init when the dropped
  // part does not start with the named turn's prompt.
  if(process.argv.includes('--resume-session-at')&&(request.includes('refuse-truncation')||!entries().some(e=>e.kind==='prompt'&&e.uuid===arg('--resume-drops-turn')))) {
   send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Resume rejected by --resume-drops-turn: fixture refusal'],modelUsage:{},permission_denials:[]});process.exit(1);
  }
  // Like Claude Code, it records the prompt and then reports init.
  entry({kind:'prompt',uuid:msg.uuid,text:request.slice(0,80)});
  const fresh=!request.includes('<history_message');
  if(fresh&&request.includes('never-init'))return;
  // slow-init-<ms> in the message, or slow-init in the instructions: Claude Code
  // still loading a long session when the desktop stops.
  const slow=fresh&&/slow-init-(\d+)/.exec(request);
  const wait=slow?Number(slow[1]):fs.readFileSync(arg('--system-prompt-file'),'utf8').includes('slow-init')?1500:0;
  if(wait)await new Promise(r=>setTimeout(r,wait));
  send({type:'system',subtype:'init',model,tools:['mcp__chatgpt__exec'],mcp_servers:[{name:'chatgpt',status:'connected'}]});
  if(process.argv.includes('--resume-session-at')){text('TRUNCATED '+JSON.stringify({resume:arg('--resume'),at:arg('--resume-session-at'),drops:arg('--resume-drops-turn'),request}));return;}
 }
 if(request.includes('linger-after-turn'))linger=true;
 // Like Claude Code, a message sent with a uuid is confirmed once queued. A large
 // message (an image) can finish parsing after a tool result has returned.
 const confirm=()=>{if(msg.uuid&&!request.includes('never-queued'))send({type:'command_lifecycle',command_uuid:msg.uuid,state:'queued'});};
 if(busy){if(request.includes('slow-queue'))setTimeout(()=>{queued.push(msg.message.content);queuedIds.push(msg.uuid);confirm();},300);else{queued.push(msg.message.content);queuedIds.push(msg.uuid);confirm();}return;}
 confirm();
 if(process.argv.includes('--json-schema')) {
  // Mirrors Claude Code 2.1.280: commentary, a synthetic StructuredOutput tool call, then result.structured_output.
  const schema=JSON.parse(arg('--json-schema'));if(schema.$schema){text('REJECTED $schema');return;}const value={title:'Fixture title',required:schema.required??null};
  start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Choosing a title.'}});
  assistant([{type:'text',text:'Choosing a title.'},{type:'tool_use',id:'toolu_structured',name:'StructuredOutput',input:value}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  send({type:'result',is_error:false,modelUsage:{[model]:{contextWindow:1000000}},permission_denials:[],result:JSON.stringify(value),structured_output:value});return;
 }
 // A goal continuation. Like Haiku on October 14, 2026, the fixture calls
 // update_goal as a top-level tool unless told that the host runs it in exec.
 if(request.includes('codex_internal_context source=')) {
  start();
  if(!request.includes('tools.update_goal')) {
   send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_goal_top',name:'mcp__chatgpt__update_goal',input:{status:'complete'}}]}});
   event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
   send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_goal_top',is_error:true,content:'No such tool available: mcp__chatgpt__update_goal'}]}});
   start();
  }
  const args={input:'text(await tools.update_goal({status:"complete"}));'};
  send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_goal',name:'mcp__chatgpt__exec',input:args}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  busy=true;const result=await client.callTool({name:'exec',arguments:args});busy=false;
  text('GOAL '+JSON.stringify(result));return;
 }
 if(request.includes('echo-input')){text('ECHO '+request);return;}
 // Stands in for a long think: no stream events at all until the answer.
 if(request.includes('silent-think')){setTimeout(()=>text('AWAKE'),Number(/silent-think-(\d+)/.exec(request)?.[1]??1000));return;}
 if(request.includes('env-probe')){text('ENV '+process.env.MCP_TOOL_TIMEOUT+' '+process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH+' idle:'+process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT+' output:'+process.env.MAX_MCP_OUTPUT_TOKENS+' size:'+listed.tools[0]?._meta?.['anthropic/maxResultSizeChars']+' token:'+(process.env.CLAUDE_CODE_OAUTH_TOKEN??'none'));return;}
 if(request.includes('auth-probe')){text('AUTH '+JSON.stringify({key:process.env.ANTHROPIC_API_KEY??null,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN??null,base:process.env.ANTHROPIC_BASE_URL??null,configDir:process.env.CLAUDE_CONFIG_DIR??null}));return;}
 if(request.includes('model-probe')){
  const prompt=fs.readFileSync(arg('--system-prompt-file'),'utf8');
  text('MODEL '+JSON.stringify({requested,model,effort:process.argv.includes('--effort')?arg('--effort'):null,resume:process.argv.includes('--resume'),
   pins:{fable:PINS.fable??null,opus:PINS.opus??null,sonnet:PINS.sonnet??null,haiku:PINS.haiku??null,subagent:process.env.CLAUDE_CODE_SUBAGENT_MODEL??null},
   identity:/You are ([^,]+), the main assistant/.exec(prompt)?.[1]??null,webSearch:prompt.includes('tools.web__run')||prompt.includes('web_run tool')}));return;
 }
 // Claude Code re-running a flagged request on a fallback model mid-turn.
 if(request.includes('fallback-model')){
  start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Partial'}});
  send({type:'assistant',message:{model:'claude-opus-4-8',content:[{type:'text',text:'Partial'}]}});return;
 }
 if(request.includes('unknown-tool')) {
  start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Searching.'}});
  assistant([{type:'text',text:'Searching.'},{type:'tool_use',id:'toolu_ghost',name:'web_run',input:{}}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  // Mirrors Claude Code: an unknown tool gets a native error result and the model continues.
  send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_ghost',is_error:true,content:'No such tool available: web_run'}]}});
  text('Recovered');return;
 }
 // A web search through the bridge's own tool, optionally with a host call in the same message.
 if(request.includes('web-search-tool')) {
  const args={search_query:[{q:'bridge fixture query'}]},exec={input:'text("side");'},both=request.includes('with-exec');start();
  assistant([{type:'tool_use',id:'toolu_search',name:'mcp__chatgpt__web_run',input:args},...(both?[{type:'tool_use',id:'toolu_side',name:'mcp__chatgpt__exec',input:exec}]:[])]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  busy=true;const [found,side]=await Promise.all([client.callTool({name:'web_run',arguments:args}),both?client.callTool({name:'exec',arguments:exec}):null]);busy=false;
  text('SEARCHED '+JSON.stringify({found,side,tools:listed.tools.map(t=>t.name),prompt:fs.readFileSync(arg('--system-prompt-file'),'utf8').includes('top-level web_run tool')}));return;
 }
 if(request.includes('two-tools')) {
  const first={input:'text("one");'},second={input:'text("two");'};start();
  assistant([{type:'tool_use',id:'toolu_one',name:'mcp__chatgpt__exec',input:first},{type:'tool_use',id:'toolu_two',name:'mcp__chatgpt__exec',input:second}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  const results=[await client.callTool({name:'exec',arguments:first}),await client.callTool({name:'exec',arguments:second})];
  text('RESULTS '+JSON.stringify(results));return;
 }
 if(request.includes('compaction_request')) {
  const report=extra=>text('FORK '+JSON.stringify({fork:process.argv.includes('--fork-session'),resume:arg('--resume'),model,effort:process.argv.includes('--effort')?arg('--effort'):null,tools:listed.tools.map(t=>t.name),prompt:fs.readFileSync(arg('--system-prompt-file'),'utf8').slice(0,40),request:request.slice(0,4000),caching:process.env.DISABLE_PROMPT_CACHING?'off':'on',...extra}));
  if(!request.includes('call-tool-first')){report({});return;}
  const args={input:'text("during compaction");'};start();
  assistant([{type:'tool_use',id:'toolu_compacting',name:'mcp__chatgpt__exec',input:args}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  report({toolResult:await client.callTool({name:'exec',arguments:args})});return;
 }
 // A resumed stopped turn reports how it was started and what it was sent.
 if(request.includes('turn_stopped')){text('RESUMED '+JSON.stringify({resume:process.argv.includes('--resume')?arg('--resume'):null,request}));return;}
 if(request.includes('<history_message')) {
  const transcript=msg.message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  text('REPLAY '+JSON.stringify({input:transcript.length<5000?transcript:transcript.slice(0,500)+'\n'+transcript.slice(-1500),images:msg.message.content.filter(c=>c.type==='image').length,bytes:request.length,updatedPolicy:fs.readFileSync(arg('--system-prompt-file'),'utf8').includes('UPDATED-POLICY')}));return;
 }
 if(request.includes('api-error-')){apiError(Number(/api-error-(\d+)/.exec(request)[1]));return;}
 // An error result that is not an API error.
 if(request.includes('plain-error')){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['fixture failure'],modelUsage:{},permission_denials:[]});return;}
 if(request.includes('question-card')) {
  // Four questions, one 700-character question, or a card the desktop can show.
  const q=title=>({title,options:['Yes','No']});
  const args={questions:request.includes('question-card-four')?['A?','B?','C?','D?'].map(q):request.includes('question-card-long')?[q('L'.repeat(700)+'?')]:[q('A?'),q('B?')]};start();
  assistant([{type:'tool_use',id:'toolu_card',name:'mcp__chatgpt__request_user_input_async',input:args}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  text('CARD '+JSON.stringify(await client.callTool({name:'request_user_input_async',arguments:args})));return;
 }
 if(request.includes('sleep-tool')) {
  // A host sleep the desktop never answers, as after a Stop in the desktop.
  const args={duration_ms:50};start();
  assistant([{type:'tool_use',id:'toolu_sleep',name:'mcp__chatgpt__clock_sleep',input:args}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  busy=true;await client.callTool({name:'clock_sleep',arguments:args}).catch(()=>{});busy=false;text('SLEPT');return;
 }
 if(request.includes('slow-response')){start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'waiting'}});return;}
 if(request.includes('invoke-tool')||request.includes('racing-tool')||request.includes('timeout-tool')||request.includes('stop-after-tool')||request.includes('tool-then-api-error')||request.includes('abort-on-sigint')){
  const args={input:'text("hello");\ntext(42);'};start();
  const early=request.includes('racing-tool')?client.callTool({name:'exec',arguments:args}):null;
  if(early)await new Promise(r=>setTimeout(r,150));
  assistant([{type:'tool_use',id:'toolu_fixture',name:'mcp__chatgpt__exec',input:args}]);
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  let result;busy=true;
  // Like Claude Code, an interrupt while a tool runs cancels the MCP call, records it as rejected and exits.
  const abort=new AbortController();
  if(request.includes('abort-on-sigint'))process.on('SIGINT',()=>{abort.abort();setTimeout(()=>process.exit(0),100);});
  try {result=await(early??client.callTool({name:'exec',arguments:args},undefined,request.includes('timeout-tool')?{timeout:150}:{signal:abort.signal}));}
  catch(error){busy=false;if(abort.signal.aborted)return;text('NATIVE RETRY THAT MUST NOT BE LOST');return;}
  busy=false;
  if(request.includes('tool-then-api-error')){if(!request.includes('unstarted'))attachQueued();apiError(429);return;}
  if(request.includes('stop-after-tool')) {process.on('SIGINT',()=>setTimeout(()=>process.exit(130),250));start();event({type:'content_block_start',index:0,content_block:{type:'text',text:'waiting after tool'}});return;}
  if(JSON.stringify(queued).includes('think-only')) {
   // Opus answering the message only in thinking, then calling the next tool.
   queued.splice(0);const next={input:'text("next");'};start();
   event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
   event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Got it, switching to the other worker.'}});
   assistant([{type:'thinking',thinking:'Got it, switching to the other worker.'},{type:'tool_use',id:'toolu_next',name:'mcp__chatgpt__exec',input:next}]);
   event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
   busy=true;await client.callTool({name:'exec',arguments:next});busy=false;text('DONE');return;
  }
  text('RESULT '+JSON.stringify(result)+(queued.length?' STEERED '+JSON.stringify(queued.splice(0)):''));
 }else text('FINAL '+request);
});
input.on('close',async()=>{await client.close();if(linger){setInterval(()=>{},1000);return;}process.exit(0);});
process.on('SIGINT',()=>{if(process.listenerCount('SIGINT')===1)process.exit(130);});
