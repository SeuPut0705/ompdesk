#!/bin/bash
# Swap /Applications/OMPdesk.app for the freshly packaged build and reopen it, once.
#
# Safe to run from an agent inside ompdesk itself: the swap detaches from the
# app's process tree (nohup + background), so quitting the app does not kill it,
# and it runs exactly one time. Never schedule this with `launchctl submit`:
# submitted jobs are kept alive, so launchd reruns the swap forever and the app
# quits and relaunches in a loop.
#
# Usage: bun run package:mac -- --publish never && bash scripts/reinstall-mac.sh
set -euo pipefail

APP_NAME="OMPdesk"
SRC="$(cd "$(dirname "$0")/.." && pwd)/dist/mac-arm64/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"
LOG="${TMPDIR:-/tmp}/${APP_NAME}-reinstall.log"

if [[ ! -d "$SRC" ]]; then
	echo "No packaged app at $SRC — run: bun run package:mac -- --publish never" >&2
	exit 1
fi
codesign --verify --deep --strict "$SRC"

nohup /bin/bash -s "$APP_NAME" "$SRC" "$DEST" >"$LOG" 2>&1 <<'SWAP' &
set -u
app="$1" src="$2" dest="$3"
sleep 2 # let the calling agent's turn finish writing
osascript -e "quit app \"$app\"" 2>/dev/null || true
for _ in $(seq 1 20); do pgrep -x "$app" >/dev/null || break; sleep 1; done
pkill -x "$app" 2>/dev/null || true
sleep 1
staging="${dest}.installing"
rm -rf "$staging"
ditto "$src" "$staging"
rm -rf "$dest"
mv "$staging" "$dest"
open "$dest"
echo "reinstalled $(date)"
SWAP
disown
echo "Reinstall scheduled; ${APP_NAME} will quit and reopen in a few seconds (log: $LOG)."
