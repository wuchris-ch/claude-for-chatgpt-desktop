import pathlib
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from release import switch_release


class ReleaseTests(unittest.TestCase):
    def test_failed_activation_restores_code_config_and_service(self):
        for failure in ['bootstrap failed', 'health check failed']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                root=pathlib.Path(temp)
                app, stage, config, agent=[root/name for name in ['app','app-staging','launch.json','service.plist']]
                for directory, value in [(app,'old'),(stage,'new')]:
                    directory.mkdir();(directory/'version').write_text(value)
                config.write_bytes(b'old config');agent.write_bytes(b'old plist')
                events=[]
                def activate():
                    self.assertEqual((app/'version').read_text(),'new')
                    config.write_bytes(b'new config');agent.write_bytes(b'new plist')
                    raise RuntimeError(failure)
                def restart():
                    self.assertEqual((app/'version').read_text(),'old')
                    self.assertEqual(config.read_bytes(),b'old config')
                    self.assertEqual(agent.read_bytes(),b'old plist')
                    events.append('restart')
                with self.assertRaisesRegex(RuntimeError,'Previous installation restored'):
                    switch_release(app,stage,config,agent,activate,lambda:events.append('stop'),restart)
                self.assertEqual(events,['stop','restart'])
                self.assertEqual((stage/'version').read_text(),'new')

    def test_a_failure_before_the_switch_restarts_the_stopped_service(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);app=root/'app';stage=root/'app-staging';previous=root/'app-previous'
            for d in [app,stage,previous]:d.mkdir()
            (app/'version').write_text('old');(stage/'version').write_text('new')
            events=[]
            original=shutil.rmtree
            def failing(path,*a,**k):
                if pathlib.Path(path)==previous:raise PermissionError('locked')
                return original(path,*a,**k)
            shutil.rmtree=failing
            try:
                with self.assertRaisesRegex(RuntimeError,'previous installation is running again'):
                    switch_release(app,stage,root/'config',root/'agent',lambda:events.append('activate'),lambda:events.append('stop'),lambda:events.append('restart'))
            finally:
                shutil.rmtree=original
            self.assertEqual(events,['restart'])
            self.assertEqual((app/'version').read_text(),'old')

    def test_success_keeps_previous_code_for_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);app=root/'app';stage=root/'app-staging'
            app.mkdir();stage.mkdir();(app/'old').touch();(stage/'new').touch()
            switch_release(app,stage,root/'config',root/'agent',lambda:None,
                           lambda:self.fail('unexpected stop'),lambda:self.fail('unexpected restart'))
            self.assertTrue((app/'new').exists())
            self.assertTrue((root/'app-previous/old').exists())
