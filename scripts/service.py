#!/usr/bin/env python3
"""Service entry point: find Node and Claude Code on each start, then run the bridge."""
import os
import pathlib
import shutil
from bridge_config import load_launch, runtime_dir, service_env
from runtime_paths import resolve_node
runtime=runtime_dir()
config=load_launch(runtime)
node=resolve_node(config.get('node'))
claude=config.get('claude')
if not claude or not pathlib.Path(claude).is_file():
    claude=shutil.which('claude') or str(pathlib.Path.home()/'.local/bin/claude')
env=dict(os.environ,**service_env(runtime,config),CLAUDE_BIN=claude)
env['PATH']=str(pathlib.Path(node).parent)+':'+str(pathlib.Path(claude).parent)+':'+env.get('PATH','/usr/bin:/bin')
os.execve(node,[node,str(runtime/'app/src/server.mjs')],env)

