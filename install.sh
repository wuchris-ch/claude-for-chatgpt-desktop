#!/bin/bash
# Installs or updates Claude for ChatGPT Desktop: Claude Fable, Opus, Sonnet and
# Haiku in the ChatGPT desktop app's model picker, next to GPT.
#
#   curl -fsSL https://raw.githubusercontent.com/wuchris-ch/claude-for-chatgpt-desktop/main/install.sh | bash
#
# Run it again to update. Options, after `bash -s --` when piped:
#   --window     use a separate ChatGPT window for Claude instead of the normal picker
#   --uninstall  take Claude out of the picker and remove the background service
set -euo pipefail

REPO=https://github.com/wuchris-ch/claude-for-chatgpt-desktop.git
RUNTIME="${CLAUDE_BRIDGE_RUNTIME:-$HOME/Library/Application Support/Claude for ChatGPT Desktop}"
APP=/Applications/ChatGPT.app
MODE=picker
for arg in "$@"; do
  case "$arg" in
    --window) MODE=window ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) echo "Usage: install.sh [--window | --uninstall]"; exit 0 ;;
    *) echo "Unknown option $arg. Use --window or --uninstall." >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
# Asks on the terminal, which still works when the script itself arrives
# through a pipe. Without a terminal the answer is no.
ask() {
  (exec </dev/tty) 2>/dev/null || return 1
  local reply
  printf '%s [Y/n] ' "$1" >/dev/tty
  read -r reply </dev/tty || return 1
  case "$reply" in ''|y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

[ "$(uname -s)" = Darwin ] || fail "Claude for ChatGPT Desktop runs on macOS only."
if ! { git --version && python3 --version; } >/dev/null 2>&1; then
  fail "git and python3 come with Apple's command line tools. Run xcode-select --install, then run this again."
fi

# A copy of the repository runs its own files. Through curl, the installer
# keeps a copy in the runtime folder and updates it on each run.
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/scripts/install.py" ]; then
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ "$MODE" = uninstall ]; then
  SRC="${SRC:-$RUNTIME/source}"
  [ -f "$SRC/scripts/uninstall.py" ] || fail "Nothing to uninstall: $SRC is missing."
  cd "$SRC"
  python3 scripts/picker.py uninstall
  python3 scripts/uninstall.py
  say "Removed. Your Claude profile, history and logs stay in $RUNTIME."
  echo "To delete them too: python3 \"$SRC/scripts/uninstall.py\" --delete-data"
  exit 0
fi

[ -d "$APP" ] || fail "The ChatGPT desktop app is not in /Applications. Install it from https://chatgpt.com/download, then run this again."
# Setup builds Claude's picker entries from the model list the app downloads
# into its profile when it first opens.
[ -f "${CODEX_HOME:-$HOME/.codex}/models_cache.json" ] \
  || fail "Open the ChatGPT app once and sign in, then run this again."

if [ "$(node_major)" -lt 24 ]; then
  if command -v brew >/dev/null && ask "Node.js 24 or later is needed. Install it with Homebrew now?"; then
    if brew list node >/dev/null 2>&1; then brew upgrade node; else brew install node; fi
    hash -r
  fi
  [ "$(node_major)" -ge 24 ] || fail "Node.js 24 or later is needed. Install it from https://nodejs.org (or brew install node), then run this again."
fi

command -v claude >/dev/null \
  || fail "Claude Code is not installed. Install it (https://code.claude.com/docs/en/setup), run claude once to sign in, then run this again."
# API key mode, set with setup.py --auth api-key, needs no login.
if ! grep -qs '"auth": "api_key"' "$RUNTIME/launch.json"; then
  login=$(claude auth status --json 2>/dev/null || true)
  if [[ $login =~ \"loggedIn\":\ *false ]]; then
    if ask "Claude Code is not signed in. Sign in now?"; then
      claude auth login </dev/tty
    else
      fail "Run claude once and sign in, then run this again."
    fi
  fi
fi

if [ -z "$SRC" ]; then
  SRC="$RUNTIME/source"
  if [ -d "$SRC/.git" ]; then
    say "Updating $SRC"
    git -C "$SRC" pull --ff-only --quiet || fail "Could not update $SRC. If you changed files there, undo the changes and run this again."
  else
    say "Downloading to $SRC"
    mkdir -p "$(dirname "$RUNTIME")"
    [ -d "$RUNTIME" ] || mkdir -m 700 "$RUNTIME"
    git clone --quiet --depth 1 "$REPO" "$SRC"
  fi
fi
cd "$SRC"

say "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error

say "Installing the background service"
python3 scripts/install.py

if [ "$MODE" = window ]; then
  say "Opening the Claude window"
  python3 scripts/launch.py
  echo "Sign into ChatGPT once in the new window. To open it later, double-click \"Open ChatGPT with Claude.command\" in $SRC."
  exit 0
fi

picker=$(python3 scripts/picker.py status)
if [[ $picker == *"Picker mode: on"* ]]; then
  say "Claude is already in the ChatGPT model picker. Everything is up to date."
  exit 0
fi
say "Adding Claude to the ChatGPT model picker"
python3 scripts/picker.py install \
  || fail "Picker mode could not be turned on (see above). For a separate Claude window instead, run this again with --window."

# Only one ChatGPT window can be restarted safely; with more, the user does it.
running=$(pgrep -x ChatGPT | wc -l | tr -d ' ' || true)
if [ "$running" = 0 ]; then
  open "$APP"
elif [ "$running" = 1 ] && ask "ChatGPT needs to reopen to show Claude. Reopen it now?"; then
  osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
  for _ in $(seq 1 100); do pgrep -xq ChatGPT || break; sleep 0.2; done
  open "$APP"
else
  echo "Quit and reopen ChatGPT to see Claude in the model picker."
fi
say "Done. In any chat, open the model picker and choose a Claude model."
echo "To update, run the same command again. To remove: curl -fsSL https://raw.githubusercontent.com/wuchris-ch/claude-for-chatgpt-desktop/main/install.sh | bash -s -- --uninstall"
