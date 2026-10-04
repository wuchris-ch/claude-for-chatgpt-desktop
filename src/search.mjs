import {zstdDecompressSync,gunzipSync,inflateSync} from 'node:zlib';

export const SEARCH_URL='https://chatgpt.com/backend-api/codex/alpha/search';
const LIMIT=32*1024*1024;
const COMMANDS=new Set(['search_query','image_query','open','find','click','screenshot','finance','weather','sports','time']);
const error=(status,message)=>({status,data:{error:{message}}});

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
      commands=[...new Set(Object.keys(body.commands).filter(x=>x!=='response_length').map(x=>COMMANDS.has(x)?x:'unknown'))].sort();
      const headers={'Authorization':authorization,'Content-Type':'application/json','Accept':'application/json','originator':'codex_cli_rs'};
      if(typeof req.headers['chatgpt-account-id']==='string')headers['ChatGPT-Account-Id']=req.headers['chatgpt-account-id'];
      const response=await fetch(upstream,{method:'POST',headers,body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeoutMs)])});
      if(response.status===401){await response.body?.cancel();return send(error(401,'ChatGPT web search login expired. Sign into the Claude window, then retry.'));}
      if(response.status>=300&&response.status<400||[404,405,410].includes(response.status)) {
        await response.body?.cancel();return send(error(502,`OpenAI standalone search endpoint is incompatible (HTTP ${response.status}). The endpoint may have changed; update the bridge.`));
      }
      if(!response.ok){await response.body?.cancel();return send(error(response.status,`OpenAI standalone search failed (HTTP ${response.status}).`));}
      if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel();return send(error(502,'OpenAI standalone search returned a non-JSON response. The endpoint may have changed; update the bridge.'));
      }
      let data;
      try {data=await response.json();} catch {return send(error(502,'OpenAI standalone search returned invalid JSON. The endpoint may have changed; update the bridge.'));}
      if(!data||typeof data!=='object'||Array.isArray(data)||data.error)return send(error(502,'OpenAI standalone search returned an incompatible response. The endpoint may have changed; update the bridge.'));
      send({status:response.status,data});
    } catch {
      // Fetch/parse exceptions can contain URLs, response bodies or credentials.
      // Never include them in the client error or the service log.
      send(error(502,'OpenAI standalone search could not complete. Check the network connection and retry.'));
    } finally {
      res.removeListener('close',disconnect);
      log('search_request',{status,commands});
    }
  };
}
