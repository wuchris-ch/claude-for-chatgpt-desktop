import test from 'node:test';
import assert from 'node:assert/strict';
import {boundToolImages, assertModelInputFits} from '../src/image-history.mjs';
import {checkpointText} from '../src/protocol.mjs';

const MiB=1024*1024;
function png(mib,tag='') {return {type:'input_image',image_url:`data:image/png;base64,${tag}`+'A'.repeat(Math.round(mib*MiB))};}
const placeholder=/Earlier attached image [0-9a-f]{12} omitted/;
const toolPlaceholder=/Earlier tool image [0-9a-f]{12} omitted/;

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

test('a current request too large on its own fails explicitly, and a large attachment counts at the size Claude Code sends',()=>{
 const text={input:[{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(25*1024*1024)}]}]};
 assert.equal(boundToolImages(text.input).input[0],text.input[0]);
 assert.throws(()=>assertModelInputFits(text),error=>error.statusCode===413);
 const many={input:[{type:'message',role:'user',content:Array.from({length:42},()=>png(0.6))}]};
 assert.equal(boundToolImages(many.input).userCutoff,0);
 assert.throws(()=>assertModelInputFits(many),error=>error.statusCode===413);
 // Claude Code sends one large attachment at its 500 KB budget.
 const one={input:[{type:'message',role:'user',content:[{type:'input_image',image_url:'A'.repeat(25*1024*1024)}]}]};
 assert.equal(boundToolImages(one.input).input[0],one.input[0]);
 assertModelInputFits(one);
});


test('attachments count toward the request window, and the oldest earlier images give way first',()=>{
 // October 8: slide stills stayed under the 16 MiB tool-image mark while
 // earlier pasted screenshots took the request past 24 MiB.
 const pasted={type:'message',role:'user',content:[{type:'input_text',text:'Screenshot at /tmp/a.png'},png(0.6,'p1'),png(0.6,'p2'),png(0.6,'p3'),png(0.6,'p4')]};
 const later={type:'message',role:'user',content:[{type:'input_text',text:'Screenshot at /tmp/b.png'},png(0.6,'l1'),png(0.6,'l2')]};
 const step=i=>[{type:'custom_tool_call',call_id:'s'+i,name:'exec',input:'render'},{type:'custom_tool_call_output',call_id:'s'+i,output:[{type:'input_text',text:'still '+i},png(0.6,'s'+i)]}];
 const input=[{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(5.5*MiB)}]},pasted,{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]},later,...Array.from({length:25},(_,i)=>step(i)).flat()];
 const body={input,tools:[]};
 assert.throws(()=>assertModelInputFits(body),error=>error.statusCode===413);
 const bounded=boundToolImages(input,0,0,Buffer.byteLength(JSON.stringify({...body,input:[]})));
 // 24.1 MiB: the 4 pasted screenshots go first, then the 17 oldest stills.
 assert.equal(bounded.userCutoff,4);assert.equal(bounded.cutoff,17);
 assert.equal(bounded.input[1].content[0].text,'Screenshot at /tmp/a.png');
 for(let i=1;i<=4;i++)assert.match(bounded.input[1].content[i].text,placeholder);
 assert.equal(bounded.input[3],input[3]);
 assert.match(bounded.input[5].output[1].text,toolPlaceholder);assert.equal(bounded.input[5].output[0].text,'still 0');
 for(let i=17;i<25;i++)assert.equal(bounded.input[5+i*2].output[1],input[5+i*2].output[1]);
 assert.ok(Buffer.byteLength(JSON.stringify({...body,input:bounded.input}))<=12*MiB);
 const again=boundToolImages([...input,...step(25)],bounded.cutoff,bounded.userCutoff);
 assert.equal(again.cutoff,bounded.cutoff);assert.equal(again.userCutoff,bounded.userCutoff);
});

test('attachments for the current request and the newest tool image stay when earlier ones give way',()=>{
 const turn=i=>[{type:'message',role:'user',content:[{type:'input_text',text:'shot '+i},png(0.5,'u'+i)]},{type:'message',role:'assistant',content:[{type:'output_text',text:'seen '+i}]}];
 const current={type:'message',role:'user',content:[{type:'input_text',text:'latest'},png(0.5,'now'),png(0.5,'now2')]};
 const input=[...Array.from({length:40},(_,i)=>turn(i)).flat(),{type:'function_call',call_id:'t',name:'exec',arguments:'{}'},{type:'function_call_output',call_id:'t',output:[{type:'input_text',text:'one tool image'},png(0.3,'t')]},current];
 // 21.3 MiB: the 19 oldest attachments bring it to 11.8.
 const bounded=boundToolImages(input);
 assert.equal(bounded.cutoff,0);assert.equal(bounded.userCutoff,19);
 for(let i=0;i<19;i++){assert.match(bounded.input[i*2].content[1].text,placeholder);assert.equal(bounded.input[i*2].content[0].text,'shot '+i);}
 assert.equal(bounded.input[38],input[38]);
 assert.equal(bounded.input.at(-1),current);assert.equal(bounded.input.at(-2).output[1],input.at(-2).output[1]);
 const earlier=boundToolImages(input.slice(0,-1).concat({...current,content:current.content.slice(0,2)}));
 assert.equal(earlier.userCutoff,18);assert.equal(earlier.input[36],input[36]);assert.equal(earlier.input[38],input[38]);
});

