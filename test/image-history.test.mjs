import test from 'node:test';
import assert from 'node:assert/strict';
import {boundToolImages, assertModelInputFits} from '../src/image-history.mjs';

test('image window advances in batches and preserves user images and all tool text',()=>{
 const image={type:'input_image',image_url:'data:image/png;base64,'+'A'.repeat(1024)};
 const user={type:'message',role:'user',content:[image]};
 const result=i=>({type:'function_call_output',call_id:'c'+i,output:[{type:'input_text',text:'observation '+i},image]});
 const input=[user,...Array.from({length:210},(_,i)=>result(i))];
 const first=boundToolImages(input);
 assert.equal(first.cutoff,110);assert.equal(first.input[0],user);
 assert.equal(first.input[1].output[0].text,'observation 0');
 assert.match(first.input[1].output[1].text,/omitted from model context/);
 assert.equal(first.input.at(-1).output[1],image);
 const continued=boundToolImages([...input,result(210)],first.cutoff);
 assert.equal(continued.cutoff,first.cutoff);
 assert.deepEqual(continued.input.slice(0,-1),first.input);
});

test('current oversized attachments fail explicitly instead of being removed',()=>{
 const body={input:[{type:'message',role:'user',content:[{type:'input_image',image_url:'A'.repeat(25*1024*1024)}]}]};
 const bounded=boundToolImages(body.input);
 assert.equal(bounded.cutoff,0);assert.equal(bounded.input[0],body.input[0]);
 assert.throws(()=>assertModelInputFits(body),error=>error.statusCode===413);
});
