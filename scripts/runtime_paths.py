"""Find a working Node runtime each time the service starts."""
import pathlib
import re
import shutil
import subprocess

def resolve_node(saved=None):
    home=pathlib.Path.home()
    versions=list((home/'.nvm/versions/node').glob('v*/bin/node'))
    versions.sort(key=lambda p:tuple(int(x) for x in re.findall(r'\d+',p.parent.parent.name)),reverse=True)
    candidates=[shutil.which('node'),'/opt/homebrew/bin/node','/usr/local/bin/node',*versions,saved]
    tried=set()
    for candidate in candidates:
        if not candidate or str(candidate) in tried:continue
        tried.add(str(candidate));p=pathlib.Path(candidate)
        if not p.is_file():continue
        try:
            result=subprocess.run([str(p),'-e','if(Number(process.versions.node.split(".")[0])<24 || !require("node:zlib").zstdDecompressSync) process.exit(1)'],capture_output=True,timeout=5)
            if result.returncode==0:return str(p)
        except (OSError,subprocess.TimeoutExpired):pass
    raise RuntimeError('A working Node.js 24 or later is required. Install Node, then run the launcher again.')
