"""Picker mode changes one setting in the normal profile and undoes it exactly."""
import contextlib
import hashlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import picker

CONFIG = b'''model = "gpt-6-astra"
model_reasoning_effort = "high"
# a comment the user wrote

[features]
goals = true

[projects."/tmp/x"]
trust_level = "trusted"
'''


class PickerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bridge-picker-test-')
        self.addCleanup(self.temporary.cleanup)
        root = pathlib.Path(self.temporary.name)
        self.codex, self.runtime = root/'codex', root/'runtime'
        self.codex.mkdir()
        self.runtime.mkdir()
        (self.codex/'config.toml').write_bytes(CONFIG)
        (self.codex/'config.toml').chmod(0o644)
        (self.codex/'models_cache.json').write_text('{"models":[{"slug":"gpt-6-astra"}]}')
        (self.runtime/'launch.json').write_text(json.dumps({'port': 19490}))
        (self.runtime/'token').write_text('fixture')
        previous = os.environ.get('CLAUDE_BRIDGE_RUNTIME')
        os.environ['CLAUDE_BRIDGE_RUNTIME'] = str(self.runtime)
        self.addCleanup(lambda: os.environ.pop('CLAUDE_BRIDGE_RUNTIME') if previous is None else os.environ.__setitem__('CLAUDE_BRIDGE_RUNTIME', previous))

    def run_picker(self, *args):
        with contextlib.redirect_stdout(io.StringIO()):
            picker.main([*args, '--codex-home', str(self.codex), '--no-service'])

    def test_install_adds_one_marked_setting_and_backs_up_both_files(self):
        self.run_picker('install')
        text = (self.codex/'config.toml').read_text()
        key = (self.runtime/'gateway-key').read_text()
        self.assertIn(picker.MARK+'\nopenai_base_url = "http://127.0.0.1:19490/g/'+key+'/backend-api/codex"\n\n[features]', text)
        self.assertEqual(text.replace(picker.MARK+'\n', '').replace('openai_base_url = "http://127.0.0.1:19490/g/'+key+'/backend-api/codex"\n\n', ''), CONFIG.decode())
        self.assertEqual(text.count('openai_base_url'), 1)
        state = json.loads((self.runtime/'picker.json').read_text())
        backup = pathlib.Path(state['backup'])
        self.assertEqual((backup/'config.toml').read_bytes(), CONFIG)
        self.assertEqual((backup/'models_cache.json').read_text(), '{"models":[{"slug":"gpt-6-astra"}]}')
        self.assertEqual((self.codex/'config.toml').stat().st_mode & 0o777, 0o644)
        self.assertEqual((self.runtime/'gateway-key').stat().st_mode & 0o777, 0o600)
        self.run_picker('install')
        self.assertEqual((self.codex/'config.toml').read_text(), text)

    def test_uninstall_restores_the_original_bytes_and_model_cache(self):
        self.run_picker('install')
        (self.codex/'models_cache.json').write_text('{"models":[{"slug":"gpt-6-astra"},{"slug":"claude-opus"}]}')
        self.run_picker('uninstall')
        self.assertEqual((self.codex/'config.toml').read_bytes(), CONFIG)
        self.assertEqual((self.codex/'models_cache.json').read_text(), '{"models":[{"slug":"gpt-6-astra"}]}')
        self.assertFalse((self.runtime/'picker.json').exists())
        self.assertFalse((self.runtime/'gateway-key').exists())
        self.run_picker('uninstall')
        self.assertEqual((self.codex/'config.toml').read_bytes(), CONFIG)

    def test_uninstall_keeps_edits_made_after_install(self):
        self.run_picker('install')
        config = self.codex/'config.toml'
        config.write_text(config.read_text().replace('model = "gpt-6-astra"', 'model = "gpt-6.1-sol"') + '\n[tui]\nx = 1\n')
        self.run_picker('uninstall')
        result = config.read_text()
        self.assertNotIn('openai_base_url', result)
        self.assertNotIn(picker.MARK, result)
        self.assertIn('model = "gpt-6.1-sol"', result)
        self.assertIn('[tui]\nx = 1', result)
        self.assertIn('# a comment the user wrote', result)

    def test_an_existing_openai_base_url_is_left_alone(self):
        (self.codex/'config.toml').write_bytes(b'openai_base_url = "https://proxy.example/v1"\n' + CONFIG)
        with self.assertRaises(SystemExit) as raised:
            self.run_picker('install')
        self.assertIn('already sets openai_base_url', str(raised.exception))
        self.assertEqual((self.codex/'config.toml').read_bytes(), b'openai_base_url = "https://proxy.example/v1"\n' + CONFIG)
        self.assertFalse((self.runtime/'picker.json').exists())

    def test_a_setting_inside_a_table_does_not_count_and_a_profile_without_config_works(self):
        text = picker.add_setting('[profiles.x]\nopenai_base_url = "https://other"\n', 'http://127.0.0.1:1/g/k/backend-api/codex')
        self.assertTrue(text.startswith(picker.MARK+'\nopenai_base_url = "http://127.0.0.1:1/g/k/backend-api/codex"\n\n[profiles.x]'))
        (self.codex/'config.toml').unlink()
        (self.codex/'models_cache.json').unlink()
        self.run_picker('install')
        self.assertIn('openai_base_url', (self.codex/'config.toml').read_text())
        self.run_picker('uninstall')
        self.assertEqual((self.codex/'config.toml').read_bytes(), b'')


if __name__ == '__main__':
    unittest.main()
