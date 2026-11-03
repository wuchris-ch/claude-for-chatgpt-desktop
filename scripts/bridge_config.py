"""Names, paths and settings shared by the setup, launch, install and service scripts.

Everything a user can change is stored in launch.json in the runtime directory,
which setup.py writes. CLAUDE_BRIDGE_RUNTIME moves the runtime directory.
"""
import json
import os
import pathlib
import re

PROJECT = 'claude-for-chatgpt-desktop'
APP_NAME = 'Claude for ChatGPT Desktop'
DEFAULT_LABEL = 'io.github.wuchris-ch.' + PROJECT
DEFAULT_PORT = 19480
DEFAULT_APP = '/Applications/ChatGPT.app'
PROVIDER_ID = 'claude_bridge'
ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_MODELS_FILE = ROOT / 'claude-models.json'
AUTH_MODES = ('claude_login', 'api_key')


def runtime_dir():
    value = os.environ.get('CLAUDE_BRIDGE_RUNTIME')
    return pathlib.Path(value) if value else pathlib.Path.home() / 'Library/Application Support' / APP_NAME


def source_home():
    """The normal ChatGPT desktop profile: CODEX_HOME if set, otherwise ~/.codex.

    The separate window runs with CODEX_HOME set to the bridge's own profile, so
    commands started from a terminal inside it would otherwise read that profile.
    """
    value = os.environ.get('CODEX_HOME')
    home = pathlib.Path(value).expanduser() if value else pathlib.Path.home() / '.codex'
    if value and home.resolve() == (runtime_dir() / 'codex').resolve():
        return pathlib.Path.home() / '.codex'
    return home


def load_launch(runtime):
    return json.loads((pathlib.Path(runtime) / 'launch.json').read_text())


def load_models(path=None):
    """Read the model catalog the bridge serves. The Node bridge validates it fully."""
    data = json.loads(pathlib.Path(path or DEFAULT_MODELS_FILE).read_text())
    models = data.get('models') or []
    if not models:
        raise ValueError('The model catalog needs a non-empty "models" list.')
    slugs = [m['slug'] for m in models]
    default = data.get('default') or slugs[0]
    if default not in slugs:
        raise ValueError('Default model ' + default + ' is not in the catalog.')
    return {'default': default, 'models': models}


def _statement_end(text, i):
    """Index just past the newline that ends the statement starting at i."""
    depth, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '\n' and not depth:
            return i+1
        if c == '#':
            j = text.find('\n', i)
            if j < 0:
                return n
            i = j
            continue
        if text.startswith(('"""', "'''"), i):
            quote = text[i:i+3]
            i += 3
            while i < n and not text.startswith(quote, i):
                i += 2 if quote == '"""' and text[i] == '\\' else 1
            if i >= n:
                return n
            # A multi-line string can end with up to two more quotes.
            i += 3
            while i < n and text[i] == quote[0]:
                i += 1
            continue
        if c in '"\'':
            i += 1
            while i < n and text[i] not in (c, '\n'):
                i += 2 if c == '"' and text[i] == '\\' else 1
            if i < n and text[i] == c:
                i += 1
            continue
        if c in '[{':
            depth += 1
        elif c in ']}':
            depth = max(0, depth-1)
        i += 1
    return n


def _key(body):
    key, quote = '', None
    for c in body:
        if quote:
            if c == quote:
                quote = None
            else:
                key += c
        elif c in '"\'':
            quote = c
        elif c == '=':
            break
        else:
            key += c
    return re.sub(r'[ \t]*\.[ \t]*', '.', key.strip())


def statements(text):
    """The top-level lines of a TOML file, as (kind, name, start, end).

    kind is 'table' or 'array' for a [table] or [[array]] header, 'key' for a
    key = value line, or 'comment'. start is where the line starts and end is
    just past its newline, so a value that spans lines, such as a multi-line
    string or array, is one statement. Lines inside those values are never
    statements, whatever they look like.
    """
    out, i, n = [], 0, len(text)
    while i < n:
        start = i
        while i < n and text[i] in ' \t\r':
            i += 1
        if i >= n:
            break
        if text[i] == '\n':
            i += 1
            continue
        if text[i] == '#':
            j = text.find('\n', i)
            end = n if j < 0 else j+1
            out.append(('comment', text[i:end].rstrip('\r\n'), start, end))
        else:
            end = _statement_end(text, i)
            body = text[i:end]
            if body.startswith('['):
                array = body.startswith('[[')
                close = re.match(r'\[\[?(.*?)\]\]?[ \t]*(#.*)?\r?\n?$', body, re.S)
                out.append(('array' if array else 'table', close.group(1).strip() if close else body.strip(), start, end))
            else:
                out.append(('key', _key(body), start, end))
        i = end
    return out


def root_end(text):
    """Offset of the line with the first table header in a TOML file."""
    return next((start for kind, _, start, _ in statements(text) if kind in ('table', 'array')), len(text))


def drop_statements(text, drop):
    """text without the top-level statements for which drop(kind, name) is true."""
    kept, pos = [], 0
    for kind, name, start, end in statements(text):
        if drop(kind, name):
            kept.append(text[pos:start])
            pos = end
    return ''.join(kept)+text[pos:]


def string_value(text, statement):
    """The value of a key = "string" statement, or None for any other value."""
    match = re.fullmatch(r'[^=]*=[ \t]*(?:"((?:[^"\\\n]|\\.)*)"|\'([^\'\n]*)\')[ \t]*(?:#[^\n]*)?\r?\n?', text[statement[2]:statement[3]].lstrip(' \t'))
    if not match:
        return None
    if match.group(2) is not None:
        return match.group(2)
    try:
        return json.loads('"'+match.group(1)+'"')
    except ValueError:
        return None

def service_env(runtime, config):
    """Environment for the bridge process, derived from launch.json."""
    env = {
        'CLAUDE_BRIDGE_RUNTIME': str(runtime),
        'CLAUDE_BRIDGE_PORT': str(config.get('port', DEFAULT_PORT)),
        'CLAUDE_BRIDGE_AUTH': config.get('auth', 'claude_login'),
        'CLAUDE_BRIDGE_WEB_SEARCH': '1' if config.get('web_search') else '0',
    }
    if config.get('models_file'):
        env['CLAUDE_BRIDGE_MODELS'] = config['models_file']
    return env
