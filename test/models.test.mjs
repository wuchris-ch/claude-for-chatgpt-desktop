import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadModels, parseModels, familyOf, startedModelMatches, effortFor, versionOf, labelFor, labeled} from '../src/models.mjs';

const entry=extra=>({slug:'m',claude_model:'opus',display_name:'Claude Opus',efforts:['low','medium','high'],context_window:1000000,...extra});

test('the shipped catalog offers Fable, Opus, Sonnet and Haiku through Claude Code aliases',()=>{
 const models=loadModels();
 assert.equal(models.default,'claude-opus');
 assert.deepEqual(models.list.map(m=>[m.slug,m.claude_model,m.display_name,m.default_effort,m.context_window]),[
  ['claude-fable','fable','Claude Fable 5.1','high',1000000],
  ['claude-opus','opus','Claude Opus 5.5','medium',1000000],
  ['claude-sonnet','sonnet','Claude Sonnet 5.5','medium',1000000],
  ['claude-haiku','haiku','Claude Haiku 4.5',null,200000]]);
 assert.equal(models.get('claude-fable').family,'fable');
 assert.deepEqual(models.get('claude-fable').efforts,['low','medium','high','xhigh','max']);
 assert.deepEqual(models.get('claude-sonnet').efforts,['low','medium','high','xhigh','max']);
 assert.deepEqual(models.get('claude-haiku').efforts,[]);
 assert.equal(models.get('claude-opus-5-5'),undefined);
});
test('CLAUDE_BRIDGE_MODELS points the bridge at a custom catalog',t=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'models-')),'models.json');
 fs.writeFileSync(file,JSON.stringify({models:[entry({slug:'opus-pinned',claude_model:'claude-opus-5-5',display_name:'Claude Opus 5.5'})]}));
 t.after(()=>fs.rmSync(path.dirname(file),{recursive:true}));
 const models=loadModels(file);
 assert.equal(models.default,'opus-pinned');assert.equal(models.get('opus-pinned').family,null);assert.equal(models.get('opus-pinned').default_effort,'medium');
});
test('catalog mistakes are reported instead of guessed',()=>{
 assert.throws(()=>parseModels({models:[]}),/non-empty "models" list/);
 assert.throws(()=>parseModels({models:[entry({claude_model:''})]}),/"claude_model" string/);
 assert.throws(()=>parseModels({models:[entry(),entry()]}),/Duplicate model slug m/);
 assert.throws(()=>parseModels({models:[entry({efforts:['ultra']})]}),/efforts must be drawn from low, medium, high, xhigh, max/);
 assert.throws(()=>parseModels({models:[entry({default_effort:'max'})]}),/default_effort must be one of its efforts/);
 assert.throws(()=>parseModels({models:[entry({context_window:0})]}),/positive integer/);
 assert.throws(()=>parseModels({default:'other',models:[entry()]}),/Default model other is not in the catalog/);
});
test('aliases follow their family; model ids match exactly',()=>{
 assert.equal(familyOf('opus'),'opus');assert.equal(familyOf('Sonnet[1m]'),'sonnet');assert.equal(familyOf('claude-opus-5-5'),null);
 const alias=parseModels({models:[entry()]}).get('m');
 assert.ok(startedModelMatches(alias,'claude-opus-5-5'));assert.ok(startedModelMatches(alias,'claude-opus-6'));
 assert.ok(!startedModelMatches(alias,'claude-sonnet-5-5'));assert.ok(!startedModelMatches(alias,undefined));
 const pinned=parseModels({models:[entry({claude_model:'claude-opus-5-5[1m]'})]}).get('m');
 assert.ok(startedModelMatches(pinned,'claude-opus-5-5'));assert.ok(startedModelMatches(pinned,'claude-opus-5-5[1m]'));
 assert.ok(!startedModelMatches(pinned,'claude-opus-5-6'));
});
test('an alias entry is named after the version Claude Code started; a pinned entry keeps its name',()=>{
 assert.deepEqual(['claude-fable-5-1','claude-opus-5','claude-haiku-4-5-20251001','claude-opus-6[1m]','gpt-6','claude-opus-latest'].map(id=>versionOf(id)),['5.1','5','4.5','6',null,null]);
 assert.equal(versionOf('claude-opus-5-5','fable'),null);
 const [fable,haiku]=parseModels({models:[entry({slug:'f',claude_model:'fable',display_name:'Claude Fable 5.1'}),entry({slug:'h',claude_model:'haiku',display_name:'Claude Haiku'})]}).list;
 assert.equal(labelFor(fable),'Claude Fable 5.1');
 assert.equal(labelFor(fable,'claude-fable-5-5'),'Claude Fable 5.5');
 assert.equal(labelFor(fable,'claude-opus-5-5'),'Claude Fable 5.1');
 assert.equal(labelFor(haiku,'claude-haiku-4-5-20251001'),'Claude Haiku 4.5');
 const pinned=parseModels({models:[entry({claude_model:'claude-opus-5-5',display_name:'My Opus'})]}).get('m');
 assert.equal(labelFor(pinned,'claude-opus-5-5'),'My Opus');
 const models=loadModels();
 assert.deepEqual(labeled(models,new Map([['claude-opus','claude-opus-5-6']])).list.map(m=>m.display_name),['Claude Fable 5.1','Claude Opus 5.6','Claude Sonnet 5.5','Claude Haiku 4.5']);
 assert.equal(models.get('claude-opus').display_name,'Claude Opus 5.5');
});
test('effort defaults per model, and models without effort take none',()=>{
 const models=loadModels();
 assert.equal(effortFor(models.get('claude-fable')),'high');
 assert.equal(effortFor(models.get('claude-opus')),'medium');
 assert.equal(effortFor(models.get('claude-sonnet'),'xhigh'),'xhigh');
 assert.equal(effortFor(models.get('claude-haiku'),'high'),null);
 assert.throws(()=>effortFor(models.get('claude-opus'),'ultra'),e=>e.statusCode===400&&/Claude Opus 5\.5 does not support ultra effort\. Choose one of: low, medium, high, xhigh, max\./.test(e.message));
});

test('the bridge and the Python setup build the same catalog entries and names',async()=>{
 const {catalogEntries}=await import('../src/catalog.mjs');
 const {execFileSync}=await import('node:child_process');
 const template={slug:'gpt-fixture',tool_mode:'code_mode_only',priority:7,input_modalities:['text','image'],model_messages:{instructions_template:'You are Codex, a coding agent.\nRules.'},service_tiers:['flex']};
 const started={'claude-fable':'claude-fable-5-5','claude-haiku':'claude-haiku-5-20261101'};
 const script='import json,sys\nsys.path.insert(0,"scripts")\nfrom sync_runtime import model_catalog\nfrom bridge_config import load_models\nprint(json.dumps(model_catalog(json.loads(sys.argv[1]),load_models(),json.loads(sys.argv[2]))))';
 const python=JSON.parse(execFileSync('python3',['-c',script,JSON.stringify(template),JSON.stringify(started)],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
 const node=catalogEntries(template,labeled(loadModels(),new Map(Object.entries(started))));
 assert.deepEqual(node,python);
 assert.deepEqual(node.map(m=>m.display_name),['Claude Fable 5.5','Claude Opus 5.5','Claude Sonnet 5.5','Claude Haiku 5']);
 assert.match(node[0].model_messages.instructions_template,/^You are Claude Fable 5\.5, running as the main assistant/);
});
