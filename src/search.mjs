import {zstdDecompressSync,gunzipSync,inflateSync} from 'node:zlib';

export const SEARCH_URL='https://chatgpt.com/backend-api/codex/alpha/search';
const LIMIT=32*1024*1024;
const COMMANDS=new Set(['search_query','image_query','open','find','click','screenshot','finance','weather','sports','time']);
const error=(status,message)=>({status,data:{error:{message}}});

const commandTypes=commands=>[...new Set(Object.keys(commands).filter(x=>x!=='response_length').map(x=>COMMANDS.has(x)?x:'unknown'))].sort();

// One request to OpenAI's search endpoint with the app's own ChatGPT sign-in:
// only these headers, to the one fixed URL, with redirects refused.
async function postSearch({authorization,accountId,body,upstream=SEARCH_URL,timeoutMs=60000,signal,relogin}) {
  try {
    const headers={'Authorization':authorization,'Content-Type':'application/json','Accept':'application/json','originator':'codex_cli_rs'};
    if(typeof accountId==='string')headers['ChatGPT-Account-Id']=accountId;
    const response=await fetch(upstream,{method:'POST',headers,body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(timeoutMs)])});
    if(response.status===401){await response.body?.cancel();return error(401,'ChatGPT web search login expired. '+relogin);}
    if(response.status>=300&&response.status<400||[404,405,410].includes(response.status)) {
      await response.body?.cancel();return error(502,`OpenAI standalone search endpoint is incompatible (HTTP ${response.status}). The endpoint may have changed; update the bridge.`);
    }
    if(!response.ok){await response.body?.cancel();return error(response.status,`OpenAI standalone search failed (HTTP ${response.status}).`);}
    if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel();return error(502,'OpenAI standalone search returned a non-JSON response. The endpoint may have changed; update the bridge.');
    }
    let data;
    try {data=await response.json();} catch {return error(502,'OpenAI standalone search returned invalid JSON. The endpoint may have changed; update the bridge.');}
    if(!data||typeof data!=='object'||Array.isArray(data)||data.error)return error(502,'OpenAI standalone search returned an incompatible response. The endpoint may have changed; update the bridge.');
    return {status:response.status,data};
  } catch {
    // Fetch/parse exceptions can contain URLs, response bodies or credentials.
    // Never include them in the client error or the service log.
    return error(502,'OpenAI standalone search could not complete. Check the network connection and retry.');
  }
}

// This module never reads credentials from disk. Only the isolated desktop's
// request credentials are forwarded, and only to the fixed search endpoint.
export function createSearchHandler({token,log,headerNames,upstream=SEARCH_URL,timeoutMs=60000}) {
  return async(req,res)=>{
    let commands=[],status=502;
    const send=result=>{
      status=result.status;
      if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result.data));}
    };
    const abort=new AbortController();
    const disconnect=()=>{if(!res.writableEnded)abort.abort();};res.on('close',disconnect);
    try {
      headerNames(Object.keys(req.headers).sort());
      const authorization=req.headers.authorization;
      if(!req.headers['x-claude-bridge-key']||typeof authorization!=='string'||!/^Bearer \S+$/.test(authorization)||authorization===`Bearer ${token}`) {
        return send(error(401,'Web search requires the isolated ChatGPT login. Sign into the Claude window, then retry.'));
      }
      let body;
      try {
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>LIMIT)return send(error(413,'Search request exceeds 32 MiB.'));chunks.push(chunk);}
        let bytes=Buffer.concat(chunks);
        const encoding=req.headers['content-encoding'];
        if(encoding==='zstd')bytes=zstdDecompressSync(bytes,{maxOutputLength:LIMIT});
        else if(encoding==='gzip')bytes=gunzipSync(bytes,{maxOutputLength:LIMIT});
        else if(encoding==='deflate')bytes=inflateSync(bytes,{maxOutputLength:LIMIT});
        else if(encoding&&encoding!=='identity')return send(error(415,'Unsupported search request encoding.'));
        body=JSON.parse(bytes.toString());
      } catch {return send(error(400,'Invalid search request JSON or compressed payload.'));}
      if(!body||typeof body!=='object'||Array.isArray(body)||!body.commands||typeof body.commands!=='object'||Array.isArray(body.commands))return send(error(400,'Search request requires a commands object.'));
      commands=commandTypes(body.commands);
      send(await postSearch({authorization,accountId:req.headers['chatgpt-account-id'],body,upstream,timeoutMs,signal:abort.signal,relogin:'Sign into the Claude window, then retry.'}));
    } catch {
      // Such as the header names file failing to save. The error can name
      // local paths, so the app gets the generic message.
      send(error(502,'OpenAI standalone search could not complete. Check the network connection and retry.'));
    } finally {
      res.removeListener('close',disconnect);
      log('search_request',{status,commands});
    }
  };
}

