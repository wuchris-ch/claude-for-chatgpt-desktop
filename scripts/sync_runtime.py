#!/usr/bin/env python3
"""Refresh capabilities while preserving the isolated instance's preferences."""
import base64
import copy
import hashlib
import hmac
import json
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from urllib.parse import quote
from bridge_config import DEFAULT_PORT, PROJECT, PROVIDER_ID, load_models, root_end, runtime_dir, load_launch, statements, string_value

# The desktop compacts at this share of a model's context window, below
# Claude's own limit, so its summary request still fits.
AUTO_COMPACT_SHARE = 0.8
IDENTITY = 'You are {name}, running as the main assistant in ChatGPT Desktop. You and the user share one workspace, and your job is to collaborate with them until their intended goal is completely handled.'
# Same rules as familyOf, versionOf and labelFor in src/models.mjs.
FAMILIES = ('opus', 'sonnet', 'haiku', 'fable')
MODEL_ID = re.compile(r'^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$', re.I)

def label_for(m, started=None):
    """An alias entry is named after the model Claude Code last started for it."""
    family = re.sub(r'\[1m\]$', '', m['claude_model'], flags=re.I).lower()
    match = MODEL_ID.match(started or '') if family in FAMILIES else None
    if not match or match.group(1).lower() != family:
        return m['display_name']
    version = match.group(2) + ('.' + match.group(3) if match.group(3) else '')
    return re.sub(r'\s+\d+(?:\.\d+)*$', '', m['display_name']) + ' ' + version

def load_started(runtime):
    """The models Claude Code last started for each entry, as the bridge records them."""
    try:
        value = json.loads((pathlib.Path(runtime)/'sessions'/'started-models.json').read_text())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in value.items() if isinstance(v, str)} if isinstance(value, dict) else {}

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
        lines=statements(value)
        headers=[s for s in lines if s[0] in ('table','array')]
        root=headers[0][2] if headers else len(value)
        found=next((i for i,h in enumerate(headers) if h[0]=='table' and h[1]==section),None) if section else None
        # A root setting like features.memories = false defines the table too,
        # and a second [features] would make the file invalid.
        dotted=section and found is None and any(s[0]=='key' and s[1].startswith(section+'.') and s[2]<root for s in lines)
        if not section or dotted:
            start=0;end=root
            if dotted:key=section+'.'+key
        elif found is None:
            value=value.rstrip()+'\n\n['+section+']\n'+key+' = '+setting+'\n';continue
        else:
            start=headers[found][3];end=headers[found+1][2] if found+1<len(headers) else len(value)
        line=next((s for s in lines if s[0]=='key' and s[1]==key and start<=s[2]<end),None)
        if line:value=value[:line[2]]+key+' = '+setting+('\n' if value[line[3]-1:line[3]]=='\n' else '')+value[line[3]:]
        else:value=value[:start]+value[start:end].rstrip()+'\n'+key+' = '+setting+'\n\n'+value[end:]
    if value==original:return False
    temporary=config.with_name('config.toml.search-tmp')
    temporary.write_text(value);shutil.copymode(config,temporary);temporary.replace(config)
    return True

def enable_standalone_search(codex):
    return set_standalone_search(codex, True)

