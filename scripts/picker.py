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
    """Offset of the first table header, skipping lines inside multi-line strings."""
    offset, inside = 0, None
    for line in text.splitlines(keepends=True):
        if inside is None and re.match(r'[ \t]*\[', line):
            return offset
        for quote in re.findall(r'"""|\'\'\'', line):
            if inside is None:
                inside = quote
            elif quote == inside:
                inside = None
        offset += len(line)
    return len(text)


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
    """Remove the marked line and the setting after it, keeping everything else.

    add_setting puts one blank line between the setting and a table that
    follows it, so that line goes too.
    """
    lines = text.split('\n')
    kept, skip, removed = [], False, None
    for i, line in enumerate(lines):
        if line == MARK:
            skip = True
            continue
        if skip and KEY_LINE.match(line) and '/g/' in line and '127.0.0.1' in line:
            skip, removed = False, i
            continue
        skip = False
        if removed == i-1 and line == '' and i+1 < len(lines) and lines[i+1].lstrip().startswith('['):
            continue
        kept.append(line)
    return '\n'.join(kept)


def write_atomic(path, data, mode=None, private=False):
    # A config.toml kept in a dotfiles repository is often a symlink. Writing
    # its target keeps the link.
    path = pathlib.Path(os.path.realpath(path))
    temporary = path.with_name(path.name+'.picker-tmp')
    temporary.unlink(missing_ok=True)
    # Created owner-only, so the content is never readable by others.
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as handle:
        handle.write(data)
    if path.exists():
        shutil.copymode(path, temporary)
    elif mode is not None:
        temporary.chmod(mode)
    # The gateway key in the setting lets anyone who reads it use the
    # owner's Claude login through the bridge.
    if private:
        temporary.chmod(temporary.stat().st_mode & 0o700)
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
        with os.fdopen(os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            handle.write(secrets.token_urlsafe(32))
    key = key_file.read_text().strip()
    original = config_file.read_bytes() if config_file.exists() else b''
    mode = os.stat(os.path.realpath(config_file)).st_mode & 0o777 if config_file.exists() else None
    # A setting left by an earlier copy whose runtime folder is gone points at
    # a key that no longer exists. Replace it, and keep it out of the backup.
    if still_set(original.decode()):
        cleaned = remove_setting(original.decode())
        cleaned = '\n'.join(line for line in cleaned.split('\n') if not (KEY_LINE.match(line) and '/g/' in line and '127.0.0.1' in line))
        original = cleaned.encode()
        print('Replacing the picker setting left by an earlier installation.')
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
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup, n = runtime/'backups'/stamp, 1
    while backup.exists():
        n += 1
        backup = runtime/'backups'/f'{stamp}-{n}'
    backup.mkdir(parents=True, mode=0o700)
    (backup/'config.toml').write_bytes(original)
    (backup/'config.toml').chmod(0o600)
    if cache_file.exists():
        shutil.copy2(cache_file, backup/'models_cache.json')
        (backup/'models_cache.json').chmod(0o600)
    write_atomic(config_file, updated, 0o600, private=True)
    state = {'codex_home': str(codex), 'backup': str(backup), 'config_existed': bool(original) or config_file.exists(),
             'config_sha_before': sha(original), 'config_sha_after': sha(updated), 'config_mode': mode, 'port': port,
             'installed_at': datetime.datetime.now().isoformat(timespec='seconds')}
    write_atomic(state_file, json.dumps(state, indent=2).encode(), 0o600)
    print('Picker mode is on. Changed', config_file, '(one setting, openai_base_url).')
    print('Backup:', backup)
    print('Restart the ChatGPT app, then choose a Claude model in the picker.')


def still_set(text):
    return any('/g/' in line and '127.0.0.1' in line for line in KEY_LINE.findall(text))


def remove_or_explain(config_file, text):
    """Remove the marked setting, or stop with the line to delete by hand."""
    updated = remove_setting(text)
    if still_set(updated):
        lines = [line.strip() for line in KEY_LINE.findall(updated) if '/g/' in line and '127.0.0.1' in line]
        raise SystemExit('Could not find the marked setting in '+str(config_file)+'. GPT will not work until you delete this line from it: '+lines[0])
    write_atomic(config_file, updated.encode())


def uninstall(codex, runtime):
    state_file = runtime/'picker.json'
    if not state_file.exists():
        # The runtime folder was deleted or replaced while the setting stayed,
        # which leaves GPT pointing at a bridge that is gone.
        config_file = codex/'config.toml'
        text = config_file.read_text() if config_file.exists() else ''
        if not (MARK in text or still_set(text)):
            print('Picker mode is not on. Nothing to undo.')
            return
        remove_or_explain(config_file, text)
        cache_file = codex/'models_cache.json'
        if cache_file.exists() and '"claude-' in cache_file.read_text(errors='replace'):
            cache_file.unlink()
        print('Picker mode is off:', config_file, 'no longer points ChatGPT at the bridge.')
        print('Restart the ChatGPT app.')
        return
    state = json.loads(state_file.read_text())
    codex = pathlib.Path(state['codex_home'])
    backup = pathlib.Path(state['backup'])
    config_file, cache_file = codex/'config.toml', codex/'models_cache.json'
    current = config_file.read_bytes() if config_file.exists() else b''
    if sha(current) == state['config_sha_after'] and (backup/'config.toml').exists():
        original = (backup/'config.toml').read_bytes()
        write_atomic(config_file, original)
        how = 'restored byte for byte from the backup'
    else:
        remove_or_explain(config_file, current.decode())
        how = 'removed the openai_base_url setting and kept your later edits'
    if state.get('config_mode') is not None and config_file.exists():
        os.chmod(os.path.realpath(config_file), state['config_mode'])
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
