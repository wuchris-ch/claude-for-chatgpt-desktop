#!/usr/bin/env python3
"""Show the Claude models in your normal ChatGPT window's model picker, next to GPT.

install   Backs up config.toml and the model list cache of your ChatGPT profile,
          then adds one setting, openai_base_url, so the app's OpenAI traffic
          goes through the bridge. GPT requests are relayed to OpenAI unchanged;
          requests for a Claude model are answered by Claude Code.
uninstall Removes that setting (restoring the backup byte for byte when nothing
          else changed) and restores the model list cache.
status    Shows whether picker mode is on and whether the bridge serves it.

Restart the ChatGPT app after install or uninstall.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
from bridge_config import DEFAULT_PORT, PROJECT, load_launch, runtime_dir, source_home

MARK = '# Added by '+PROJECT+'. Remove with: python3 scripts/picker.py uninstall'
KEY_LINE = re.compile(r'^[ \t]*openai_base_url[ \t]*=.*$', re.M)
PROVIDER_LINE = re.compile(r'^[ \t]*model_provider[ \t]*=[ \t]*"?([^"\s#]+)', re.M)


def gateway_url(port, key):
    return f'http://127.0.0.1:{int(port)}/g/{key}/backend-api/codex'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def root_end(text):
    first = re.search(r'^[ \t]*\[', text, re.M)
    return first.start() if first else len(text)


def add_setting(text, url):
    """Insert the marked openai_base_url line at the end of the root table."""
    end = root_end(text)
    if KEY_LINE.search(text[:end]):
        raise SystemExit('Your config.toml already sets openai_base_url. Picker mode would replace it, so nothing was changed.')
    provider = PROVIDER_LINE.search(text[:end])
    if provider and provider.group(1) != 'openai':
        raise SystemExit('This profile uses the model provider '+provider.group(1)+'. Picker mode works on a profile that uses '
                         'ChatGPT\'s own OpenAI connection, usually ~/.codex. Nothing was changed.')
    root = text[:end]
    if root and not root.endswith('\n'):
        root += '\n'
    return root+MARK+'\nopenai_base_url = '+json.dumps(url)+'\n'+('\n' if text[end:] else '')+text[end:]


def remove_setting(text):
    """Remove the marked line and the setting after it, keeping everything else."""
    lines = text.split('\n')
    kept, skip = [], False
    for line in lines:
        if line == MARK:
            skip = True
            continue
        if skip and KEY_LINE.match(line) and '/g/' in line and '127.0.0.1' in line:
            skip = False
            continue
        skip = False
        kept.append(line)
    return '\n'.join(kept)


def write_atomic(path, data, mode=None):
    temporary = path.with_name(path.name+'.picker-tmp')
    temporary.write_bytes(data)
    if path.exists():
        shutil.copymode(path, temporary)
    elif mode is not None:
        temporary.chmod(mode)
    temporary.replace(path)


def bridge_health(runtime, port):
    try:
        token = (runtime/'token').read_text().strip()
        request = urllib.request.Request(f'http://127.0.0.1:{int(port)}/health', headers={'Authorization': 'Bearer '+token})
        with urllib.request.urlopen(request, timeout=2) as response:
            return json.load(response)
    except Exception:
        return None


def restart_service(config):
    label = config.get('launch_agent')
    if not label:
        raise SystemExit('The bridge service is not installed. Run python3 scripts/install.py first.')
    subprocess.run(['launchctl', 'kickstart', '-k', 'gui/'+str(os.getuid())+'/'+label], check=True)


def install(codex, runtime, service=True):
    config_file, cache_file, state_file = codex/'config.toml', codex/'models_cache.json', runtime/'picker.json'
    print('ChatGPT profile:', codex)
    if state_file.exists():
        print('Picker mode is already on. Run uninstall first to reinstall.')
        return
    launch = load_launch(runtime)
    port = launch.get('port', DEFAULT_PORT)
    key_file = runtime/'gateway-key'
    if not key_file.exists():
        key_file.write_text(secrets.token_urlsafe(32))
        key_file.chmod(0o600)
    key = key_file.read_text().strip()
    original = config_file.read_bytes() if config_file.exists() else b''
    updated = add_setting(original.decode(), gateway_url(port, key)).encode()
    # The bridge must serve picker mode before the app is pointed at it.
    if service:
        restart_service(launch)
        for _ in range(100):
            if (bridge_health(runtime, port) or {}).get('picker'):
                break
            time.sleep(.1)
        else:
            raise SystemExit('The bridge did not start in picker mode. Nothing in your ChatGPT profile was changed.')
    backup = runtime/'backups'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup.mkdir(parents=True, mode=0o700)
    (backup/'config.toml').write_bytes(original)
    (backup/'config.toml').chmod(0o600)
    if cache_file.exists():
        shutil.copy2(cache_file, backup/'models_cache.json')
        (backup/'models_cache.json').chmod(0o600)
    write_atomic(config_file, updated, 0o600)
    state = {'codex_home': str(codex), 'backup': str(backup), 'config_existed': bool(original) or config_file.exists(),
             'config_sha_before': sha(original), 'config_sha_after': sha(updated), 'port': port,
             'installed_at': datetime.datetime.now().isoformat(timespec='seconds')}
    write_atomic(state_file, json.dumps(state, indent=2).encode(), 0o600)
    print('Picker mode is on. Changed', config_file, '(one setting, openai_base_url).')
    print('Backup:', backup)
    print('Restart the ChatGPT app, then choose a Claude model in the picker.')


def uninstall(codex, runtime):
    state_file = runtime/'picker.json'
    if not state_file.exists():
        print('Picker mode is not on. Nothing to undo.')
        return
    state = json.loads(state_file.read_text())
    codex = pathlib.Path(state['codex_home'])
    backup = pathlib.Path(state['backup'])
    config_file, cache_file = codex/'config.toml', codex/'models_cache.json'
    current = config_file.read_bytes() if config_file.exists() else b''
    if sha(current) == state['config_sha_after']:
        original = (backup/'config.toml').read_bytes()
        write_atomic(config_file, original)
        how = 'restored byte for byte from the backup'
    else:
        write_atomic(config_file, remove_setting(current.decode()).encode())
        how = 'removed the openai_base_url setting and kept your later edits'
    if (backup/'models_cache.json').exists():
        shutil.copy2(backup/'models_cache.json', cache_file)
    elif cache_file.exists():
        cache_file.unlink()
    state_file.unlink()
    (runtime/'gateway-key').unlink(missing_ok=True)
    print('Picker mode is off:', config_file, how+'.')
    print('Restart the ChatGPT app. The backup stays in', backup)


def status(codex, runtime):
    state_file = runtime/'picker.json'
    config_file = codex/'config.toml'
    text = config_file.read_text() if config_file.exists() else ''
    present = MARK in text
    print('Picker mode:', 'on' if state_file.exists() else 'off')
    print('Setting in', config_file, ':', 'present' if present else 'absent')
    if (runtime/'launch.json').exists():
        health = bridge_health(runtime, load_launch(runtime).get('port', DEFAULT_PORT)) or {}
        print('Bridge:', 'serving picker mode' if health.get('picker') else 'running' if health else 'not running')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['install', 'uninstall', 'status'])
    parser.add_argument('--codex-home', default=str(source_home()), help='ChatGPT profile to change (default %(default)s)')
    parser.add_argument('--no-service', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    codex, runtime = pathlib.Path(args.codex_home).expanduser(), runtime_dir()
    if args.command == 'install':
        install(codex, runtime, service=not args.no_service)
    elif args.command == 'uninstall':
        uninstall(codex, runtime)
    else:
        status(codex, runtime)


if __name__ == '__main__':
    main()
