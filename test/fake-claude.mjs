#!/usr/bin/env node
// A deterministic protocol peer used only by the integration tests.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
// Like Claude Code, an alias resolves through the ANTHROPIC_DEFAULT_*_MODEL
// pins or its built-in table. FAKE_CLAUDE_MODEL simulates a substituted model.
const ALIASES={fable:'claude-fable-5-1',opus:'claude-opus-5-5',sonnet:'claude-sonnet-5-5',haiku:'claude-haiku-5-5'};
const PINS={fable:process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,opus:process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL};
const requested=arg('--model');
const model=process.env.FAKE_CLAUDE_MODEL||PINS[requested]||ALIASES[requested]||requested;
const config=JSON.parse(arg('--mcp-config')).mcpServers.chatgpt;
const countFile=path.join(path.dirname(arg('--system-prompt-file')),'fake-starts');
fs.appendFileSync(countFile,'start\n');
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
const event=x=>send({type:'stream_event',event:x});
const start=()=>event({type:'message_start',message:{model,usage:{input_tokens:10}}});
const finish=()=>{event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}});event({type:'message_stop'});send({type:'result',is_error:false,modelUsage:{[model]:{contextWindow:1000000}},permission_denials:[]});};
const text=value=>{start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:value}});send({type:'assistant',message:{model,content:[{type:'text',text:value}]}});finish();};
const client=new Client({name:'fixture',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
const listed=await client.listTools();
send({type:'system',subtype:'init',model,tools:['mcp__chatgpt__exec'],mcp_servers:[{name:'chatgpt',status:'connected'}]});
const input=readline.createInterface({input:process.stdin});
// Like Claude Code, input that arrives while a tool call waits joins the same turn after the result.
let busy=false;const queued=[];
input.on('line',async line=>{
 const msg=JSON.parse(line);const request=JSON.stringify(msg.message.content);
 // Like Claude Code, a message sent with a uuid is confirmed once queued. A large
 // message (an image) can finish parsing after a tool result has returned.
 const confirm=()=>{if(msg.uuid&&!request.includes('never-queued'))send({type:'command_lifecycle',command_uuid:msg.uuid,state:'queued'});};
 if(busy){if(request.includes('slow-queue'))setTimeout(()=>{queued.push(msg.message.content);confirm();},300);else{queued.push(msg.message.content);confirm();}return;}
 confirm();
 if(process.argv.includes('--json-schema')) {
  // Mirrors Claude Code 2.1.280: commentary, a synthetic StructuredOutput tool call, then result.structured_output.
  const schema=JSON.parse(arg('--json-schema'));if(schema.$schema){text('REJECTED $schema');return;}const value={title:'Fixture title',required:schema.required??null};
  start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Choosing a title.'}});
  send({type:'assistant',message:{model,content:[{type:'text',text:'Choosing a title.'},{type:'tool_use',id:'toolu_structured',name:'StructuredOutput',input:value}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  send({type:'result',is_error:false,modelUsage:{[model]:{contextWindow:1000000}},permission_denials:[],result:JSON.stringify(value),structured_output:value});return;
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
  send({type:'assistant',message:{model,content:[{type:'text',text:'Searching.'},{type:'tool_use',id:'toolu_ghost',name:'web_run',input:{}}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  // Mirrors Claude Code: an unknown tool gets a native error result and the model continues.
  send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_ghost',is_error:true,content:'No such tool available: web_run'}]}});
  text('Recovered');return;
 }
 if(request.includes('two-tools')) {
  const first={input:'text("one");'},second={input:'text("two");'};start();
  send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_one',name:'mcp__chatgpt__exec',input:first},{type:'tool_use',id:'toolu_two',name:'mcp__chatgpt__exec',input:second}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  const results=[await client.callTool({name:'exec',arguments:first}),await client.callTool({name:'exec',arguments:second})];
  text('RESULTS '+JSON.stringify(results));return;
 }
 if(request.includes('compaction_request')) {
  const report=extra=>text('FORK '+JSON.stringify({fork:process.argv.includes('--fork-session'),resume:arg('--resume'),model,effort:process.argv.includes('--effort')?arg('--effort'):null,tools:listed.tools.map(t=>t.name),prompt:fs.readFileSync(arg('--system-prompt-file'),'utf8').slice(0,40),request:request.slice(0,4000),caching:process.env.DISABLE_PROMPT_CACHING?'off':'on',...extra}));
  if(!request.includes('call-tool-first')){report({});return;}
  const args={input:'text("during compaction");'};start();
  send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_compacting',name:'mcp__chatgpt__exec',input:args}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  report({toolResult:await client.callTool({name:'exec',arguments:args})});return;
 }
 // A resumed stopped turn reports how it was started and what it was sent.
 if(request.includes('turn_stopped')){text('RESUMED '+JSON.stringify({resume:process.argv.includes('--resume')?arg('--resume'):null,request}));return;}
 if(request.includes('<history_message')) {
  const transcript=msg.message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  text('REPLAY '+JSON.stringify({input:transcript.length<5000?transcript:transcript.slice(0,500)+'\n'+transcript.slice(-1500),images:msg.message.content.filter(c=>c.type==='image').length,bytes:request.length,updatedPolicy:fs.readFileSync(arg('--system-prompt-file'),'utf8').includes('UPDATED-POLICY')}));return;
 }
 if(request.includes('question-card')) {
  // Four questions, one 700-character question, or a card the desktop can show.
  const q=title=>({title,options:['Yes','No']});
  const args={questions:request.includes('question-card-four')?['A?','B?','C?','D?'].map(q):request.includes('question-card-long')?[q('L'.repeat(700)+'?')]:[q('A?'),q('B?')]};start();
  send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_card',name:'mcp__chatgpt__request_user_input_async',input:args}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  text('CARD '+JSON.stringify(await client.callTool({name:'request_user_input_async',arguments:args})));return;
 }
 if(request.includes('sleep-tool')) {
  // A host sleep the desktop never answers, as after a Stop in the desktop.
  const args={duration_ms:50};start();
  send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_sleep',name:'mcp__chatgpt__clock_sleep',input:args}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  busy=true;await client.callTool({name:'clock_sleep',arguments:args}).catch(()=>{});busy=false;text('SLEPT');return;
 }
 if(request.includes('slow-response')){start();event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'waiting'}});return;}
 if(request.includes('invoke-tool')||request.includes('racing-tool')||request.includes('timeout-tool')||request.includes('stop-after-tool')){
  const args={input:'text("hello");\ntext(42);'};start();
  const early=request.includes('racing-tool')?client.callTool({name:'exec',arguments:args}):null;
  if(early)await new Promise(r=>setTimeout(r,150));
  send({type:'assistant',message:{model,content:[{type:'tool_use',id:'toolu_fixture',name:'mcp__chatgpt__exec',input:args}]}});
  event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
  let result;busy=true;
  try {result=await(early??client.callTool({name:'exec',arguments:args},undefined,request.includes('timeout-tool')?{timeout:150}:undefined));}
  catch(error){busy=false;text('NATIVE RETRY THAT MUST NOT BE LOST');return;}
  busy=false;
  if(request.includes('stop-after-tool')) {process.on('SIGINT',()=>setTimeout(()=>process.exit(130),250));start();event({type:'content_block_start',index:0,content_block:{type:'text',text:'waiting after tool'}});return;}
  if(JSON.stringify(queued).includes('think-only')) {
   // Opus answering the message only in thinking, then calling the next tool.
   queued.splice(0);const next={input:'text("next");'};start();
   event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
   event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Got it, switching to the other worker.'}});
   send({type:'assistant',message:{model,content:[{type:'thinking',thinking:'Got it, switching to the other worker.'},{type:'tool_use',id:'toolu_next',name:'mcp__chatgpt__exec',input:next}]}});
   event({type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}});event({type:'message_stop'});
   busy=true;await client.callTool({name:'exec',arguments:next});busy=false;text('DONE');return;
  }
  text('RESULT '+JSON.stringify(result)+(queued.length?' STEERED '+JSON.stringify(queued.splice(0)):''));
 }else text('FINAL '+request);
});
input.on('close',async()=>{await client.close();process.exit(0);});
process.on('SIGINT',()=>{if(process.listenerCount('SIGINT')===1)process.exit(130);});