def provider_key(token):
    """The path key for the app's own provider, as providerKey in src/server.mjs derives it."""
    digest=hmac.new(token.encode(),(PROJECT+' app provider v1').encode(),hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode()

def app_provider_url(token, port=DEFAULT_PORT):
    return f'http://127.0.0.1:{int(port)}/k/{provider_key(token)}/v1'

def provider_settings_hold(text, url, provider):
    """Whether the new file parses with these root settings. Python before 3.11 has no parser."""
    try:
        import tomllib
    except ImportError:
        return True
    try:
        data=tomllib.loads(text)
    except ValueError:
        return False
    return data.get('model_provider')==provider and (url is None or data.get('openai_base_url')==url)

def set_app_provider(codex, token, enabled, port=DEFAULT_PORT):
    """Select the app's own provider, pointed at the bridge, or the claude_bridge provider.

    ChatGPT desktop 26.1016 hides dictation unless config.toml selects its own
    `openai` provider. New threads then reach the bridge through
    openai_base_url; follow_window_provider moves threads started earlier,
    and claude_bridge stays defined. Only call this with enabled=True while the running bridge reports
    app_provider: an older bridge answers the path with 401, which the app
    reads as an expired ChatGPT login. Switching off keeps openai_base_url:
    threads saved on the app's provider resume on it, and without the URL it
    sends them to OpenAI's servers.
    """
    config=pathlib.Path(codex)/'config.toml'
    if not config.exists():return False
    original=config.read_text()
    end=root_end(original)
    root,tables=original[:end],original[end:]
    url=app_provider_url(token,port)
    # Lines inside a multi-line string or array are never settings.
    lines=statements(root)
    urls=[s for s in lines if s[0]=='key' and s[1]=='openai_base_url']
    providers=[s for s in lines if s[0]=='key' and s[1]=='model_provider']
    # /g/ is the picker's setting, which an older setup copied from ~/.codex.
    # It would send this profile's requests through the GPT relay.
    ours=[s for s in urls if re.fullmatch(r'http://127\.0\.0\.1:'+str(int(port))+r'/[kg]/[^"]*',string_value(root,s) or '')]
    marks=[lines[i-1] for i,s in enumerate(lines) if s in ours and i and lines[i-1][0]=='comment' and lines[i-1][1].startswith('# Added by '+PROJECT)]
    current=any(string_value(root,s)==url for s in urls)
    provider=string_value(root,providers[0]) if providers else None
    foreign=any(s not in ours for s in urls)
    if enabled and current and not providers:return False
    if not enabled and (current or foreign) and provider==PROVIDER_ID:return False
    if enabled and foreign:
        print('The Claude window keeps the '+PROVIDER_ID+' provider: its config.toml sets another openai_base_url.',file=sys.stderr)
        return False
    drop=providers+([] if foreign else ours+marks)
    kept,pos=[],0
    for s in sorted(drop,key=lambda s:s[2]):kept.append(root[pos:s[2]]);pos=s[3]
    root=''.join(kept)+root[pos:]
    if not foreign:root=root.rstrip('\n')+'\nopenai_base_url = '+json.dumps(url)+'\n'
    if not enabled:root=root.rstrip('\n')+'\nmodel_provider = "'+PROVIDER_ID+'"\n'
    if tables:root=root.rstrip('\n')+'\n\n'
    root=root.lstrip('\n')
    if root+tables==original:return False
    # Without either setting in the root table the app's provider would send
    # chats to OpenAI, so a file this code can't place them in stays as it is.
    if not provider_settings_hold(root+tables,None if foreign else url,None if enabled else PROVIDER_ID):
        print('The Claude window keeps its provider: its config.toml could not be updated safely.',file=sys.stderr)
        return False
    temporary=config.with_name('config.toml.provider-tmp')
    temporary.unlink(missing_ok=True);temporary.touch(mode=0o600)
    temporary.write_text(root+tables);shutil.copymode(config,temporary);temporary.replace(config)
    return True

def window_provider(codex, token, port=DEFAULT_PORT):
    """The provider the window's config.toml selects, when both of the
    bridge's providers reach this bridge, or None."""
    config=pathlib.Path(codex)/'config.toml'
    if not config.exists():return None
    text=config.read_text()
    root=text[:root_end(text)]
    lines=statements(root)
    urls=[string_value(root,s) for s in lines if s[0]=='key' and s[1]=='openai_base_url']
    providers=[string_value(root,s) for s in lines if s[0]=='key' and s[1]=='model_provider']
    if urls!=[app_provider_url(token,port)] or len(providers)>1:return None
    provider=providers[0] if providers else 'openai'
    return provider if provider in ('openai',PROVIDER_ID) else None

def move_threads(codex, provider, timeout=10):
    """Saves every chat on `provider`, the other of the bridge's two providers.

    ChatGPT desktop 26.1029 (Codex 0.166.0-alpha.6) refuses to resume a chat
    saved on a provider other than the window's, with "This chat uses
    claude_bridge, but your current provider is openai". Both providers reach
    this bridge, so a chat can move between them. The app reads a chat's
    provider from its state database, and records the new one in the chat's
    rollout when it next resumes it. Returns the number of chats moved.
    """
    other={'openai':PROVIDER_ID,PROVIDER_ID:'openai'}[provider]
    moved=0
    for path in sorted(pathlib.Path(codex).glob('state_*.sqlite')):
        try:
            db=sqlite3.connect(str(path),timeout=timeout,isolation_level=None)
            try:
                if 'model_provider' not in {row[1] for row in db.execute('pragma table_info(threads)')}:continue
                db.execute('begin immediate')
                moved+=db.execute('update threads set model_provider=? where model_provider=?',(provider,other)).rowcount
                db.execute('commit')
            finally:db.close()
        except sqlite3.Error as error:
            print(f'Chats in {path.name} keep their provider: {error}',file=sys.stderr)
    return moved

def follow_window_provider(codex, token, port=DEFAULT_PORT):
    """Moves saved chats to the provider the window now selects."""
    try:provider=window_provider(codex,token,port)
    except (OSError,UnicodeDecodeError) as error:
        print(f'Chats keep their provider: {error}',file=sys.stderr)
        return 0
    return move_threads(codex,provider) if provider else 0

def model_catalog(template, models, started=None):
    """Desktop catalog entries for the Claude models, built from a GPT entry."""
    started = started or {}
    entries=[]
    for priority,m in enumerate(models['models'],start=1):
        model=copy.deepcopy(template)
        name=label_for(m, started.get(m['slug']))
        efforts=m.get('efforts') or []
        # The desktop expects at least one level. Models without an effort
        # setting get one fixed level, which the bridge does not pass on.
        levels=[{'effort':x,'description':x.capitalize()+' reasoning effort'} for x in efforts] or [{'effort':'medium','description':'Fixed: this model has no effort setting'}]
        default=m.get('default_effort') or ('medium' if not efforts or 'medium' in efforts else efforts[0])
        window=int(m['context_window'])
        # Tool search defers connector tools to ALL_TOOLS inside exec, as for GPT.
        # Without it every request inlined about 145k tokens of app documentation.
        model.update(slug=m['slug'], display_name=name, description=m.get('description',''),
                     default_reasoning_level=default, supported_reasoning_levels=levels,
                     additional_speed_tiers=[], service_tiers=[], available_access_programs={'cyber':[]}, availability_nux=None,
                     context_window=window, max_context_window=window, auto_compact_token_limit=int(window*AUTO_COMPACT_SHARE),
                     support_verbosity=False, default_reasoning_summary='none', use_responses_lite=False, supports_search_tool=True,
                     multi_agent_reasoning_effort=default, upgrade=None, priority=priority, visibility='list')
        messages = model.get('model_messages')
        if messages and messages.get('instructions_template'):
            messages['instructions_template'] = re.sub(r'^You are Codex[^\n]*', lambda _: IDENTITY.format(name=name),
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
    # The isolated profile lives in the runtime directory, next to the bridge's state.
    value=json.dumps({'models':model_catalog(template, models, load_started(codex.parent))},indent=2)
    model_changed=not target.exists() or target.read_text()!=value
    if model_changed:
        temp=target.with_suffix('.json.tmp');temp.write_text(value);temp.replace(target)
    search_changed=set_standalone_search(codex, web_search)
    return {'plugins_added':copied,'mcp_descriptors_rewritten':rewritten,'model_catalog_refreshed':model_changed,'search_config_refreshed':search_changed}

if __name__=='__main__':
    runtime=runtime_dir();config=load_launch(runtime)
    print(json.dumps(refresh_capabilities(pathlib.Path.home()/'.codex',runtime/'codex',load_models(config.get('models_file')),config.get('web_search',False)),indent=2))
