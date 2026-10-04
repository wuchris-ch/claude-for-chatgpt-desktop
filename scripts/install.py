#!/usr/bin/env python3
"""Install a durable copy of the bridge as a per-user macOS service. Does not open the app."""
import fcntl
import json
import os
import pathlib
import plistlib
import shutil
import signal
import subprocess
import time
import urllib.request
from bridge_config import APP_NAME, DEFAULT_PORT, load_launch, load_models, runtime_dir, source_home
from sync_runtime import refresh_capabilities
from runtime_paths import resolve_node
from release import atomic_write, switch_release

root=pathlib.Path(__file__).resolve().parents[1]
expected_version=json.loads((root/'package.json').read_text())['version']
runtime=runtime_dir()
if not (runtime/'launch.json').exists():
    subprocess.run(['python3',str(root/'scripts/setup.py')],check=True)
lock=(runtime/'install.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX)
config=load_launch(runtime)
label=config['label'];port=config.get('port',DEFAULT_PORT)
token=(runtime/'token').read_text().strip()
domain='gui/'+str(os.getuid())
agent=pathlib.Path.home()/'Library/LaunchAgents'/f'{label}.plist'

# In API key mode launchd hands the key to the bridge. It is stored only in the
# service definition, which is written with mode 0600, and kept on reinstall.
api_key=None
if config.get('auth')=='api_key':
    api_key=os.environ.get('ANTHROPIC_API_KEY')
    if not api_key and agent.exists():
        api_key=plistlib.loads(agent.read_bytes()).get('EnvironmentVariables',{}).get('ANTHROPIC_API_KEY')
    if not api_key:
        raise SystemExit('API key mode needs the key once: ANTHROPIC_API_KEY=your-key python3 scripts/install.py')

def health():
    try:
        req=urllib.request.Request(f'http://127.0.0.1:{port}/health',headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(req,timeout=1) as r:return json.load(r)
    except Exception:return None

def children():
    pidfile=runtime/'bridge.pid'
    if not pidfile.exists():return False
    return subprocess.run(['pgrep','-P',pidfile.read_text().strip()],capture_output=True).returncode==0

def busy():
    state=health() or {}
    return children() or state.get('active_sessions',0) or state.get('active_relays',0)

# Stage all files before stopping the old process, and refuse to interrupt work:
# in picker mode GPT responses stream through the bridge too.
if busy():
    raise SystemExit('A Claude or GPT response is streaming. Run this installer again once it finishes.')
app=runtime/'app'
stage=runtime/'app-staging'
if stage.exists():shutil.rmtree(stage)
stage.mkdir(mode=0o700)
for name in ['src','scripts','node_modules','package.json','package-lock.json','claude-models.json','README.md','LICENSE']:
    source=root/name
    if not source.exists():continue
    if source.is_dir():shutil.copytree(source,stage/name,symlinks=True,ignore=shutil.ignore_patterns('__pycache__'))
    else:shutil.copy2(source,stage/name)
refresh_capabilities(source_home(),runtime/'codex',load_models(config.get('models_file')),config.get('web_search',False))
node=pathlib.Path(resolve_node(config.get('node')))
config['node']=str(node)
version=subprocess.check_output([str(node),'-p','process.versions.node'],text=True).strip()
if int(version.split('.')[0])<24:raise SystemExit('Node.js 24 or later is required.')
if busy():
    raise SystemExit('A response started during staging. Run this installer again when it finishes.')
previous_version=(health() or {}).get('version')

def stop_service():
    subprocess.run(['launchctl','bootout',domain+'/'+label],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    pidfile=runtime/'bridge.pid'
    if pidfile.exists():
        pid=int(pidfile.read_text())
        command=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
        if 'src/server.mjs' in command and str(runtime) in command:
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
    for _ in range(100):
        if not health():return
        time.sleep(.1)
    raise RuntimeError('The bridge did not stop. Application files have not been switched.')

def start_service(version):
    for attempt in range(30):
        started=subprocess.run(['launchctl','bootstrap',domain,str(agent)],capture_output=True,text=True)
        if started.returncode==0:break
        time.sleep(.2)
    else:raise RuntimeError('macOS could not load the bridge service: '+started.stderr.strip())
    for _ in range(100):
        state=health()
        if state and (version is None or state.get('version')==version):return
        time.sleep(.1)
    raise RuntimeError('The bridge did not become healthy. Check '+str(runtime/'logs/bridge.stderr.log'))

def activate():
    config['source']=str(app);config['launch_agent']=label
    atomic_write(runtime/'launch.json',json.dumps(config,indent=2).encode())
    agent.parent.mkdir(parents=True,exist_ok=True)
    env={'CLAUDE_BRIDGE_RUNTIME':str(runtime),'CLAUDE_BIN':config.get('claude') or '',
         'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
    if api_key:env['ANTHROPIC_API_KEY']=api_key
    plist={'Label':label,'ProgramArguments':['/usr/bin/python3',str(app/'scripts/service.py')],
           'EnvironmentVariables':env,'WorkingDirectory':str(runtime),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':5,
           'StandardOutPath':str(runtime/'logs/bridge.jsonl'),'StandardErrorPath':str(runtime/'logs/bridge.stderr.log')}
    atomic_write(agent,plistlib.dumps(plist))
    start_service(expected_version)

stop_service()
switch_release(app,stage,runtime/'launch.json',agent,activate,stop_service,lambda:start_service(previous_version))
print(f'Installed {APP_NAME} {expected_version} as {label} on port {port}. macOS restarts it if it exits.')
