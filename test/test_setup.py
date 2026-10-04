"""The isolated profile's settings, optional instruction sharing and service environment."""
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from setup import build_config, drop_tables, share_instructions
from bridge_config import DEFAULT_LABEL, DEFAULT_PORT, service_env, load_models, source_home

SOURCE = '''model = "gpt-6"
model_provider = "openai"
model_context_window = 272000
model_reasoning_effort = "high"
approval_policy = "never"

[features]
memories = false

[model_providers.claude_bridge]
name = "old"
base_url = "http://127.0.0.1:1/v1"

[model_providers.claude_bridge.http_headers]
X-Claude-Bridge-Key = "old-key"

[mcp_servers.fixture]
command = "fixture"
args = ["a", "[b]"]
'''


class SetupConfigTests(unittest.TestCase):
    def config(self, **options):
        values = dict(codex=pathlib.Path('/tmp/isolated codex'), port=19490, token='fixture-token', default_model='claude-opus', web_search=False)
        values.update(options)
        return build_config(SOURCE, **values)

    def test_profile_points_at_the_bridge_and_keeps_other_settings(self):
        config = self.config()
        root = config[:config.index('[')]
        for line in ['model = "claude-opus"', 'model_provider = "claude_bridge"', 'review_model = "claude-opus"',
                     'model_catalog_json = "/tmp/isolated codex/models.json"', 'web_search = "disabled"', 'approval_policy = "never"']:
            self.assertIn(line, root)
        # Context windows are per model in the catalog; effort defaults per model.
        for removed in ['model_context_window', 'model_reasoning_effort', 'gpt-6', '"openai"']:
            self.assertNotIn(removed, root)
        self.assertIn('[features]\nmemories = false', config)
        self.assertIn('args = ["a", "[b]"]', config)
        self.assertEqual(config.count('[model_providers.claude_bridge]'), 1)
        self.assertNotIn('old-key', config)
        self.assertIn('base_url = "http://127.0.0.1:19490/v1"', config)
        self.assertIn('X-Claude-Bridge-Key = "fixture-token"', config)
        self.assertIn('supports_standalone_web_search = false', config)

    def test_web_search_opt_in(self):
        config = self.config(web_search=True)
        self.assertIn('web_search = "live"', config)
        self.assertIn('supports_standalone_web_search = true', config)

    def test_drop_tables_removes_only_the_named_table_and_subtables(self):
        text = 'a = 1\n[x]\nb = 2\n[x.y]\nc = 3\n[xy]\nd = 4\n[[z]]\ne = 5\n'
        self.assertEqual(drop_tables(text, 'x'), 'a = 1\n[xy]\nd = 4\n[[z]]\ne = 5\n')


class ShareInstructionsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bridge-setup-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.source, self.codex = self.root/'source', self.root/'codex'
        (self.source/'skills').mkdir(parents=True)
        self.codex.mkdir()
        (self.source/'AGENTS.md').write_text('codex rules')
        (self.root/'.claude').mkdir()
        (self.root/'.claude/CLAUDE.md').write_text('claude rules')
        self.home = os.environ.get('HOME')
        os.environ['HOME'] = str(self.root)
        self.addCleanup(lambda: os.environ.__setitem__('HOME', self.home))

    def test_nothing_is_shared_by_default(self):
        share_instructions(self.source, self.codex, 'none', False)
        self.assertEqual(list(self.codex.iterdir()), [])

    def test_claude_md_is_copied_once_and_never_overwritten(self):
        share_instructions(self.source, self.codex, 'claude', False)
        agents = self.codex/'AGENTS.md'
        self.assertFalse(agents.is_symlink())
        self.assertEqual(agents.read_text(), 'claude rules')
        agents.write_text('edited for this profile')
        share_instructions(self.source, self.codex, 'claude', False)
        self.assertEqual(agents.read_text(), 'edited for this profile')

    def test_codex_instructions_and_skills_can_be_linked(self):
        share_instructions(self.source, self.codex, 'codex', True)
        self.assertEqual((self.codex/'AGENTS.md').resolve(), (self.source/'AGENTS.md').resolve())
        self.assertTrue((self.codex/'skills').is_symlink())


class ServiceEnvironmentTests(unittest.TestCase):
    def test_launch_settings_reach_the_bridge(self):
        env = service_env('/rt', {'port': 19490, 'auth': 'api_key', 'web_search': True, 'models_file': '/m.json'})
        self.assertEqual(env, {'CLAUDE_BRIDGE_RUNTIME': '/rt', 'CLAUDE_BRIDGE_PORT': '19490', 'CLAUDE_BRIDGE_AUTH': 'api_key',
                               'CLAUDE_BRIDGE_WEB_SEARCH': '1', 'CLAUDE_BRIDGE_MODELS': '/m.json'})
        self.assertEqual(service_env('/rt', {}), {'CLAUDE_BRIDGE_RUNTIME': '/rt', 'CLAUDE_BRIDGE_PORT': str(DEFAULT_PORT),
                                                  'CLAUDE_BRIDGE_AUTH': 'claude_login', 'CLAUDE_BRIDGE_WEB_SEARCH': '0'})

    def test_defaults_are_generic(self):
        self.assertEqual(DEFAULT_LABEL, 'io.github.wuchris-ch.claude-for-chatgpt-desktop')
        self.assertEqual(load_models()['default'], 'claude-opus')

    def test_the_bridge_profile_is_never_the_source_profile(self):
        saved = {k: os.environ.get(k) for k in ('CODEX_HOME', 'CLAUDE_BRIDGE_RUNTIME')}
        def restore():
            for k, v in saved.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        self.addCleanup(restore)
        os.environ['CLAUDE_BRIDGE_RUNTIME'] = '/tmp/bridge-runtime'
        os.environ['CODEX_HOME'] = '/tmp/bridge-runtime/codex'
        self.assertEqual(source_home(), pathlib.Path.home()/'.codex')
        os.environ['CODEX_HOME'] = '/tmp/other-profile'
        self.assertEqual(source_home(), pathlib.Path('/tmp/other-profile'))
        os.environ.pop('CODEX_HOME')
        self.assertEqual(source_home(), pathlib.Path.home()/'.codex')


if __name__ == '__main__':
    unittest.main()
