"""Property tests for the code that edits config.toml.

Random TOML files, with comments, all four string kinds, multi-line strings
and arrays holding lines that look like settings or tables, CRLF and dotted
keys, go through each editor. tomllib reads every result: it must parse, hold
the intended settings in the root table and leave every other setting as it
was, and a second run must change nothing. Fixed seeds keep runs repeatable;
CONFIG_PROPERTY_CASES runs more.
"""
import contextlib
import importlib
import io
import json
import os
import pathlib
import random
import sys
import tempfile
import unittest
try:
    import tomllib
except ImportError:
    tomllib = None

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
kind = 'public'
PORT = 19480


def run(cases, seed):
    global R
    sync = importlib.import_module('sync_runtime')
    root_end = sync.root_end
    picker = importlib.import_module('picker') if kind == 'public' else None
    setup = importlib.import_module('setup') if kind == 'public' else None
    stats = {'cases': 0, 'invalid_input': 0, 'changed': 0, 'refused': 0}
    failures = []
    seen_kinds = set()

    def fail(name, text, detail):
        if (name, detail[0]) in seen_kinds:
            return
        seen_kinds.add((name, detail[0]))
        failures.append((name, detail, text))
    R = random.Random(seed)
    def word():return R.choice(['a','b_c','key','x1','model_note','dev','z'])+str(R.randrange(1000))
    NASTY=['#','[',']','"','\\"',"'",'"""',"'''",'[x]','= 1','\\\\','{','}',',','\t','é','model_provider','openai_base_url']
    def junk(allow=''):
        return ''.join(R.choice(NASTY+list('abc ')) for _ in range(R.randrange(0,8)))
    def basic():
        s=''.join(R.choice(['a',' ','#','[',']',"'",'\\"','\\\\','é','{']) for _ in range(R.randrange(0,10)))
        return '"'+s+'"'
    def literal():return "'"+''.join(R.choice(['a',' ','#','[','"','\\']) for _ in range(R.randrange(0,10)))+"'"
    def mlbasic():
        lines=[R.choice(['[not a table]','  [x]','# not a comment',"it's",'"quoted"','\\\\','model_provider = "x"','openai_base_url = "y"','plain','']) for _ in range(R.randrange(0,4))]
        return '"""'+R.choice(['','\n'])+'\n'.join(lines)+R.choice(['','"','""'])+'"""'
    def mlliteral():
        lines=[R.choice(['[not a table]','# not a comment','"""','x\\y','']) for _ in range(R.randrange(0,4))]
        return "'''"+R.choice(['','\n'])+'\n'.join(lines)+"'''"
    def array(depth=0):
        items=[value(depth+1) for _ in range(R.randrange(0,4))]
        if R.random()<.5:return '['+', '.join(items)+']'
        return '[\n'+''.join('  '+i+','+R.choice(['',' # c [x] """'])+'\n' for i in items)+']'
    def inline(depth=0):return '{ '+', '.join(f'{word()} = {value(depth+1)}' for _ in range(R.randrange(0,3)))+' }'
    def value(depth=0):
        kinds=[basic,literal,mlbasic,mlliteral,lambda:str(R.randrange(-5,99)),lambda:R.choice(['true','false']),lambda:'1.5']
        if depth<2:kinds+=[lambda:array(depth),lambda:inline(depth)]
        return R.choice(kinds)()
    def comment():return '#'+R.choice([' use """ for long text',' [x]',"it's"," '''",' "',' plain',''])
    def root_block(extra=()):
        out=[];used=set()
        for _ in range(R.randrange(0,7)):
            r=R.random()
            if r<.15:out.append(comment())
            elif r<.25:out.append('')
            else:
                k=word()
                if k in used:continue
                used.add(k);out.append(f'{R.choice(["","  "])}{k} = {value()}'+(' '+comment() if R.random()<.2 else ''))
        for line in extra:out.insert(R.randrange(0,len(out)+1),line)
        text='\n'.join(out)
        return text+('\n' if out and R.random()<.9 else '')
    def tables():
        parts=[]
        if R.random()<.3:parts.append(comment()+'\n')
        for name in R.sample(['features','model_providers.claude_bridge','model_providers.claude_bridge.http_headers','mcp_servers.x','projects."/a b"','tui'],R.randrange(0,5)):
            parts.append(f'\n{R.choice(["","  "])}[{name}]\n'+root_block())
        if R.random()<.2:parts.append('\n[[agents]]\nname = "a"\n')
        return ''.join(parts)
    def provider_lines(token):
        out=[]
        r=R.random()
        ours=sync.app_provider_url(token,PORT) if kind=='public' else sync.app_provider_url(token)
        if r<.25:out.append(f'openai_base_url = "{ours}"')
        elif r<.35:out+=['# Added by claude-for-chatgpt-desktop. Remove with: python3 scripts/picker.py uninstall',f'openai_base_url = "http://127.0.0.1:{PORT}/g/gk/backend-api/codex"']
        elif r<.42:out.append('openai_base_url = "https://proxy.example/v1"')
        elif r<.5:out.append(f'openai_base_url = "http://127.0.0.1:{PORT}/k/old-key/v1"')
        if R.random()<.15:out.append(R.choice(['model_context_window = 1000000','model_auto_compact_token_limit = 800000']))
        if R.random()<.15:out.append(R.choice(['features.memories = false','features . goals = true','"model_providers".other = {}']))
        q=R.random()
        if q<.4:out.append('model_provider = "claude_bridge"')
        elif q<.5:out.append('model_provider = "openai"')
        return out
    def strip(d):return {k:v for k,v in d.items() if k not in ('model_provider','openai_base_url')}
    with tempfile.TemporaryDirectory() as d:
        codex=pathlib.Path(d);config=codex/'config.toml'
        for n in range(cases):
            token=R.choice(['fixture-secret','other'])
            R_text=root_block(provider_lines(token));T_text=tables()
            if 'features' in R_text and '[features]' in T_text:T_text=T_text.replace('[features]','[tui2]')
            if R.random()<.05:R_text=R_text.replace('\n','\r\n')
            text=R_text+T_text
            try:before=tomllib.loads(text)
            except tomllib.TOMLDecodeError:stats['invalid_input']+=1;continue
            stats['cases']+=1
            # root_end: the root part holds exactly the root keys
            end=root_end(text)
            try:
                rootdata=tomllib.loads(text[:end]);rest=text[end:]
                if R_text.strip() and tomllib.loads(R_text)!=rootdata:fail('root_end',text,('root differs',end,len(R_text)))
                if rest and not rest.lstrip().startswith(('[','#')) and rest.strip():fail('root_end',text,('rest does not start a table',rest[:40]))
            except tomllib.TOMLDecodeError as e:fail('root_end',text,('root slice invalid',str(e),end))
            for enabled in (True,False):
                config.write_text(text);config.chmod(0o600);text_disk=config.read_text()
                err=io.StringIO()
                with contextlib.redirect_stderr(err):
                    changed=sync.set_app_provider(codex,token,enabled=enabled,port=PORT) if kind=='public' else sync.set_app_provider(codex,token,enabled=enabled)
                if 'safely' in err.getvalue():fail('set_app_provider',text,('refused a valid file as unsafe',enabled))
                if 'another openai_base_url' in err.getvalue():stats['foreign']=stats.get('foreign',0)+1
                out=config.read_text()
                if not changed:
                    if out!=text_disk:fail('set_app_provider',text,('returned False but changed file',enabled))
                    stats['refused']+=1
                else:stats['changed']+=1
                try:after=tomllib.loads(out)
                except tomllib.TOMLDecodeError as e:fail('set_app_provider',text,('invalid output',enabled,str(e)));continue
                if strip(after)!=strip(before):fail('set_app_provider',text,('other settings changed',enabled))
                url=sync.app_provider_url(token,PORT) if kind=='public' else sync.app_provider_url(token)
                foreign=before.get('openai_base_url') not in (None,url) and not str(before.get('openai_base_url','')).startswith(f'http://127.0.0.1:{PORT}/'+('' if kind=='public' else 'k/'))
                if foreign:
                    if enabled and out!=text_disk:fail('set_app_provider',text,('foreign URL but changed',))
                    if not enabled and after.get('openai_base_url')!=before.get('openai_base_url'):fail('set_app_provider',text,('foreign URL replaced',))
                else:
                    if after.get('openai_base_url')!=url:fail('set_app_provider',text,('URL missing or wrong',enabled,after.get('openai_base_url')))
                    want=None if enabled else 'claude_bridge'
                    if after.get('model_provider')!=want:fail('set_app_provider',text,('provider wrong',enabled,after.get('model_provider')))
                if not foreign or not enabled:
                    if (out!=text_disk) and not enabled and foreign and after.get('model_provider')!='claude_bridge':fail('set_app_provider',text,('provider wrong with foreign URL',))
                with contextlib.redirect_stderr(io.StringIO()):
                    again=sync.set_app_provider(codex,token,enabled=enabled,port=PORT) if kind=='public' else sync.set_app_provider(codex,token,enabled=enabled)
                if again or config.read_text()!=out:fail('set_app_provider',text,('not idempotent',enabled))
            # search settings: only the three keys change
            config.write_text(text)
            if kind=='public':sync.set_standalone_search(codex,R.random()<.5)
            else:sync.enable_standalone_search(codex)
            try:
                s=tomllib.loads(config.read_text())
                b=json.loads(json.dumps(before));a=json.loads(json.dumps(s))
                for x in (a,b):
                    x.pop('web_search',None);x.get('features',{}).pop('standalone_web_search',None)
                    x.get('model_providers',{}).get('claude_bridge',{}).pop('supports_standalone_web_search',None)
                    if x.get('features')=={}:x.pop('features')
                    mp=x.get('model_providers')
                    if mp is not None and mp.get('claude_bridge')=={}:
                        mp.pop('claude_bridge')
                        if mp=={}:x.pop('model_providers')
                if a!=b:fail('search',text,('other settings changed',))
                if 'web_search' not in s:fail('search',text,('web_search not in root',))
            except tomllib.TOMLDecodeError as e:fail('search',text,('invalid output',str(e)))
            except Exception as e:fail('search',text,('error',repr(e)))
            if kind=='private':
                # Only the two context limits leave the root table.
                config.write_text(text);sync.drop_global_limits(codex)
                try:
                    a=tomllib.loads(config.read_text());b=dict(before)
                    for k in sync.GLOBAL_LIMITS:b.pop(k,None)
                    if a!=b:fail('drop_global_limits',text,('other settings changed',))
                except tomllib.TOMLDecodeError as e:fail('drop_global_limits',text,('invalid output',str(e)))
            if kind=='public':
                # picker: add then remove gives back the same bytes
                url='http://127.0.0.1:19480/g/gk2/backend-api/codex'
                try:added=picker.add_setting(text,url)
                except SystemExit:added=None
                if added is not None:
                    try:
                        a=tomllib.loads(added)
                        if a.get('openai_base_url')!=url or strip(a)!=strip(before) or a.get('model_provider')!=before.get('model_provider'):fail('picker add',text,('settings wrong',))
                    except tomllib.TOMLDecodeError as e:fail('picker add',text,('invalid output',str(e)))
                    if picker.remove_setting(added).rstrip('\n')!=text.rstrip('\n'):fail('picker remove',text,('bytes not restored',))
                # setup: the profile parses, with the bridge settings in the root
                try:
                    cfg=setup.build_config(text,codex=pathlib.Path('/tmp/iso codex'),port=19480,token='t',default_model='claude-opus',web_search=False)
                    c=tomllib.loads(cfg)
                    if c.get('model')!='claude-opus' or c.get('model_provider')!='claude_bridge' or 'openai_base_url' in c or c['model_providers']['claude_bridge']['base_url']!='http://127.0.0.1:19480/v1':fail('build_config',text,('settings wrong',))
                except tomllib.TOMLDecodeError as e:fail('build_config',text,('invalid output',str(e)))
                except Exception as e:fail('build_config',text,('error',repr(e)))

    return stats, failures


@unittest.skipIf(tomllib is None, 'needs Python 3.11')
class ConfigPropertyTests(unittest.TestCase):
    def test_every_editor_keeps_generated_files_valid_and_unchanged_elsewhere(self):
        cases = int(os.environ.get('CONFIG_PROPERTY_CASES', '400'))
        for seed in (1, 2, 3):
            stats, failures = run(cases, seed)
            self.assertGreater(stats['cases'], cases*3//4)
            self.assertEqual(failures, [], '\n\n'.join(f'{name} {detail}\n{text}' for name, detail, text in failures))

    def test_the_editors_hold_without_their_parse_check(self):
        # Python before 3.11, such as macOS's /usr/bin/python3, has no TOML
        # parser, so the editors skip the check they make before writing.
        saved = sys.modules.get('tomllib')
        sys.modules['tomllib'] = None
        try:
            self.test_every_editor_keeps_generated_files_valid_and_unchanged_elsewhere()
        finally:
            sys.modules['tomllib'] = saved


if __name__ == '__main__':
    unittest.main()
