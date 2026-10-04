#!/usr/bin/env python3
"""Prepare an isolated ChatGPT desktop profile that uses Claude through the bridge.

Your normal ChatGPT profile (~/.codex) is only read: its settings seed the new
profile, its plugins are copied, and its model list provides the catalog shape.
Run again to change settings; it rewrites the isolated profile's config.toml.
"""
import argparse
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
from bridge_config import (APP_NAME, DEFAULT_APP, DEFAULT_LABEL, DEFAULT_PORT, PROVIDER_ID,
                           load_models, runtime_dir, source_home)
from sync_runtime import refresh_capabilities

# Root settings this profile owns. Per-model context windows and compaction
# limits live in the model catalog, so global overrides are removed.
REMOVED_KEYS = ['model_context_window', 'model_auto_compact_token_limit']


def drop_tables(text, name):
    """Remove the TOML table name and its subtables, keeping everything else."""
    headers = list(re.finditer(r'^[ \t]*\[\[?([^\]\n]+)\]\]?[ \t]*$', text, re.M))
    if not headers:
        return text
    kept = text[:headers[0].start()]
    for i, header in enumerate(headers):
        end = headers[i+1].start() if i+1 < len(headers) else len(text)
        table = header.group(1).strip()
        if table != name and not table.startswith(name+'.'):
            kept += text[header.start():end]
    return kept


def build_config(source_text, *, codex, port, token, default_model, web_search):
    """The isolated config.toml: the normal profile's settings, pointed at the bridge."""
    first_table = re.search(r'^\[', source_text, re.M)
    root, tables = (source_text[:first_table.start()], source_text[first_table.start():]) if first_table else (source_text, '')
    overrides = {
        'model': default_model, 'model_provider': PROVIDER_ID, 'model_catalog_json': str(codex/'models.json'),
        'model_reasoning_summary': 'none', 'review_model': default_model,
        'web_search': 'live' if web_search else 'disabled',
    }
    for key in [*overrides, *REMOVED_KEYS, 'model_reasoning_effort']:
        root = re.sub(r'^'+re.escape(key)+r'\s*=.*\n?', '', root, flags=re.M)
    for key, value in overrides.items():
        root += key+' = '+json.dumps(value)+'\n'
    # A provider with our id in the source profile is replaced, never merged.
    tables = drop_tables(tables, 'model_providers.'+PROVIDER_ID)
    provider = ('\n[model_providers.'+PROVIDER_ID+']\nname = "Claude"\nbase_url = "http://127.0.0.1:'+str(int(port))+'/v1"\n'
                'wire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n'
                'request_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 600000\n'
                'supports_standalone_web_search = '+('true' if web_search else 'false')+'\n'
                '\n[model_providers.'+PROVIDER_ID+'.http_headers]\nX-Claude-Bridge-Key = '+json.dumps(token)+'\n')
    return root+'\n'+tables.rstrip()+'\n'+provider


def share_instructions(source, codex, agents_md, share_skills):
    """Optionally give the isolated profile your instructions and skills."""
    dest = codex/'AGENTS.md'
    if agents_md == 'codex' and (source/'AGENTS.md').exists() and not dest.exists():
        dest.symlink_to(source/'AGENTS.md')
    elif agents_md == 'claude':
        claude_md = pathlib.Path.home()/'.claude/CLAUDE.md'
        if claude_md.exists() and not dest.exists():
            shutil.copyfile(claude_md, dest)
    if share_skills and (source/'skills').exists() and not (codex/'skills').exists():
        (codex/'skills').symlink_to(source/'skills', target_is_directory=True)


def main(argv=None):
    runtime = runtime_dir()
    previous = json.loads((runtime/'launch.json').read_text()) if (runtime/'launch.json').exists() else {}
    parser = argparse.ArgumentParser(description='Prepare the isolated ChatGPT profile for '+APP_NAME+'.')
    parser.add_argument('--port', type=int, default=previous.get('port', DEFAULT_PORT), help='Local bridge port (default %(default)s)')
    parser.add_argument('--label', default=previous.get('label', DEFAULT_LABEL), help='LaunchAgent label (default %(default)s)')
    parser.add_argument('--auth', choices=['claude-login', 'api-key'], default=previous.get('auth', 'claude_login').replace('_', '-'),
                        help='claude-login uses your normal claude login; api-key uses ANTHROPIC_API_KEY, given to install.py')
    parser.add_argument('--web-search', action=argparse.BooleanOptionalAction, default=previous.get('web_search', False),
                        help="Relay the app's built-in web search, using the profile's ChatGPT sign-in (off by default)")
    parser.add_argument('--models', default=previous.get('models_file'), help='Custom model catalog (default: claude-models.json in this folder)')
    parser.add_argument('--agents-md', choices=['none', 'codex', 'claude'], default='none',
                        help='Give the profile instructions: link ~/.codex/AGENTS.md, or copy ~/.claude/CLAUDE.md once')
    parser.add_argument('--share-skills', action='store_true', help='Link ~/.codex/skills into the profile')
    parser.add_argument('--app', default=previous.get('app', DEFAULT_APP), help='Path to ChatGPT.app')
    args = parser.parse_args(argv)

    source, codex = source_home(), runtime/'codex'
    models_file = str(pathlib.Path(args.models).expanduser().resolve()) if args.models else None
    models = load_models(models_file)
    for p in [runtime, codex, runtime/'user-data', runtime/'sessions', runtime/'logs']:
        p.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_file = runtime/'token'
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(48))
    token_file.chmod(0o600)

    source_config = (source/'config.toml').read_text() if (source/'config.toml').exists() else ''
    config = build_config(source_config, codex=codex, port=args.port, token=token_file.read_text().strip(),
                          default_model=models['default'], web_search=args.web_search)
    config = config.replace(str(source/'.tmp/bundled-marketplaces/openai-bundled'), str(codex/'.tmp/bundled-marketplaces/openai-bundled'))
    (codex/'config.toml').write_text(config)
    (codex/'config.toml').chmod(0o600)

    # Plugin code is copied; authentication, conversations, browser state and
    # Electron storage stay independent of the normal profile.
    plugins = codex/'plugins'
    if not plugins.exists() and (source/'plugins').exists():
        subprocess.run(['/usr/bin/ditto', str(source/'plugins'), str(plugins)], check=True)
    share_instructions(source, codex, args.agents_md, args.share_skills)
    refresh_capabilities(source, codex, models, args.web_search)

    launch = {**previous, 'runtime': str(runtime), 'node': shutil.which('node'), 'claude': shutil.which('claude') or previous.get('claude'),
              'app': args.app, 'port': args.port, 'label': args.label, 'auth': args.auth.replace('-', '_'),
              'web_search': args.web_search, 'models_file': models_file}
    (runtime/'launch.json').write_text(json.dumps(launch, indent=2))
    (runtime/'launch.json').chmod(0o600)
    print('Prepared the isolated ChatGPT profile in', runtime)
    if not launch['claude']:
        print('Claude Code was not found on PATH. Install it, then run this again.')


if __name__ == '__main__':
    main()
