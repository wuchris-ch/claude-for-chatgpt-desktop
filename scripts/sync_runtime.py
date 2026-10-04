#!/usr/bin/env python3
"""Refresh capabilities while preserving the isolated instance's preferences."""
import copy
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
from urllib.parse import quote
from bridge_config import PROVIDER_ID, load_models, runtime_dir, load_launch

# The desktop compacts at this share of a model's context window, below
# Claude's own limit, so its summary request still fits.
AUTO_COMPACT_SHARE = 0.8
IDENTITY = 'You are {name}, running as the main assistant in ChatGPT Desktop. You and the user share one workspace, and your job is to collaborate with them until their intended goal is completely handled.'

def set_standalone_search(codex, enabled=True):
    """Change only the three search settings, retaining comments and preferences.

    Standalone search sends the desktop's ChatGPT credentials, through the
    bridge, to OpenAI's search endpoint. It is opt-in."""
    config=pathlib.Path(codex)/'config.toml'
    if not config.exists():return False
    original=config.read_text();value=original
    flag='true' if enabled else 'false'
    for section,key,setting in [('', 'web_search', '"live"' if enabled else '"disabled"'),
                                ('features','standalone_web_search',flag),
                                ('model_providers.'+PROVIDER_ID,'supports_standalone_web_search',flag)]:
        headers=list(re.finditer(r'^[ \t]*\[[^\n]+\][ \t]*$',value,re.M))
        if not section:
            start=0;end=headers[0].start() if headers else len(value)
        else:
            found=next((i for i,h in enumerate(headers) if h.group().strip()=='['+section+']'),None)
            if found is None:
                value=value.rstrip()+'\n\n['+section+']\n'+key+' = '+setting+'\n';continue
            start=headers[found].end();end=headers[found+1].start() if found+1<len(headers) else len(value)
        block=value[start:end]
        pattern=r'^[ \t]*'+re.escape(key)+r'[ \t]*=.*$'
        if re.search(pattern,block,re.M):block=re.sub(pattern,key+' = '+setting,block,flags=re.M)
        else:block=block.rstrip()+'\n'+key+' = '+setting+'\n\n'
        value=value[:start]+block+value[end:]
    if value==original:return False
    temporary=config.with_name('config.toml.search-tmp')
    temporary.write_text(value);shutil.copymode(config,temporary);temporary.replace(config)
    return True

def enable_standalone_search(codex):
    return set_standalone_search(codex, True)

def model_catalog(template, models):
    """Desktop catalog entries for the Claude models, built from a GPT entry."""
    entries=[]
    for priority,m in enumerate(models['models'],start=1):
        model=copy.deepcopy(template)
        efforts=m.get('efforts') or []
        # The desktop expects at least one level. Models without an effort
        # setting get one fixed level, which the bridge does not pass on.
        levels=[{'effort':x,'description':x.capitalize()+' reasoning effort'} for x in efforts] or [{'effort':'medium','description':'Fixed: this model has no effort setting'}]
        default=m.get('default_effort') or ('medium' if not efforts or 'medium' in efforts else efforts[0])
        window=int(m['context_window'])
        # Tool search defers connector tools to ALL_TOOLS inside exec, as for GPT.
        # Without it every request inlined about 145k tokens of app documentation.
        model.update(slug=m['slug'], display_name=m['display_name'], description=m.get('description',''),
                     default_reasoning_level=default, supported_reasoning_levels=levels,
                     additional_speed_tiers=[], service_tiers=[], available_access_programs={'cyber':[]}, availability_nux=None,
                     context_window=window, max_context_window=window, auto_compact_token_limit=int(window*AUTO_COMPACT_SHARE),
                     support_verbosity=False, default_reasoning_summary='none', use_responses_lite=False, supports_search_tool=True,
                     multi_agent_reasoning_effort=default, upgrade=None, priority=priority, visibility='list')
        messages = model.get('model_messages')
        if messages and messages.get('instructions_template'):
            messages['instructions_template'] = re.sub(r'^You are Codex[^\n]*', lambda _: IDENTITY.format(name=m['display_name']),
                messages['instructions_template'], count=1)
        entries.append(model)
    return entries

