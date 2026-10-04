import {digest, isResult} from './protocol.mjs';

// Keep a stable window until a high-water mark is reached. Pruning in batches
// avoids rebuilding the native session after every subsequent screenshot.
const HIGH_BYTES=16*1024*1024, LOW_BYTES=8*1024*1024;
const HIGH_COUNT=200, LOW_COUNT=100;
const isImage=c=>c.type==='input_image'||c.type==='image';
const imageBytes=c=>Buffer.byteLength(c.image_url??c.data??'');

export function boundToolImages(input, cutoff=0) {
  const images=input.filter(isResult).flatMap(x=>Array.isArray(x.output)?x.output.filter(isImage):[]);
  cutoff=Math.min(cutoff,images.length);
  let bytes=images.slice(cutoff).reduce((sum,c)=>sum+imageBytes(c),0);
  if(bytes>HIGH_BYTES||images.length-cutoff>HIGH_COUNT) {
    while(cutoff<images.length-1&&(bytes>LOW_BYTES||images.length-cutoff>LOW_COUNT))bytes-=imageBytes(images[cutoff++]);
  }
  let index=0;
  const bounded=input.map(item=>!isResult(item)||!Array.isArray(item.output)?item:{...item,output:item.output.map(c=>{
    if(!isImage(c)||index++>=cutoff)return c;
    return {type:'input_text',text:`[Earlier tool image ${digest(c).slice(0,12)} omitted from model context to bound screenshot history. Its accompanying text is retained; the original image remains in the desktop transcript. Request a fresh image if needed.]`};
  })});
  return {input:bounded,cutoff};
}

export function assertModelInputFits(body) {
  // Leave room below the native request limit for MCP schemas and framing.
  if(Buffer.byteLength(JSON.stringify(body))>24*1024*1024) {
    throw Object.assign(new Error('The model input still exceeds 24 MiB after bounding older tool screenshots. Reduce the current attachment or text batch, or compact the conversation.'),{statusCode:413});
  }
}
