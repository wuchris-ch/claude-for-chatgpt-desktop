import test from 'node:test';
import assert from 'node:assert/strict';
import {boundToolImages, assertModelInputFits} from '../src/image-history.mjs';
import {checkpointText} from '../src/protocol.mjs';

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

const png=(mib,tag='')=>({type:'input_image',image_url:`data:image/png;base64,${tag}`+'A'.repeat(Math.round(mib*1024*1024))});
const placeholder=/Earlier attached image [0-9a-f]{12} omitted/;

test('attachments count toward the request window, and the oldest earlier images give way first',()=>{
 // October 8: 15.25 MiB of slide stills stayed under the 16 MiB tool-image
 // mark while 8.5 MiB of earlier pasted screenshots took the request past 24 MiB.
 const pasted={type:'message',role:'user',content:[{type:'input_text',text:'Screenshot at /tmp/a.png'},png(3.5),png(1.5)]};
 const later={type:'message',role:'user',content:[{type:'input_text',text:'Screenshot at /tmp/b.png'},png(3.5)]};
 const step=i=>[{type:'custom_tool_call',call_id:'s'+i,name:'exec',input:'render'},{type:'custom_tool_call_output',call_id:'s'+i,output:[{type:'input_text',text:'still '+i},png(1.25,'s'+i)]}];
 const input=[{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(2.5*1024*1024)}]},pasted,{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]},later,...Array.from({length:12},(_,i)=>step(i)).flat()];
 const body={input,tools:[]};
 assert.throws(()=>assertModelInputFits(body),error=>error.statusCode===413);
 const bounded=boundToolImages(input,0,0,Buffer.byteLength(JSON.stringify({...body,input:[]})));
 // The screenshot pasted in the current turn stays; older stills give way.
 assert.equal(bounded.userCutoff,2);assert.equal(bounded.cutoff,8);
 assert.equal(bounded.input[1].content[0].text,'Screenshot at /tmp/a.png');
 assert.match(bounded.input[1].content[1].text,placeholder);assert.match(bounded.input[1].content[2].text,placeholder);
 assert.equal(bounded.input[3],input[3]);
 assert.match(bounded.input[5].output[1].text,/Earlier tool image .* omitted/);assert.equal(bounded.input[5].output[0].text,'still 0');
 for(let i=8;i<12;i++)assert.equal(bounded.input[5+i*2].output[1],input[5+i*2].output[1]);
 assert.ok(Buffer.byteLength(JSON.stringify({...body,input:bounded.input}))<=12*1024*1024);
 const again=boundToolImages([...input,...step(12)],bounded.cutoff,bounded.userCutoff);
 assert.equal(again.cutoff,bounded.cutoff);assert.equal(again.userCutoff,bounded.userCutoff);
});

test('attachments for the current request and the newest tool image stay when earlier ones give way',()=>{
 const turn=i=>[{type:'message',role:'user',content:[{type:'input_text',text:'shot '+i},png(3.5,'u'+i)]},{type:'message',role:'assistant',content:[{type:'output_text',text:'seen '+i}]}];
 const current={type:'message',role:'user',content:[{type:'input_text',text:'latest'},png(3.5,'now'),png(3.5,'now2')]};
 const input=[...Array.from({length:6},(_,i)=>turn(i)).flat(),{type:'function_call',call_id:'t',name:'exec',arguments:'{}'},{type:'function_call_output',call_id:'t',output:[{type:'input_text',text:'one tool image'},png(0.5,'t')]},current];
 const bounded=boundToolImages(input);
 assert.equal(bounded.cutoff,0);assert.equal(bounded.userCutoff,5);
 for(let i=0;i<5;i++){assert.match(bounded.input[i*2].content[1].text,placeholder);assert.equal(bounded.input[i*2].content[0].text,'shot '+i);}
 assert.equal(bounded.input[10],input[10]);
 assert.equal(bounded.input.at(-1),current);assert.equal(bounded.input.at(-2).output[1],input.at(-2).output[1]);
 const earlier=boundToolImages(input.slice(0,-1).concat({...current,content:current.content.slice(0,2)}));
 assert.equal(earlier.userCutoff,4);assert.equal(earlier.input[8],input[8]);assert.equal(earlier.input[10],input[10]);
});

