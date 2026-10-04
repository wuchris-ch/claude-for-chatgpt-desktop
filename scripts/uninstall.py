#!/usr/bin/env python3
"""Stop and remove the bridge service.

Keeps the isolated profile, its conversations and the bridge's state unless
--delete-data is given. Your normal ChatGPT profile is never touched.
"""
import argparse
import os
import pathlib
import shutil
import subprocess
from bridge_config import APP_NAME, DEFAULT_LABEL, load_launch, runtime_dir

parser=argparse.ArgumentParser(description='Remove the '+APP_NAME+' service.')
parser.add_argument('--delete-data',action='store_true',help='Also delete the runtime folder: isolated profile, history, logs and bridge state')
args=parser.parse_args()
runtime=runtime_dir()
config=load_launch(runtime) if (runtime/'launch.json').exists() else {}
label=config.get('launch_agent') or config.get('label') or DEFAULT_LABEL
subprocess.run(['launchctl','bootout','gui/'+str(os.getuid())+'/'+label],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
agent=pathlib.Path.home()/'Library/LaunchAgents'/f'{label}.plist'
agent.unlink(missing_ok=True)
print('Removed the service',label)
if args.delete_data and runtime.exists():
    window=str(runtime/'user-data')
    if any(window in line for line in subprocess.check_output(['ps','-axo','command='],text=True).splitlines()):
        raise SystemExit('Quit the Claude window first, then run this again.')
    shutil.rmtree(runtime)
    print('Deleted',runtime)
elif runtime.exists():
    print('Kept',runtime,'(use --delete-data to remove it)')

