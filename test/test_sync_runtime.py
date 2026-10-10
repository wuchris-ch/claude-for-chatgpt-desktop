"""Regression coverage for copying plugins between independent desktop homes."""
import json
import pathlib
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from sync_runtime import refresh_capabilities, enable_standalone_search, set_standalone_search, model_catalog


class PluginIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bridge-plugin-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root/'home/.codex'
        self.codex = self.root/'Claude for ChatGPT Desktop/codex'
        self.source.mkdir(parents=True)
        self.codex.mkdir(parents=True)
        template={'tool_mode':'code_mode_only','slug':'gpt-fixture','model_messages':{'instructions_template':'You are Codex, a coding agent.\nBe helpful.'}}
        (self.source/'models_cache.json').write_text(json.dumps({'models':[{'tool_mode':None},template]}))
        (self.codex/'config.toml').write_text('model_reasoning_effort = "medium"\n')

    def package(self, name='unified-computer-use', version='99.0.1', descriptor=None):
        package = self.source/'plugins/cache/openai-bundled'/name/version
        (package/'.codex-plugin').mkdir(parents=True)
        (package/'.codex-plugin/plugin.json').write_text(json.dumps({'name':name,'version':version}))
        root = str(self.source)
        descriptor = descriptor or {'mcpServers':{'cua_repl':{
            'command':root+'/plugins/.plugin-appserver/codex',
            'cwd':str(package),
            'args':['--config', root+'/browser/config.toml', 'file://'+root+'/browser/config.toml'],
            'enabled':True,
            'env':{
                'CODEX_HOME':root,
                'NODE_REPL_TRUSTED_CODE_PATHS':root+':/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules',
                'SKY_CUA_SERVICE_PATH':root+'/computer-use/Codex Computer Use.app',
                'NESTED_JSON':json.dumps({'script':root+'/helper.mjs'}),
                'HOME_ALIASES':['~/.codex/a', '$HOME/.codex/b', '${HOME}/.codex/c'],
                'UNRELATED':root+'-backup/helper',
            },
        }}}
        (package/'.mcp.json').write_text(json.dumps(descriptor,indent=2)+'\n')
        return package

    def destination(self, package):
        return self.codex/package.relative_to(self.source)

    def test_new_computer_use_version_is_rebased_before_publish(self):
        package = self.package()
        original = (package/'.mcp.json').read_bytes()
        result = refresh_capabilities(self.source,self.codex)
        config = json.loads((self.destination(package)/'.mcp.json').read_text())['mcpServers']['cua_repl']
        root = str(self.codex)
        self.assertEqual(config['command'],root+'/plugins/.plugin-appserver/codex')
        self.assertEqual(config['cwd'],str(self.destination(package)))
        self.assertEqual(config['args'],['--config',root+'/browser/config.toml',self.codex.as_uri()+'/browser/config.toml'])
        self.assertEqual(config['env']['CODEX_HOME'],root)
        self.assertEqual(config['env']['NODE_REPL_TRUSTED_CODE_PATHS'],root+':/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules')
        self.assertEqual(config['env']['SKY_CUA_SERVICE_PATH'],root+'/computer-use/Codex Computer Use.app')
        self.assertEqual(json.loads(config['env']['NESTED_JSON'])['script'],root+'/helper.mjs')
        self.assertEqual(config['env']['HOME_ALIASES'],[root+'/a',root+'/b',root+'/c'])
        self.assertEqual(config['env']['UNRELATED'],str(self.source)+'-backup/helper')
        self.assertTrue(config['enabled'])
        self.assertEqual(result['mcp_descriptors_rewritten'],1)
        self.assertEqual((package/'.mcp.json').read_bytes(),original)
        self.assertTrue((self.codex/'config.toml').read_text().startswith('model_reasoning_effort = "medium"\n'))
        self.assertIn('web_search = "disabled"',(self.codex/'config.toml').read_text())
        model = json.loads((self.codex/'models.json').read_text())['models'][0]
        self.assertEqual(model['slug'],'claude-fable')
        self.assertTrue(model['supports_search_tool'])
        self.assertEqual(refresh_capabilities(self.source,self.codex)['mcp_descriptors_rewritten'],0)

    def test_app_tools_and_existing_copies_are_repaired(self):
        package = self.package('codex-app-tools')
        dest = self.destination(package)
        shutil.copytree(package,dest)
        result = refresh_capabilities(self.source,self.codex)
        self.assertEqual(result['plugins_added'],[])
        self.assertEqual(result['mcp_descriptors_rewritten'],1)
        self.assertEqual(json.loads((dest/'.mcp.json').read_text())['mcpServers']['cua_repl']['cwd'],str(dest))

    def test_isolated_only_version_is_repaired(self):
        package = self.package()
        dest = self.destination(package)
        shutil.copytree(package,dest)
        shutil.rmtree(package)
        result = refresh_capabilities(self.source,self.codex)
        self.assertEqual(result['mcp_descriptors_rewritten'],1)
        self.assertEqual(json.loads((dest/'.mcp.json').read_text())['mcpServers']['cua_repl']['env']['CODEX_HOME'],str(self.codex))

    def test_unrewritable_source_reference_blocks_publish(self):
        # Unknown descriptor keys are not changed speculatively. They must cause
        # a visible failure rather than allow a source-home path into the cache.
        package = self.package(descriptor={'mcpServers':{str(self.source)+'/unexpected-key':{}}})
        with self.assertRaisesRegex(RuntimeError,'still references the original Codex home'):
            refresh_capabilities(self.source,self.codex)
        self.assertFalse(self.destination(package).exists())
        self.assertEqual(list((self.codex/'plugins/.bridge-sync-staging').iterdir()),[])

    def test_symlinked_descriptor_cannot_write_into_main_instance(self):
        package = self.package()
        file = package/'.mcp.json'
        external = self.root/'external-mcp.json'
        file.rename(external)
        before = external.read_bytes()
        file.symlink_to(external)
        with self.assertRaisesRegex(RuntimeError,'symlinked MCP descriptor'):
            refresh_capabilities(self.source,self.codex)
        self.assertFalse(self.destination(package).exists())
        self.assertEqual(external.read_bytes(),before)

    def test_search_settings_are_idempotent_and_preserve_other_preferences(self):
        config=self.codex/'config.toml'
        config.write_text('model_reasoning_effort = "low"\nweb_search = "disabled"\n\n[features]\nstandalone_web_search = false\nmemories = false\n\n[model_providers.claude_bridge]\nname = "Claude"\nsupports_standalone_web_search = false\n\n[model_providers.claude_bridge.http_headers]\nX-Claude-Bridge-Key = "fixture-key"\n')
        config.chmod(0o600)
        self.assertTrue(enable_standalone_search(self.codex))
        result=config.read_text()
        for expected in ['web_search = "live"','standalone_web_search = true','supports_standalone_web_search = true','model_reasoning_effort = "low"','memories = false','X-Claude-Bridge-Key = "fixture-key"']:
            self.assertIn(expected,result)
        self.assertEqual(result.count('[features]'),1)
        self.assertEqual(result.count('[model_providers.claude_bridge]'),1)
        self.assertFalse(enable_standalone_search(self.codex))
        self.assertEqual(config.stat().st_mode&0o777,0o600)

    def test_search_is_opt_in_and_can_be_turned_off_again(self):
        config=self.codex/'config.toml'
        refresh_capabilities(self.source,self.codex,web_search=True)
        self.assertIn('standalone_web_search = true',config.read_text())
        refresh_capabilities(self.source,self.codex)
        result=config.read_text()
        for expected in ['web_search = "disabled"','standalone_web_search = false','supports_standalone_web_search = false','model_reasoning_effort = "medium"']:
            self.assertIn(expected,result)
        self.assertFalse(set_standalone_search(self.codex,False))

    def test_catalog_lists_each_claude_model_with_its_own_levels_and_window(self):
        refresh_capabilities(self.source,self.codex)
        models={m['slug']:m for m in json.loads((self.codex/'models.json').read_text())['models']}
        self.assertEqual(list(models),['claude-fable','claude-opus','claude-sonnet','claude-haiku'])
        fable,opus,sonnet,haiku=models.values()
        self.assertEqual([x['effort'] for x in fable['supported_reasoning_levels']],['low','medium','high','xhigh','max'])
        self.assertEqual([x['effort'] for x in opus['supported_reasoning_levels']],['low','medium','high','xhigh','max'])
        self.assertEqual((fable['default_reasoning_level'],opus['default_reasoning_level'],sonnet['default_reasoning_level']),('high','medium','medium'))
        self.assertEqual([x['effort'] for x in haiku['supported_reasoning_levels']],['low','medium','high','xhigh','max'])
        self.assertEqual(haiku['default_reasoning_level'],'medium')
        self.assertEqual([(m['context_window'],m['auto_compact_token_limit']) for m in models.values()],[(1000000,800000)]*4)
        self.assertEqual([m['priority'] for m in models.values()],[1,2,3,4])
        self.assertTrue(haiku['model_messages']['instructions_template'].startswith('You are Claude Haiku 5.5, running as the main assistant in ChatGPT Desktop.'))
        self.assertTrue(haiku['model_messages']['instructions_template'].endswith('\nBe helpful.'))
        self.assertEqual([m['display_name'] for m in models.values()],['Claude Fable 5.1','Claude Opus 5.5','Claude Sonnet 5.5','Claude Haiku 5.5'])

    def test_a_model_without_efforts_gets_one_fixed_level(self):
        template={'slug':'gpt-fixture','tool_mode':'code_mode_only','priority':7,'input_modalities':['text','image'],'model_messages':{'instructions_template':'You are Codex, a coding agent.\nRules.'},'service_tiers':['flex']}
        [entry]=model_catalog(template,{'default':'h','models':[{'slug':'h','claude_model':'claude-haiku-4-5-20251001','display_name':'Claude Haiku 4.5','efforts':[],'context_window':200000}]})
        self.assertEqual(entry['supported_reasoning_levels'],[{'effort':'medium','description':'Fixed: this model has no effort setting'}])
        self.assertEqual((entry['default_reasoning_level'],entry['context_window'],entry['auto_compact_token_limit']),('medium',200000,160000))

    def test_names_follow_the_versions_the_bridge_recorded(self):
        state=self.codex.parent/'sessions'
        state.mkdir()
        (state/'started-models.json').write_text(json.dumps({'claude-fable':'claude-fable-5-5','claude-opus':'claude-sonnet-5-5'}))
        refresh_capabilities(self.source,self.codex)
        models={m['slug']:m for m in json.loads((self.codex/'models.json').read_text())['models']}
        self.assertEqual([m['display_name'] for m in models.values()],['Claude Fable 5.5','Claude Opus 5.5','Claude Sonnet 5.5','Claude Haiku 5.5'])
        self.assertTrue(models['claude-fable']['model_messages']['instructions_template'].startswith('You are Claude Fable 5.5, running'))
        (state/'started-models.json').write_text('not json')
        refresh_capabilities(self.source,self.codex)
        self.assertEqual(json.loads((self.codex/'models.json').read_text())['models'][0]['display_name'],'Claude Fable 5.1')

    def test_missing_model_list_explains_what_to_do(self):
        (self.source/'models_cache.json').unlink()
        with self.assertRaisesRegex(RuntimeError,'Open the ChatGPT app once'):
            refresh_capabilities(self.source,self.codex)


if __name__ == '__main__':
    unittest.main()
