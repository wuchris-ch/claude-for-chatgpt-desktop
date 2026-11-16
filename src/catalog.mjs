// Desktop model catalog entries for the Claude models, built from one of the
// app's own GPT entries so fields this file does not know keep app defaults.
// scripts/sync_runtime.py builds the same entries for the separate window.
export const AUTO_COMPACT_SHARE=0.8;
export const identity=name=>`You are ${name}, running as the main assistant in ChatGPT Desktop. You and the user share one workspace, and your job is to collaborate with them until their intended goal is completely handled.`;

// Code mode with tool search is what GPT uses; Claude needs the same entry shape.
// The copied entry also sets what the engine offers a model: the multi-agent
// version, and clock.sleep and the async question card, which it gives only to
// a model whose entry names them. The first entry was copied until November
// 2026, when a ChatGPT account's list began with gpt-reserve, a hidden fallback
// model with none of these. The choice is now the entry that turns on the most,
// then a visible one, then the app's own order. The bridge's own entries are
// never copied.
const TEMPLATE_TOOLS=new Set(['clock','send_user_message_async','request_user_input_async']);
export const templateRank=m=>[m?.multi_agent_version==='v2'?1:0,(m?.experimental_supported_tools??[]).filter(t=>TEMPLATE_TOOLS.has(t)).length,m?.visibility!=='hide'?1:0,-(Number(m?.priority)||0)];
const outranks=(a,b)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]>b[i];return false;};
export function pickTemplate(list) {
  let best=null;
  for(const m of list) {
    if(m?.tool_mode!=='code_mode_only'||String(m.slug??'').startsWith('claude-'))continue;
    if(!best||outranks(templateRank(m),templateRank(best)))best=m;
  }
  return best;
}

export function catalogEntries(template,models,{priorityStart=1}={}) {
  return models.list.map((m,i)=>{
    const entry=structuredClone(template);
    // The desktop expects at least one level. A model without an effort
    // setting gets one fixed level, which the bridge does not pass on.
    const levels=m.efforts.length
      ?m.efforts.map(e=>({effort:e,description:e[0].toUpperCase()+e.slice(1)+' reasoning effort'}))
      :[{effort:'medium',description:'Fixed: this model has no effort setting'}];
    const effort=m.default_effort??'medium';
    // Tool search defers connector tools to ALL_TOOLS inside exec, as for GPT.
    Object.assign(entry,{slug:m.slug,display_name:m.display_name,description:m.description,
      default_reasoning_level:effort,supported_reasoning_levels:levels,additional_speed_tiers:[],service_tiers:[],
      available_access_programs:{cyber:[]},availability_nux:null,context_window:m.context_window,max_context_window:m.context_window,
      auto_compact_token_limit:Math.floor(m.context_window*AUTO_COMPACT_SHARE),support_verbosity:false,default_reasoning_summary:'none',
      use_responses_lite:false,supports_search_tool:true,multi_agent_reasoning_effort:effort,upgrade:null,priority:priorityStart+i,visibility:'list',
      // With this on, the engine sends the items that record an effort change
      // inside a chat. If the copied entry turned it off, the history a chat
      // sent no longer matched the bridge's saved copy, and the chat was rebuilt.
      supports_reasoning_effort_updates:true});
    const instructions=entry.model_messages?.instructions_template;
    if(instructions)entry.model_messages={...entry.model_messages,instructions_template:instructions.replace(/^You are Codex[^\n]*/,()=>identity(m.display_name))};
    return entry;
  });
}