// Picker mode: the app offers Claude's request GPT's hosted web search and
// signs the request in with the user's ChatGPT account. The bridge runs
// Claude's searches itself with that sign-in, kept in memory only. Returns
// null when the app offers no web search, which follows the user's own
// web search setting, or the request carries no ChatGPT sign-in.
export function pickerSearch(hosted,headers,token) {
  const tool=hosted.find(t=>['web_search','web_search_preview'].includes(t?.type));
  const authorization=headers?.authorization;
  if(!tool||typeof authorization!=='string'||!/^Bearer \S+$/.test(authorization)||authorization===`Bearer ${token}`)return null;
  const accountId=typeof headers['chatgpt-account-id']==='string'?headers['chatgpt-account-id']:undefined;
  // The app's web search settings, as its own web.run sends them: live,
  // indexed or cached (the default) access, and any location, context size
  // or domain filter set in its config.
  const settings={allowed_callers:['direct'],external_web_access:tool.indexed_web_access?'indexed':tool.external_web_access===true};
  for(const key of ['user_location','search_context_size'])if(tool[key]!=null)settings[key]=tool[key];
  if(tool.filters?.allowed_domains)settings.filters={allowed_domains:tool.filters.allowed_domains};
  return {authorization,accountId,settings};
}

// The tool Claude gets in picker mode. Its arguments are the search
// endpoint's commands object, as in the app's own web.run tool.
const queryList={type:'array',items:{type:'object',properties:{
  q:{type:'string',description:'The search query.'},
  recency:{type:'integer',description:'Only results from the last N days.'},
  domains:{type:'array',items:{type:'string'},description:'Only results from these domains.'}},required:['q']}};
