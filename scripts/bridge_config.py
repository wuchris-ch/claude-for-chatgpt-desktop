"""Names, paths and settings shared by the setup, launch, install and service scripts.

Everything a user can change is stored in launch.json in the runtime directory,
which setup.py writes. CLAUDE_BRIDGE_RUNTIME moves the runtime directory.
"""
import json
import os
import pathlib

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