test('screenshots the user attached stay for the whole turn, while Claude takes its own',()=>{
 // Four attachments, then Claude's own screenshots fill the window mid-turn.
 const earlier={type:'message',role:'user',content:[{type:'input_text',text:'old screenshot'},png(2,'old')]};
 const answer={type:'message',role:'assistant',content:[{type:'output_text',text:'seen'}],phase:'final_answer'};
 const now={type:'message',role:'user',content:[{type:'input_text',text:'compare these with the live page'},png(3.5,'a'),png(3.5,'b'),png(3.5,'c'),png(3.5,'d')]};
 const commentary={type:'message',role:'assistant',content:[{type:'output_text',text:'Taking a screenshot.'}],phase:'commentary'};
 const shot=i=>[{type:'custom_tool_call',call_id:'c'+i,name:'exec',input:'screenshot'},{type:'custom_tool_call_output',call_id:'c'+i,output:[{type:'input_text',text:'page '+i},png(2,'t'+i)]}];
 const input=[earlier,answer,now,commentary,...shot(1),...shot(2),...shot(3)];
 const bounded=boundToolImages(input);
 assert.equal(bounded.input[2],now);
 assert.match(bounded.input[0].content[1].text,placeholder);
 assert.match(bounded.input[5].output[1].text,/Earlier tool image .* omitted/);
 assert.equal(bounded.input.at(-1).output[1],input.at(-1).output[1]);
 // After a Stop, the next turn's attachments are the current ones.
 const stopped=[earlier,answer,now,...shot(1),{type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted.</turn_aborted>'}]},{type:'message',role:'user',content:[{type:'input_text',text:'next'},png(3.5,'e'),png(3.5,'f'),png(3.5,'g')]}];
 const after=boundToolImages(stopped);
 assert.ok(after.userCutoff>=2);assert.equal(after.input.at(-1),stopped.at(-1));
});

test('after a compaction, the screenshots in the messages it kept give way, apart from the newest',()=>{
 // November 4: a compaction kept 48 of the user's messages with 31 MiB of
 // screenshots, and every request after it failed as too large.
 const kept=i=>({type:'message',role:'user',content:[{type:'input_text',text:'look at this '+i},png(3.5,'k'+i)]});
 const context=[{type:'message',role:'developer',content:[{type:'input_text',text:'<permissions instructions>'}]},{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context></environment_context>'}]}];
 const newest={type:'message',role:'user',content:[{type:'input_text',text:'and this one'},png(1.75,'newest')]};
 // The server reads the compaction item in as a message before the session sees it.
 const checkpoint={type:'message',id:'cmp_1',role:'user',content:[{type:'input_text',text:checkpointText('claude-bridge-v1:x','token')}]};
 const next={type:'message',role:'user',content:[{type:'input_text',text:'continue'}]};
 const input=[...Array.from({length:9},(_,i)=>kept(i)),...context,newest,checkpoint,next];
 const body={input,tools:[]};
 assert.throws(()=>assertModelInputFits(body),error=>error.statusCode===413);
 const bounded=boundToolImages(input);
 assertModelInputFits({...body,input:bounded.input});
 assert.ok(Buffer.byteLength(JSON.stringify(bounded.input))<=12*1024*1024);
 assert.match(bounded.input[0].content[1].text,placeholder);assert.equal(bounded.input[0].content[0].text,'look at this 0');
 assert.equal(bounded.input.at(-3),newest);assert.equal(bounded.input.at(-1),next);assert.equal(bounded.input.at(-2),checkpoint);
 // The oldest go first, and the window holds for the next request.
 assert.equal(bounded.input[8],input[8]);
 const again=boundToolImages([...input,{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]},{type:'message',role:'user',content:[{type:'input_text',text:'more'}]}],bounded.cutoff,bounded.userCutoff);
 assert.equal(again.userCutoff,bounded.userCutoff);
 // A compaction in the middle of a turn keeps its newest message, even when
 // the earlier ones alone would not bring the request into its window.
 const small=i=>({...kept(i),content:[kept(i).content[0],png(1,'s'+i)]});
 const midTurn=boundToolImages([...Array.from({length:9},(_,i)=>small(i)),...context,{...newest,content:[newest.content[0],png(14,'big')]},checkpoint]);
 assert.equal(midTurn.userCutoff,9);
 assert.equal(midTurn.input.at(-2).content[1].image_url.slice(0,25),'data:image/png;base64,big');
});