const list=(properties,required,description)=>({type:'array',description,items:{type:'object',properties,required}});
const ref={type:'string',description:'A reference id from an earlier web_run result, such as turn0search0, or a URL.'};
export const WEB_RUN_TOOL={name:'web_run',originalName:'web.run',hostName:'web.run',type:'function',local:'search',
  description:`Searches and reads the web. Each argument is a list of operations, and one call can mix several, which is faster than separate calls.

- search_query: {"search_query": [{"q": "latest Node.js LTS release"}]}. Up to 4 queries per call; more than 3 needs response_length "medium" or "long". Optional recency (days) and domains.
- image_query: {"image_query": [{"q": "waterfalls"}]}
- open: {"open": [{"ref_id": "turn0search0"}, {"ref_id": "https://example.com", "lineno": 120}]}. Opens a result or a URL.
- click: {"click": [{"ref_id": "turn0fetch3", "id": 17}]}. Follows a numbered link on an opened page.
- find: {"find": [{"ref_id": "turn0fetch3", "pattern": "release date"}]}. Finds text on an opened page.
- screenshot: {"screenshot": [{"ref_id": "turn1view0", "pageno": 0}]}. A page of a PDF.
- finance: {"finance": [{"ticker": "AMD", "type": "equity", "market": "USA"}]}; type is equity, fund, crypto or index.
- weather: {"weather": [{"location": "San Francisco, CA"}]}
- sports: {"sports": [{"fn": "standings", "league": "nfl"}]}; fn is schedule or standings.
- time: {"time": [{"utc_offset": "+03:00"}]}
- response_length: "short" (the default, so leave it out), "medium" or "long", for the number of results.

Search when the answer could have changed since your training (news, prices, versions, schedules, people in roles, laws), when the user wants sources or quotes, when a page or document is named that you have not read, when you are unsure, and when the user asks you to look something up.

Results carry reference ids such as turn2search5. Use them only in later web_run calls and never show them to the user. Cite sources in the answer as Markdown links to the page that supports each claim, placed next to the claim, not collected at the end. Each source may be labeled [wordlim N], the most words of the answer that may draw on it (200 if unlabeled). Quote at most 25 words verbatim from any one source.`,
  inputSchema:{type:'object',properties:{
    search_query:{...queryList,description:'Web searches, at most 4 per call.'},
    image_query:{...queryList,description:'Image searches.'},
    open:list({ref_id:ref,lineno:{type:'integer',description:'Line to position the page at.'}},['ref_id'],'Pages to open.'),
    click:list({ref_id:ref,id:{type:'integer',description:'The link number on that page.'}},['ref_id','id'],'Links to follow.'),
    find:list({ref_id:ref,pattern:{type:'string',description:'Text to find.'}},['ref_id','pattern'],'Text to find on opened pages.'),
    screenshot:list({ref_id:ref,pageno:{type:'integer',description:'Zero-based page number.'}},['ref_id','pageno'],'PDF pages to view.'),
    finance:list({ticker:{type:'string'},type:{type:'string',enum:['equity','fund','crypto','index']},market:{type:'string',description:'Market, such as USA. Empty for crypto.'}},['ticker','type'],'Price lookups.'),
    weather:list({location:{type:'string'},start:{type:'string',description:'Start date, YYYY-MM-DD.'},duration:{type:'integer',description:'Number of days.'}},['location'],'Weather forecasts.'),
    sports:list({fn:{type:'string',enum:['schedule','standings']},league:{type:'string',enum:['nba','wnba','nfl','nhl','mlb','epl','ncaamb','ncaawb','ipl']},team:{type:'string'},opponent:{type:'string'},date_from:{type:'string'},date_to:{type:'string'},num_games:{type:'integer'},locale:{type:'string'}},['fn','league'],'Sports schedules and standings.'),
    time:list({utc_offset:{type:'string',description:'Such as +03:00.'}},['utc_offset'],'Current time at UTC offsets.'),
    response_length:{type:'string',enum:['short','medium','long']}}}};

// How the desktop shows a search, as for the app's own web.run: the queries,
// else the page opened or searched.
const isUrl=value=>{try{new URL(value);return /^https?:$/.test(new URL(value).protocol);}catch{return false;}};
export function searchAction(commands) {
  const queries=list=>Array.isArray(list)&&list.length?list.length===1?{type:'search',query:String(list[0]?.q??'')}:{type:'search',queries:list.map(x=>String(x?.q??''))}:null;
  const open=commands?.open?.[0],find=commands?.find?.[0];
  return queries(commands?.search_query)??queries(commands?.image_query)
    ??(open&&isUrl(open.ref_id)?{type:'open_page',url:open.ref_id}:null)
    ??(find?{type:'find_in_page',...(isUrl(find.ref_id)?{url:find.ref_id}:{}),pattern:String(find.pattern??'')}:null)
    ??{type:'other'};
}

