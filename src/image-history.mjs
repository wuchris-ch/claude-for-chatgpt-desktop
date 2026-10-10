import {digest, isResult} from './protocol.mjs';

// Keep a stable window until a high-water mark is reached. Pruning in batches
// avoids rebuilding the native session after every subsequent screenshot.
const HIGH_BYTES=16*1024*1024, LOW_BYTES=8*1024*1024;
const HIGH_COUNT=200, LOW_COUNT=100;
// The whole request has its own window below the 24 MiB limit. Pasted
// screenshots are several MiB each and are not part of the tool window.
const HIGH_TOTAL=20*1024*1024, LOW_TOTAL=12*1024*1024;
const isImage=c=>c.type==='input_image'||c.type==='image';
const imageBytes=c=>Buffer.byteLength(c.image_url??c.data??'');
const isUserMessage=item=>item.type==='message'&&item.role==='user'&&Array.isArray(item.content);
const isModelOutput=item=>(item.type==='message'&&item.role==='assistant')||['function_call','custom_tool_call','reasoning'].includes(item.type);

export function boundToolImages(input, cutoff=0, userCutoff=0, overhead=0) {
  // Attachments since the model last answered are the current request and
  // always stay, as does the newest tool image.
  const current=input.findLastIndex(isModelOutput);
  const images=[], userImages=[];
  input.forEach((item,position)=> {
    if(isResult(item)&&Array.isArray(item.output))for(const c of item.output.filter(isImage))images.push({position,bytes:imageBytes(c)});
    if(isUserMessage(item)&&position<=current)for(const c of item.content.filter(isImage))userImages.push({position,bytes:imageBytes(c)});
  });
  const sum=list=>list.reduce((total,x)=>total+x.bytes,0);
  cutoff=Math.min(cutoff,images.length);userCutoff=Math.min(userCutoff,userImages.length);
  let bytes=sum(images.slice(cutoff));
  if(bytes>HIGH_BYTES||images.length-cutoff>HIGH_COUNT) {
    while(cutoff<images.length-1&&(bytes>LOW_BYTES||images.length-cutoff>LOW_COUNT))bytes-=images[cutoff++].bytes;
  }
  let total=overhead+Buffer.byteLength(JSON.stringify(input))-sum(images.slice(0,cutoff))-sum(userImages.slice(0,userCutoff));
  if(total>HIGH_TOTAL) {
    // Past the request window, the oldest earlier image goes first, whether
    // a tool returned it or the user attached it.
    while(total>LOW_TOTAL) {
      const tool=cutoff<images.length-1?images[cutoff]:null, user=userCutoff<userImages.length?userImages[userCutoff]:null;
      if(user&&(!tool||user.position<tool.position))total-=userImages[userCutoff++].bytes;
      else if(tool)total-=images[cutoff++].bytes;
      else break;
    }
  }
  let index=0, userIndex=0;
  const bounded=input.map((item,position)=> {
    if(isResult(item)&&Array.isArray(item.output))return {...item,output:item.output.map(c=> {
      if(!isImage(c)||index++>=cutoff)return c;
      return {type:'input_text',text:`[Earlier tool image ${digest(c).slice(0,12)} omitted from model context to bound screenshot history. Its accompanying text is retained; the original image remains in the desktop transcript. Request a fresh image if needed.]`};
    })};
    if(isUserMessage(item)&&position<=current&&userIndex<userCutoff)return {...item,content:item.content.map(c=> {
      if(!isImage(c)||userIndex++>=userCutoff)return c;
      return {type:'input_text',text:`[Earlier attached image ${digest(c).slice(0,12)} omitted from model context to keep the request under the size limit. Its surrounding text is retained; the original remains in the desktop transcript.]`};
    })};
    return item;
  });
  return {input:bounded,cutoff,userCutoff};
}

export function assertModelInputFits(body) {
  // Leave room below the native request limit for MCP schemas and framing.
  if(Buffer.byteLength(JSON.stringify(body))>24*1024*1024) {
    throw Object.assign(new Error('The model input still exceeds 24 MiB after bounding earlier images. Reduce the current attachment or text batch, or compact the conversation.'),{statusCode:413});
  }
}
