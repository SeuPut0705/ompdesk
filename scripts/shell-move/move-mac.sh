#!/bin/bash
# move-mac.sh: the whole update move on macOS, from the released v0.127.0 into the real shell bundle, on a throwaway GitHub
# macOS runner only (shell-batch-checks.yml `move-mac`, macos-15 and macos-26; macOS 27 has no hosted runner). The mac twin of
# run-move.ts. Nothing here runs on a person's Mac: it re-signs apps, makes keychains, sets launchd variables and opens apps.
#  - the released app is copied out of its DMG into a temp "Applications" folder and re-signed with a throwaway certificate and
#    the release's form of designated requirement (resign-mac.sh), so its keychain item is a release-signed one;
#  - its profile is a temp --user-data-dir; HOME stays the runner's (the keychain is the job's own default keychain, never a
#    test HOME, whose keychain would add a partition entry); the app is headless (OMP_GUI_HEADLESS, which the swap's `open -n`
#    relaunch does not carry, so it is set in launchd for the run);
#  - its updater, unchanged, reaches feed.ts (--platform mac, GitHub's 302 to the storage host for `signedAssetUrl`) through
#    Chromium's own switches, and is offered ompdesk-mac-arm64.dmg built by scripts/package-mac.ts, signed with the same
#    certificate, as 0.200.0.
#  S1 the move: check found, download verified (stageBundleFromDmg: codesign --verify --deep --strict, bundle id, version),
#     scheduler safe, countdown, install auto, swap helper, swap.log installed, the shell started with Electron's argv, Local
#     Storage imported, the page loaded, the seeded token decrypted, no SecurityAgent/coreauthd line.
#  S2 a failed move: the apps folder is made read-only before the countdown ends; the swap fails (copy failed), Electron is
#     untouched, and the next launch of the released app logs `swap result outcome rolled back`.
# Evidence lines start with "EVIDENCE:". Exit 1 on any failed check.
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
. "$HERE/mac-common.sh"
PORT=19230; FEEDPORT=18444
launchctl setenv OMP_GUI_HEADLESS 1
cleanup() { launchctl unsetenv OMP_GUI_HEADLESS; launchctl unsetenv OMP_GUI_TEST_USER_DATA_DIR; chmod -R u+w "$W" 2>/dev/null; kill $WATCH $FEED 2>/dev/null; }
trap cleanup EXIT

step "control: a prompt-free keychain read"
control_chatter

step "the new shell bundle and its DMG (scripts/package-mac.ts, signed with the throwaway identity)"
(cd "$REPO" && bun scripts/package-mac.ts --version 0.200.0 --sign-with "$ID" --keychain "$KC0"); check $? "package-mac built the signed bundle and the DMG"
DMG=$(ls "$REPO"/dist/ompdesk-0.200.0-arm64.dmg 2>/dev/null | head -1); test -f "$DMG"; check $? "dist/ompdesk-0.200.0-arm64.dmg exists ($(stat -f %z "$DMG" 2>/dev/null) bytes)"
cp "$DMG" "$W/new.dmg"

step "the released app v0.127.0, re-signed (release-form designated requirement)"
curl -sSL -o rel.dmg https://github.com/SeuPut0705/ompdesk/releases/download/v0.127.0/ompdesk-mac-arm64.dmg
mkdir mnt && hdiutil attach -nobrowse -readonly -noautoopen -mountpoint mnt rel.dmg >/dev/null && ditto mnt/OMPdesk.app rel.app && hdiutil detach mnt >/dev/null
bash "$HERE/resign-mac.sh" rel.app "$KC0" "$ID" | tail -1
evidence "released app requirement: $(codesign -d -r- rel.app 2>&1 | sed -n 's/^designated => //p')"
start_feed $FEEDPORT "$W/new.dmg"
SWITCHES=(--host-resolver-rules="MAP api.github.com 127.0.0.1:$FEEDPORT" --ignore-certificate-errors)
update_lines() { jq -r 'select(.source=="app-update") | "\(.message) \(.details.event // "") \(.details.outcome // "") \(.details.mode // "")"' "$1/logs/gui-runtime.jsonl" 2>/dev/null; }
has_line() { update_lines "$1" | grep -q "^$2"; }
wait_for() { local n=0; while [ $n -lt $2 ]; do eval "$1" && return 0; sleep 3; n=$((n+3)); done; return 1; }