def isolate_mcp_descriptors(package, source, codex):
    """Rebase runtime paths before publishing a package into the trusted cache."""
    source, codex = pathlib.Path(source).absolute(), pathlib.Path(codex).absolute()
    # Handle file URLs before plain paths so spaces in the isolated home retain
    # URL encoding. Shell-style home paths sometimes occur in launcher arguments.
    replacements = [
        (source.as_uri(), codex.as_uri()),
        (str(source), str(codex)),
        (quote(str(source), safe='/'), quote(str(codex), safe='/')),
    ]
    if source.name == '.codex':
        replacements += [(prefix+'/.codex', str(codex)) for prefix in ['~', '$HOME', '${HOME}']]
    patterns = []
    seen = set()
    for old, new in replacements:
        if old in seen:continue
        seen.add(old)
        # Do not rewrite an unrelated sibling such as .codex-backup.
        patterns.append((re.compile(re.escape(old)+r'(?![\w.\-])'), new))

    def rebase(value):
        if isinstance(value, str):
            for pattern, replacement in patterns:
                value = pattern.sub(lambda match: replacement, value)
            return value
        if isinstance(value, list):return [rebase(item) for item in value]
        if isinstance(value, dict):return {key:rebase(item) for key,item in value.items()}
        return value

    rewritten = 0
    for descriptor in sorted(pathlib.Path(package).rglob('.mcp.json')):
        if descriptor.is_symlink():
            raise RuntimeError('Refusing a symlinked MCP descriptor: '+str(descriptor))
        original = json.loads(descriptor.read_text())
        updated = rebase(original)
        serialized = json.dumps(updated, indent=2, ensure_ascii=False)+'\n'
        # Include keys as well as values in validation. An unexpected location
        # for a source-home reference must block launch, never pass unnoticed.
        if any(pattern.search(serialized) for pattern,_ in patterns):
            raise RuntimeError('MCP descriptor still references the original Codex home: '+str(descriptor))
        if updated != original:
            temp = descriptor.with_name('.mcp.json.bridge-tmp')
            temp.write_text(serialized)
            shutil.copymode(descriptor, temp)
            temp.replace(descriptor)
            rewritten += 1
    return rewritten

def refresh_capabilities(source, codex, models=None, web_search=False):
    source, codex = pathlib.Path(source), pathlib.Path(codex)
    models = models or load_models()
    copied = []
    rewritten = 0
    # Package code is copied once per version. Instance-specific MCP descriptor
    # paths must be rebased before the host can load the package.
    cache = source/'plugins/cache'
    for version in sorted(cache.glob('*/*/*')):
        if version.is_symlink() or not version.is_dir() or not (version/'.codex-plugin/plugin.json').exists():
            continue
        dest = codex/'plugins/cache'/version.relative_to(cache)
        if dest.is_symlink():
            raise RuntimeError('The isolated plugin cache must not contain symlinked packages: '+str(dest))
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            staging = codex/'plugins/.bridge-sync-staging'
            staging.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tempfile.TemporaryDirectory(prefix='package-', dir=staging) as temporary:
                stage = pathlib.Path(temporary)/'package'
                subprocess.run(['/usr/bin/ditto', str(version), str(stage)], check=True)
                rewritten += isolate_mcp_descriptors(stage, source, codex)
                stage.rename(dest)
            copied.append(str(version.relative_to(cache)))
        else:
            # Also repair packages copied by initial setup or older sync versions.
            rewritten += isolate_mcp_descriptors(dest, source, codex)
    # Isolated-only packages may no longer exist in the normal cache. Audit them
    # as well, without changing their enabled settings or replacing their code.
    for version in sorted((codex/'plugins/cache').glob('*/*/*')):
        if version.is_symlink() or not version.is_dir() or not (version/'.codex-plugin/plugin.json').exists():continue
        rewritten += isolate_mcp_descriptors(version, source, codex)
    for alias in cache.glob('*/*/*'):
        if not alias.is_symlink():continue
        resolved=alias.resolve()
        if not resolved.is_relative_to(cache.resolve()):continue
        dest=codex/'plugins/cache'/alias.relative_to(cache)
        target=codex/'plugins/cache'/resolved.relative_to(cache.resolve())
        if target.exists() and (not dest.is_symlink() or dest.resolve()!=target.resolve()):
            if dest.exists() and not dest.is_symlink():continue
            stage=dest.with_name('.'+dest.name+'.bridge-link')
            stage.unlink(missing_ok=True);stage.symlink_to(target.name);stage.replace(dest)
    # These helpers are installed app executables, not instance configuration.
    helpers=source/'plugins/.plugin-appserver'
    for executable in helpers.glob('*'):
        if not executable.is_file():continue
        dest=codex/'plugins/.plugin-appserver'/executable.name
        if not dest.exists() or (dest.stat().st_size,dest.stat().st_mtime_ns)!=(executable.stat().st_size,executable.stat().st_mtime_ns):
            dest.parent.mkdir(parents=True,exist_ok=True)
            stage=dest.with_name(dest.name+'.bridge-copy')
            shutil.copy2(executable,stage);stage.replace(dest)
    cache = source/'models_cache.json'
    if not cache.exists():
        raise RuntimeError('ChatGPT has not downloaded its model list yet. Open the ChatGPT app once, then run this again.')
    available = json.loads(cache.read_text())['models']
    template = next((m for m in available if m.get('tool_mode') == 'code_mode_only'), None)
    if template is None:
        raise RuntimeError('No code-mode model found in '+str(cache)+'. This ChatGPT version is not supported yet.')
    target=codex/'models.json'
    value=json.dumps({'models':model_catalog(template, models)},indent=2)
    model_changed=not target.exists() or target.read_text()!=value
    if model_changed:
        temp=target.with_suffix('.json.tmp');temp.write_text(value);temp.replace(target)
    search_changed=set_standalone_search(codex, web_search)
    return {'plugins_added':copied,'mcp_descriptors_rewritten':rewritten,'model_catalog_refreshed':model_changed,'search_config_refreshed':search_changed}

if __name__=='__main__':
    runtime=runtime_dir();config=load_launch(runtime)
    print(json.dumps(refresh_capabilities(pathlib.Path.home()/'.codex',runtime/'codex',load_models(config.get('models_file')),config.get('web_search',False)),indent=2))
