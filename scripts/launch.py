#!/usr/bin/env python3
"""Start the bridge if needed, then open the isolated ChatGPT window."""
import argparse
import os
import json
import pathlib
import subprocess
import time
import urllib.request
from bridge_config import DEFAULT_PORT, load_launch, load_models, runtime_dir, source_home
from sync_runtime import refresh_capabilities
from runtime_paths import resolve_node

argparse.ArgumentParser(description='Start the bridge if needed, then open the separate ChatGPT window that uses only Claude.').parse_args()
runtime=runtime_dir()
if not (runtime/'launch.json').exists():
    raise SystemExit('Run python3 scripts/setup.py first.')
config=load_launch(runtime)
token=(runtime/'token').read_text().strip()
port=config.get('port',DEFAULT_PORT)
resolve_node(config.get('node'))
def healthy():
    try:
        req=urllib.request.Request(f'http://127.0.0.1:{port}/health',headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(req,timeout=1) as response:
            return bool(json.load(response).get('models'))
    except Exception:
        return False
refresh_capabilities(source_home(),runtime/'codex',load_models(config.get('models_file')),config.get('web_search',False))
if not healthy():
    label=config.get('launch_agent')
    if not label:
        subprocess.run(['python3',str(pathlib.Path(__file__).with_name('install.py'))],check=True)
    else:
        domain='gui/'+str(os.getuid())
        agent=pathlib.Path.home()/'Library/LaunchAgents'/f'{label}.plist'
        started=subprocess.run(['launchctl','kickstart',domain+'/'+label],capture_output=True)
        if started.returncode:
            subprocess.run(['launchctl','bootstrap',domain,str(agent)],check=True)
    for _ in range(100):
        if healthy():break
        time.sleep(.1)
    else:raise SystemExit('The bridge did not become healthy. See '+str(runtime/'logs/bridge.stderr.log'))
expected=config['app']+'/Contents/MacOS/ChatGPT --user-data-dir='+str(runtime/'user-data')
running=any(line.strip()==expected for line in subprocess.check_output(['ps','-axo','command='],text=True).splitlines())
if running:
    print('The Claude window is already running.')
    raise SystemExit(0)
subprocess.run(['/usr/bin/open','-n','--env','CODEX_HOME='+str(runtime/'codex'),
                '--env','CODEX_ELECTRON_USER_DATA_PATH='+str(runtime/'user-data'),config['app'],
                '--args','--user-data-dir='+str(runtime/'user-data')],check=True)
print('Opened ChatGPT with Claude.')