# scenario <name> <fail 0|1>
scenario() {
  local name=$1 fail=$2
  use_keychain "$name"
  local APPS=$W/$name/Applications UD=$W/$name/ud
  mkdir -p "$APPS" "$UD"; ditto rel.app "$APPS/OMPdesk.app"
  launchctl setenv OMP_GUI_TEST_USER_DATA_DIR "$UD"
  step "$name: the released app seeds a token and Local Storage (its own IPC)"
  OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-seed.out" 2>&1 &
  (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $PORT) | tee "$W/$name-seed.json"; check ${PIPESTATUS[0]} "$name: seeded"
  kill_apps "$APPS/OMPdesk.app/Contents/MacOS"
  test -f "$UD/update-token.bin"; check $? "$name: update-token.bin is in the profile"
  rm -rf "$UD/logs" "$UD/updates"
  step "$name: the released app, left alone with its updater"
  OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-old.out" 2>&1 &
  wait_for "has_line $UD 'download verified'" 240; check $? "$name: check found, download verified"
  if [ "$fail" = 1 ]; then
    chmod -R a-w "$APPS"; evidence "S2 the apps folder is read-only before the countdown ends ($(stat -f %Sp "$APPS"))"
  fi
  wait_for "has_line $UD 'swap helper'" 300; check $? "$name: install auto, swap helper"
  update_lines "$UD" | sed 's/^/EVIDENCE: update log: /'
  if [ "$fail" = 0 ]; then
    wait_for "grep -q '^installed' $UD/updates/swap.log" 120; check $? "S1: swap.log says installed"
    evidence "S1 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-300)"
    wait_for "grep -q window.created $UD/shell-webview/shell.log.jsonl 2>/dev/null" 180; check $? "S1: the new shell started (window.created)"
    evidence "S1 shell command line: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | head -1 | cut -c1-260)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | grep -q -- "--user-data-dir=$UD"; check $? "S1: the shell was started with Electron's argv (--user-data-dir)"
    grep -q '"migrate.localStorage"' "$UD/shell-webview/shell.log.jsonl"; check $? "S1: migrate.localStorage in the shell log"
    evidence "S1 shell log: $(grep -E 'migrate|cef.ready|window.created' "$UD/shell-webview/shell.log.jsonl" | cut -c1-200 | tr '\n' '|')"
    (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $PORT read) | tee "$W/$name-read.json"; check ${PIPESTATUS[0]} "S1: the shell's page answered"
    grep -q '"href":"app://ompdesk/' "$W/$name-read.json"; check $? "S1: the page loaded from app://ompdesk"
    grep -q '"draft":"a draft typed in Electron"' "$W/$name-read.json" && grep -q '"large":200000' "$W/$name-read.json"; check $? "S1: Local Storage reached the page"
    grep -q '"hasStoredToken":true' "$W/$name-read.json" && grep -q '"droppedReason":null' "$W/$name-read.json"; check $? "S1: the seeded token was decrypted (a stored token, none dropped)"
    wait_for "has_line $UD 'swap result'" 60; update_lines "$UD" | grep -q '^swap result installed'; check $? "S1: swap result outcome installed"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S1: the installed app verifies"
    evidence "S1 installed bundle: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist") ($(codesign -d -r- "$APPS/OMPdesk.app" 2>&1 | sed -n 's/^designated => //p'))"
  else
    wait_for "grep -q 'copy failed\|install failed\|cannot move' $UD/updates/swap.log 2>/dev/null" 120; check $? "S2: the swap failed (swap.log)"
    evidence "S2 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-300)"
    sleep 5
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = 0.127.0 ]; check $? "S2: the Electron app is untouched (0.127.0)"
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S2: no .updating or .previous leftovers"
    kill_apps "$APPS/OMPdesk.app/Contents/MacOS"
    chmod -R u+w "$APPS"
    # The next launch, as a person's: the released app reports the failed move.
    OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:1" --ignore-certificate-errors >"$W/$name-again.out" 2>&1 &
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | grep -q '^swap result rolled back'; check $? "S2: swap result outcome rolled back"
  fi
  dialogs; check $? "$name: no dialog (SecurityAgent) line"
  kill_apps "$APPS/OMPdesk.app/Contents/MacOS"; pkill -f "$W/$name" 2>/dev/null
  restore
}
scenario s1 0
scenario s2 1
dialog_evidence
security delete-keychain "$KC0" 2>/dev/null
exit $FAILED
