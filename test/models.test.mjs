import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadModels, parseModels, familyOf, startedModelMatches, effortFor} from '../src/models.mjs';

const entry=extra=>({slug:'m',claude_model:'opus',display_name:'Claude Opus',efforts:['low','medium','high'],context_window:1000000,...extra});

test('the shipped catalog offers Opus, Sonnet and Haiku through Claude Code aliases',()=>{
 const models=loadModels();
 assert.equal(models.default,'claude-opus');
 assert.deepEqual(models.list.map(m=>[m.slug,m.claude_model,m.display_name,m.default_effort,m.context_window]),[
  ['claude-opus','opus','Claude Opus','medium',1000000],
  ['claude-sonnet','sonnet','Claude Sonnet','medium',1000000],
  ['claude-haiku','haiku','Claude Haiku',null,200000]]);
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
test('effort defaults per model, and models without effort take none',()=>{
 const models=loadModels();
 assert.equal(effortFor(models.get('claude-opus')),'medium');
 assert.equal(effortFor(models.get('claude-sonnet'),'xhigh'),'xhigh');
 assert.equal(effortFor(models.get('claude-haiku'),'high'),null);
 assert.throws(()=>effortFor(models.get('claude-opus'),'ultra'),e=>e.statusCode===400&&/Claude Opus does not support ultra effort\. Choose one of: low, medium, high, xhigh, max\./.test(e.message));
});

test('the bridge and the Python setup build the same catalog entries',async()=>{
 const {catalogEntries}=await import('../src/catalog.mjs');
 const {execFileSync}=await import('node:child_process');
 const template={slug:'gpt-fixture',tool_mode:'code_mode_only',priority:7,input_modalities:['text','image'],model_messages:{instructions_template:'You are Codex, a coding agent.\nRules.'},service_tiers:['flex']};
 const script='import json,sys\nsys.path.insert(0,"scripts")\nfrom sync_runtime import model_catalog\nfrom bridge_config import load_models\nprint(json.dumps(model_catalog(json.loads(sys.argv[1]),load_models())))';
 const python=JSON.parse(execFileSync('python3',['-c',script,JSON.stringify(template)],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
 assert.deepEqual(catalogEntries(template,loadModels()),python);
});

