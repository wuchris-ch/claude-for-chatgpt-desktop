"""The uninstall path install.sh takes when the runtime folder is gone.

Each test runs install.sh in a scratch home with launchctl replaced, so a
service on the machine running the tests is never touched.
"""
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
LABEL = 'io.github.wuchris-ch.claude-for-chatgpt-desktop'


@unittest.skipUnless(sys.platform == 'darwin', 'install.sh runs on macOS only')
class FallbackUninstall(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix='claude-install-sh-'))
        self.addCleanup(shutil.rmtree, self.dir)
        self.home = self.dir/'home'
        self.agents = self.home/'Library/LaunchAgents'
        self.agents.mkdir(parents=True)
        self.codex = self.dir/'codex'
        self.codex.mkdir()
        self.runtime = self.dir/'runtime'
        # Run a lone copy of the script, as curl | bash does, so it finds no scripts.
        self.script = self.dir/'bin/install.sh'
        self.script.parent.mkdir()
        shutil.copy(ROOT/'install.sh', self.script)
        stubs = self.dir/'stubs'
        stubs.mkdir()
        self.calls = self.dir/'launchctl.log'
        (stubs/'launchctl').write_text(f'#!/bin/sh\necho "$@" >> "{self.calls}"\n')
        (stubs/'launchctl').chmod(0o755)
        self.env = {**os.environ, 'HOME': str(self.home), 'CODEX_HOME': str(self.codex),
                    'CLAUDE_BRIDGE_RUNTIME': str(self.runtime), 'PATH': f'{stubs}:{os.environ["PATH"]}'}

    def service(self, runtime):
        plist = self.agents/(LABEL+'.plist')
        plist.write_bytes(plistlib.dumps({'Label': LABEL, 'EnvironmentVariables': {'CLAUDE_BRIDGE_RUNTIME': str(runtime)}}))
        return plist

    def uninstall(self):
        return subprocess.run(['bash', str(self.script), '--uninstall'], env=self.env,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True)

    def launchctl(self):
        return self.calls.read_text() if self.calls.exists() else ''

    def test_the_service_for_this_runtime_folder_is_removed(self):
        plist = self.service(self.runtime)
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(plist.exists())
        self.assertIn('bootout', self.launchctl())
        self.assertIn(LABEL, self.launchctl())

    def test_a_service_for_another_runtime_folder_keeps_running(self):
        plist = self.service(self.dir/'elsewhere')
        result = self.uninstall()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(plist.exists())
        self.assertEqual(self.launchctl(), '')
        self.assertIn('Left the background service in place', result.stdout)

    def test_the_picker_setting_is_removed_and_the_rest_kept(self):
        config = self.codex/'config.toml'
        original = 'model = "gpt-5.5"\r\napproval_policy = "never"\r\n\r\n[features]\r\nx = true\r\n'
        config.write_bytes(('# Added by claude-for-chatgpt-desktop: Claude in the model picker\r\n'
                            'openai_base_url = "http://127.0.0.1:19480/g/abc/backend-api/codex"\r\n'
                            + original).encode())
        cache = self.codex/'models_cache.json'
        cache.write_text('{"models":[{"slug":"claude-opus-5-5"}]}')
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config.read_bytes().decode(), original)
        self.assertFalse(cache.exists())
        self.assertEqual(self.launchctl(), '')

    def test_a_claude_default_model_goes_with_the_setting(self):
        config = self.codex/'config.toml'
        config.write_text('model = "claude-opus-5-5"\n# Added by claude-for-chatgpt-desktop: x\n'
                          'openai_base_url = "http://127.0.0.1:19480/g/abc/backend-api/codex"\n\n[x]\nmodel = "claude-opus-5-5"\n')
        result = self.uninstall()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(config.read_text(), '[x]\nmodel = "claude-opus-5-5"\n')


if __name__ == '__main__':
    unittest.main()
