import fs from 'node:fs';

// Reasoning levels Claude Code accepts with --effort.
export const EFFORTS=['low','medium','high','xhigh','max'];
// Claude Code's family aliases. An alias follows Claude Code to new releases;
// a full model id such as claude-opus-5-5 pins one version.
const FAMILIES=['opus','sonnet','haiku','fable'];
export const DEFAULT_MODELS_FILE=new URL('../claude-models.json',import.meta.url);

export function loadModels(file=process.env.CLAUDE_BRIDGE_MODELS||DEFAULT_MODELS_FILE) {
  return parseModels(JSON.parse(fs.readFileSync(file,'utf8')));
}

// "opus" and "opus[1m]" name a family; anything else is a model id.
export function familyOf(name) {
  const base=name.replace(/\[1m\]$/i,'').toLowerCase();
  return FAMILIES.includes(base)?base:null;
}

export function parseModels(config) {
  const models=config?.models;
  if(!Array.isArray(models)||!models.length)throw new Error('The model catalog needs a non-empty "models" list.');
  const seen=new Set();
  const list=models.map(m=>{
    for(const key of ['slug','claude_model','display_name'])
      if(typeof m?.[key]!=='string'||!m[key].trim())throw new Error(`Each model needs a "${key}" string.`);
    if(seen.has(m.slug))throw new Error(`Duplicate model slug ${m.slug}.`);
    seen.add(m.slug);
    const efforts=m.efforts??[];
    if(!Array.isArray(efforts)||efforts.some(e=>!EFFORTS.includes(e)))throw new Error(`${m.slug}: efforts must be drawn from ${EFFORTS.join(', ')}.`);
    const defaultEffort=efforts.length?(m.default_effort??(efforts.includes('medium')?'medium':efforts[0])):null;
    if(defaultEffort!==null&&!efforts.includes(defaultEffort))throw new Error(`${m.slug}: default_effort must be one of its efforts.`);
    if(!Number.isInteger(m.context_window)||m.context_window<=0)throw new Error(`${m.slug}: context_window must be a positive integer.`);
    return Object.freeze({...m,description:m.description??'',efforts:Object.freeze([...efforts]),default_effort:defaultEffort,family:familyOf(m.claude_model)});
  });
  const fallback=config.default??list[0].slug;
  if(!seen.has(fallback))throw new Error(`Default model ${fallback} is not in the catalog.`);
  return Object.freeze({list:Object.freeze(list),default:fallback,get:slug=>list.find(m=>m.slug===slug)});
}

// Claude Code reports the model it started. An alias accepts any model of its
// family, because an organization restriction can substitute another version
// of it; a model id must match exactly, apart from the [1m] context suffix.
export function startedModelMatches(model,actual) {
  if(typeof actual!=='string')return false;
  if(model.family)return actual.startsWith(`claude-${model.family}-`);
  return actual.replace(/\[1m\]$/i,'')===model.claude_model.replace(/\[1m\]$/i,'');
}

// Claude Code model ids carry their version: claude-fable-5-1, claude-opus-5,
// claude-haiku-4-5-20251001. Returns "5.1", "5" or "4.5", or null for an id of
// another family or shape.
export function versionOf(id,family) {
  const m=/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(typeof id==='string'?id:'');
  if(!m||(family&&m[1].toLowerCase()!==family))return null;
  return m[3]?`${m[2]}.${m[3]}`:m[2];
}

// An alias entry is named after the model Claude Code last started for it, so
// "Claude Fable 5.1" reads "Claude Fable 5.5" once Claude Code moves the alias
// on. An entry that pins a model id keeps the name its catalog gives it.
export function labelFor(model,started) {
  const version=model.family?versionOf(started,model.family):null;
  return version?`${model.display_name.replace(/\s+\d+(?:\.\d+)*$/,'')} ${version}`:model.display_name;
}

// The catalog list with each entry named by labelFor. started maps a slug to
// the model id Claude Code last started for it.
export function labeled(models,started=new Map()) {
  return {...models,list:models.list.map(m=>({...m,display_name:labelFor(m,started.get(m.slug))}))};
}

// Haiku-class models have no effort setting: the desktop's fixed level is
// accepted and nothing is passed to Claude Code.
export function effortFor(model,requested) {
  if(!model.efforts.length)return null;
  const effort=requested??model.default_effort;
  if(!model.efforts.includes(effort))
    throw Object.assign(new Error(`${model.display_name} does not support ${effort} effort. Choose one of: ${model.efforts.join(', ')}.`),{statusCode:400});
  return effort;
}
