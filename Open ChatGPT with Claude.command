#!/bin/zsh
set -eu
BRIDGE_SOURCE="${0:A:h}"
exec python3 "$BRIDGE_SOURCE/scripts/launch.py"