// The search service reads a short tail of the conversation, as the app
// sends it: the previous and current user messages and up to about 1,000
// tokens of assistant text between them, nothing after the current one.
// Images and the notes the app adds as user messages are left out; a
// message with any such note is not the user's (the app's own list, in
// Codex's contextual_user_message.rs). An agent message counts as
// assistant text when it is plain text.
const CONTEXT_CHARS=4000;
const NOTES=['<environment_context','# AGENTS.md instructions','<turn_aborted>','<subagent_notification>','<user_shell_command>',
  '<agent_message_board_notification>','<recommended_plugins>','<codex_internal_context','<goal_context>','<skill>','<hook_prompt',
  'Warning: apply_patch was requested via ','Warning: The maximum number of unified exec processes','Warning: Your account was flagged'];
const isNote=text=>NOTES.some(marker=>text.trimStart().startsWith(marker));
const assistant=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
export function searchContext(input=[]) {
  const messages=[];
  for(const x of input) {
    if(x?.type==='agent_message'&&Array.isArray(x.content)) {
      if(x.content.some(c=>c.type!=='input_text'))continue;
      const text=x.content.map(c=>c.text??'').join('\n');
      if(text.trim())messages.push(assistant(`Agent message from ${x.author}:\n${text}`));
      continue;
    }
    if(x?.type!=='message'||!Array.isArray(x.content))continue;
    if(x.role==='user') {
      const texts=x.content.filter(c=>c.type==='input_text'&&typeof c.text==='string');
      if(texts.some(c=>isNote(c.text)))continue;
      if(texts.length)messages.push({type:'message',role:'user',content:texts.map(c=>({type:'input_text',text:c.text}))});
    } else if(x.role==='assistant') {
      const text=x.content.filter(c=>c.type==='output_text').map(c=>c.text).join('\n');
      if(text)messages.push(assistant(text));
    }
  }
  const users=messages.flatMap((m,i)=>m.role==='user'?[i]:[]);
  if(!users.length)return [];
  const tail=messages.slice(users.at(-2)??users[0],users.at(-1)+1);
  let budget=CONTEXT_CHARS;
  for(const m of tail)if(m.role==='assistant') {
    const text=m.content[0].text;
    if(text.length>budget){const half=Math.floor(budget/2);m.content[0].text=budget<=0?'':text.slice(0,half)+'\n…\n'+text.slice(text.length-half);}
    budget-=Math.min(text.length,budget);
  }
  return tail.filter(m=>m.content[0].text!=='');
}

// Like the app's web.run, which parses the arguments into its command types
// and writes them out again, unknown commands and null values are left out.
const withoutNulls=value=>Array.isArray(value)?value.filter(x=>x!=null).map(withoutNulls)
  :value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!=null).map(([k,v])=>[k,withoutNulls(v)])):value;
export async function runSearch({auth,commands,upstream,timeoutMs,signal}) {
  const given=commands&&typeof commands==='object'&&!Array.isArray(commands)?commands:{};
  const args=withoutNulls(Object.fromEntries(Object.entries(given).filter(([k])=>COMMANDS.has(k)||k==='response_length')));
  const types=commandTypes(args);
  if(!auth)return {ok:false,status:0,commands:types,content:[{type:'text',text:'Web search is not available: the app did not sign this request in to ChatGPT.'}]};
  const body={id:auth.thread,model:auth.model,...(auth.context?.length?{input:auth.context}:{}),commands:args,
    settings:auth.settings,max_output_tokens:10000};
  const result=await postSearch({authorization:auth.authorization,accountId:auth.accountId,body,upstream,timeoutMs,signal,relogin:'Sign in to ChatGPT again in the app, then retry.'});
  const fail=message=>({ok:false,status:result.status,commands:types,content:[{type:'text',text:'Web search failed: '+message}]});
  if(result.data.error)return fail(result.data.error.message);
  if(typeof result.data.output!=='string')return {...fail('OpenAI standalone search returned an incompatible response. The endpoint may have changed; update the bridge.'),status:502};
  return {ok:true,status:result.status,commands:types,content:[{type:'text',text:result.data.output}]};
}