test('screenshots the user attached stay for the whole turn, while Claude takes its own',()=>{
 // Twelve attachments, then Claude's own screenshots fill the window mid-turn.
 const earlier={type:'message',role:'user',content:[{type:'input_text',text:'old screenshot'},png(0.5,'old')]};
 const answer={type:'message',role:'assistant',content:[{type:'output_text',text:'seen'}],phase:'final_answer'};
 const now={type:'message',role:'user',content:[{type:'input_text',text:'compare these with the live page'},...Array.from({length:12},(_,i)=>png(0.5,'n'+i))]};
 const commentary={type:'message',role:'assistant',content:[{type:'output_text',text:'Taking a screenshot.'}],phase:'commentary'};
 const shot=i=>[{type:'custom_tool_call',call_id:'c'+i,name:'exec',input:'screenshot'},{type:'custom_tool_call_output',call_id:'c'+i,output:[{type:'input_text',text:'page '+i},png(0.45,'t'+i)]}];
 const shots=n=>Array.from({length:n},(_,i)=>shot(i)).flat();
 const input=[earlier,answer,now,commentary,...shots(33)];
 const bounded=boundToolImages(input);
 assert.equal(bounded.input[2],now);
 assert.match(bounded.input[0].content[1].text,placeholder);
 assert.match(bounded.input[5].output[1].text,toolPlaceholder);
 assert.equal(bounded.input.at(-1).output[1],input.at(-1).output[1]);
 // After a Stop, the next turn's attachments are the current ones.
 const stopped=[earlier,answer,now,...shots(33),{type:'message',role:'developer',content:[{type:'input_text',text:'<turn_aborted>The user interrupted.</turn_aborted>'}]},{type:'message',role:'user',content:[{type:'input_text',text:'next'},...Array.from({length:12},(_,i)=>png(0.5,'x'+i))]}];
 const after=boundToolImages(stopped);
 assert.ok(after.userCutoff>=2);assert.equal(after.input.at(-1),stopped.at(-1));
});

test('after a compaction, the screenshots in the messages it kept give way, apart from the newest',()=>{
 // November 4: a compaction kept 44 of the user's messages with 31 MiB of
 // screenshots, and every request after it failed as too large.
 const kept=i=>({type:'message',role:'user',content:[{type:'input_text',text:'look at this '+i},png(0.6,'k'+i)]});
 const context=[{type:'message',role:'developer',content:[{type:'input_text',text:'<permissions instructions>'}]},{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context></environment_context>'}]}];
 const newest={type:'message',role:'user',content:[{type:'input_text',text:'and this one'},png(0.6,'newest')]};
 // The server reads the compaction item in as a message before the session sees it.
 const checkpoint={type:'message',id:'cmp_1',role:'user',content:[{type:'input_text',text:checkpointText('claude-bridge-v1:x','token')}]};
 const next={type:'message',role:'user',content:[{type:'input_text',text:'continue'}]};
 const input=[...Array.from({length:43},(_,i)=>kept(i)),...context,newest,checkpoint,next];
 const body={input,tools:[]};
 assert.throws(()=>assertModelInputFits(body),error=>error.statusCode===413);
 const bounded=boundToolImages(input);
 assertModelInputFits({...body,input:bounded.input});
 assert.ok(Buffer.byteLength(JSON.stringify(bounded.input))<=12*MiB);
 assert.match(bounded.input[0].content[1].text,placeholder);assert.equal(bounded.input[0].content[0].text,'look at this 0');
 assert.equal(bounded.input.at(-3),newest);assert.equal(bounded.input.at(-1),next);assert.equal(bounded.input.at(-2),checkpoint);
 // The oldest go first, and the window holds for the next request.
 assert.equal(bounded.input[42],input[42]);
 const again=boundToolImages([...input,{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]},{type:'message',role:'user',content:[{type:'input_text',text:'more'}]}],bounded.cutoff,bounded.userCutoff);
 assert.equal(again.userCutoff,bounded.userCutoff);
 // A compaction in the middle of a turn keeps its newest message, even when
 // the earlier ones alone would not bring the request into its window.
 const midTurn=boundToolImages([...Array.from({length:9},(_,i)=>kept(i)),...context,{...newest,content:[newest.content[0],...Array.from({length:25},(_,i)=>png(0.6,'big'+i))]},checkpoint]);
 assert.equal(midTurn.userCutoff,9);
 assert.equal(midTurn.input.at(-2).content.length,26);assert.ok(midTurn.input.at(-2).content.slice(1).every(c=>c.type==='input_image'));
});

test('images count at the size Claude Code sends them, so large renders do not fill the window at once',()=>{
 // November 4: renders of 3 MiB each, three to a call, moved the window on
 // almost every call, and each move rebuilt the session. Claude Code sends
 // each at its 500 KB budget.
 const call=i=>[{type:'custom_tool_call',call_id:'r'+i,name:'exec',input:'render'},{type:'custom_tool_call_output',call_id:'r'+i,output:[{type:'input_text',text:'frames '+i},png(3,'a'+i),png(3,'b'+i),png(3,'c'+i)]}];
 const calls=n=>[{type:'message',role:'user',content:[{type:'input_text',text:'render the site plan'}]},...Array.from({length:n},(_,i)=>call(i)).flat()];
 // 18 renders: 54 MiB from the desktop, 11.7 MiB from Claude Code.
 const six=boundToolImages(calls(6));
 assert.equal(six.cutoff,0);assertModelInputFits({input:six.input});
 // 27 renders pass the 16 MiB tool mark, and the newest 12 stay.
 const nine=boundToolImages(calls(9));
 assert.equal(nine.cutoff,15);assertModelInputFits({input:nine.input});
 assert.equal(boundToolImages(calls(10),nine.cutoff).cutoff,nine.cutoff);
});
