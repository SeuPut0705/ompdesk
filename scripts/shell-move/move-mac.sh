#!/bin/bash
# move-mac.sh: the whole update move on macOS, from the released v0.127.0 into the real shell bundle, on a throwaway GitHub
# macOS runner only (shell-batch-checks.yml `move-mac`, macos-15 and macos-26; macOS 27 has no hosted runner). The mac twin of
# run-move.ts. Nothing here runs on a person's Mac: it re-signs apps, makes keychains, sets launchd variables and opens apps.
#  - the released app is copied out of its DMG into a temp "Applications" folder and re-signed with a throwaway certificate and
#    the release's form of designated requirement (resign-mac.sh), so its keychain item is a release-signed one;
#  - its profile is a temp --user-data-dir; HOME stays the runner's (the keychain is the job's own default keychain, never a
#    test HOME, whose keychain would add a partition entry); the app is NOT headless: OMP_GUI_HEADLESS makes the released app use a
#    mock keychain, which would skip the very keychain path under test (windows show on the throwaway runner);
#  - its updater, unchanged, reaches feed.ts (--platform mac, GitHub's 302 to the storage host for `signedAssetUrl`) through
#    Chromium's own switches, and is offered ompdesk-mac-arm64.dmg built by scripts/package-mac.ts, signed with the same
#    certificate, as 0.200.0.
#  S1 the move: check found, download verified (stageBundleFromDmg: codesign --verify --deep --strict, bundle id, version),
#     scheduler safe, countdown, install auto, swap helper, swap.log installed, the shell started with Electron's argv, Local
#     Storage imported, the page loaded, the seeded token decrypted, no SecurityAgent/coreauthd line.
#  S3 a new shell that does not start (OMP_GUI_TEST_SHELL_FAIL_START=1 in the relaunch's launchd environment): v0.127.0's swap
#     script installs it and deletes `.previous`, so the shell bundle's launcher, which sees no page within the window
#     (OMPDESK_LAUNCHER_START_WAIT_S), downloads the last Electron release from the stand-in (OMPDESK_LAUNCHER_RELEASE_URL: the
#     released v0.127.0 re-signed stands in for it), swaps it back and opens it; swap.log reports it and Electron says
#     `swap result … rolled back`; no dialog.
#  S2 a failed move: the apps folder is made read-only before the countdown ends; the swap fails (copy failed), Electron is
#     untouched, and the next launch of the released app logs `swap result outcome rolled back`.
# OMP_MOVE_RELEASED_TAG=v0.128.0 selects the real release 1 DMG instead of v0.127.0. Its start-checked SWAP_SCRIPT keeps
# `<app>.previous` until the new app writes app-started.json for the offered version: S1 then says `started`, and S4
# (the new shell does not start) has the script restore `.previous` (`start failed; previous app restored`) and reopen
# the old app, which logs `swap result … rolled back`; the launcher only notes that the swap restores.
# Evidence lines start with "EVIDENCE:". Exit 1 on any failed check.
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
. "$HERE/mac-common.sh"
PORT=19230; FEEDPORT=18444; HTTPPORT=18445
SOURCE_TAG=${OMP_MOVE_RELEASED_TAG:-v0.127.0}
case "$SOURCE_TAG" in v0.127.0|v0.128.0) ;; *) echo "unsupported released tag: $SOURCE_TAG"; exit 1 ;; esac
LAST_ELECTRON_TAG=$(jq -r .tag "$REPO/native/ompdesk/crates/shell/last-electron.json")
cleanup() { for v in OMP_GUI_TEST_USER_DATA_DIR OMP_GUI_TEST_SHELL_FAIL_START OMPDESK_LAUNCHER_RELEASE_URL OMPDESK_LAUNCHER_START_WAIT_S; do launchctl unsetenv $v; done; chmod -R u+w "$W" 2>/dev/null; kill "${WATCH:-}" "${FEED:-}" 2>/dev/null; }
trap cleanup EXIT

step "control: a prompt-free keychain read"
control_chatter

step "the new shell bundle and its DMG (scripts/package-mac.ts, signed with the throwaway identity)"
(cd "$REPO" && bun scripts/package-mac.ts --version 0.200.0 --sign-with "$ID" --keychain "$KC0"); check $? "package-mac built the signed bundle and the DMG"
DMG=$(ls "$REPO"/dist/ompdesk-0.200.0-arm64.dmg 2>/dev/null | head -1); test -f "$DMG"; check $? "dist/ompdesk-0.200.0-arm64.dmg exists ($(stat -f %z "$DMG" 2>/dev/null) bytes)"
cp "$DMG" "$W/new.dmg"

# The released app is downloaded as shipped; the only change is the throwaway certificate.
download_app() {
  local tag=$1 destination=$2 mount="$W/mnt-$1"
  curl -fsSL -o "$W/$tag.dmg" "https://github.com/SeuPut0705/ompdesk/releases/download/$tag/ompdesk-mac-arm64.dmg" || return 1
  mkdir -p "$mount"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$W/$tag.dmg" >/dev/null || return 1
  ditto "$mount/OMPdesk.app" "$destination"; local copied=$?
  hdiutil detach "$mount" >/dev/null || return 1
  return "$copied"
}
step "the released app $SOURCE_TAG, re-signed (release-form designated requirement)"
download_app "$SOURCE_TAG" "$W/rel.app" || exit 1
OLD_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' rel.app/Contents/Info.plist)
[ "$OLD_VERSION" = "${SOURCE_TAG#v}" ] || exit 1
evidence "the app that updates: the real $SOURCE_TAG DMG ($OLD_VERSION)"
bash "$HERE/resign-mac.sh" rel.app "$KC0" "$ID" | tail -1
evidence "released app requirement: $(codesign -d -r- rel.app 2>&1 | sed -n 's/^designated => //p')"
# Compare the actual user relaunch (`open -n` from the released swap script), with no Gatekeeper rule: the re-signed
# Electron and the shell must both start, without quarantine. A rejected `spctl --assess` alone does not prove launch refusal.
open_probe() {
  local app=$1 label=$2 ud
  ud=$W/probe-$label
  mkdir -p "$ud"
  evidence "probe $label: spctl --status: $(spctl --status 2>&1 | tr '\n' ' ')"
  evidence "probe $label: quarantine on the bundle: $(xattr -l "$app" 2>&1 | tr '\n' '|') ; on nested executables: $(find "$app" -type f -perm +111 -exec xattr -l {} + 2>/dev/null | grep -c quarantine) with the attribute"
  evidence "probe $label: spctl --assess: $(spctl --assess -vv --type execute "$app" 2>&1 | tr '\n' ' ')"
  local t0; t0=$(date '+%Y-%m-%d %H:%M:%S')
  launchctl setenv OMP_GUI_TEST_USER_DATA_DIR "$ud"
  open -n "$app" --args --user-data-dir="$ud" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:1" >"$W/probe-$label.out" 2>&1; local rc=$?
  sleep 25
  local running; running=$(ps -axo command | grep "$app/Contents/MacOS/" | grep -v grep | head -1 | cut -c1-140)
  evidence "probe $label: open -n exit $rc, output: $(head -c 300 "$W/probe-$label.out" | tr '\n' '|'); running afterwards: ${running:-nothing}"
  log show --start "$t0" --predicate 'process == "syspolicyd" OR subsystem == "com.apple.launchservices"' --style compact 2>/dev/null | grep -i 'ompdesk\|reject\|denied\|not allowed\|assess' | tail -12 | cut -c1-260 | sed "s/^/EVIDENCE: probe $label log: /"
  kill_apps "$app/Contents/MacOS"; launchctl unsetenv OMP_GUI_TEST_USER_DATA_DIR
  [ -n "$running" ]
}
mkdir -p "$W/probe-apps"
use_keychain probe
ditto rel.app "$W/probe-apps/electron.app"; ditto "$REPO/dist/mac-arm64/OMPdesk.app" "$W/probe-apps/shell.app"
open_probe "$W/probe-apps/electron.app" electron; ELECTRON_OPENS=$?
open_probe "$W/probe-apps/shell.app" shell; SHELL_OPENS=$?
restore
check "$ELECTRON_OPENS" "the re-signed released Electron opens through \`open -n\` without any spctl rule"
check "$SHELL_OPENS" "the shell bundle opens through \`open -n\` without any spctl rule"
evidence "the released SWAP_SCRIPT relaunches with open -n: $(grep -a -o 'open -n "$dest"[^;]*' rel.app/Contents/Resources/app.asar 2>/dev/null | head -1 | cut -c1-80)"
# The launcher's baked tag selects the last Electron release, also when the user skips release 1 and starts at v0.127.0.
if [ "$SOURCE_TAG" = "$LAST_ELECTRON_TAG" ]; then
  ditto rel.app "$W/rollback.app"
else
  download_app "$LAST_ELECTRON_TAG" "$W/rollback.app" || exit 1
  bash "$HERE/resign-mac.sh" "$W/rollback.app" "$KC0" "$ID" | tail -1
fi
ROLLBACK_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$W/rollback.app/Contents/Info.plist")
[ "$ROLLBACK_VERSION" = "${LAST_ELECTRON_TAG#v}" ] || exit 1
# `-srcfolder` copies contents; its source folder must hold the app, not be the app.
mkdir "$W/dmgsrc" && ditto "$W/rollback.app" "$W/dmgsrc/OMPdesk.app"
hdiutil create -volname OMPdesk -srcfolder "$W/dmgsrc" -fs HFS+ -ov -format UDZO "$W/rollback.dmg" 2>&1 | tail -3 | sed 's/^/EVIDENCE: hdiutil: /'
test -s "$W/rollback.dmg"; check $? "the re-signed last Electron release $LAST_ELECTRON_TAG is in a DMG ($(stat -f %z "$W/rollback.dmg" 2>/dev/null) bytes)"
test -s "$W/rollback.dmg" || exit 1
start_feed $FEEDPORT "$W/new.dmg" --rollback-dmg "$W/rollback.dmg" --rollback-tag "$LAST_ELECTRON_TAG" --http-port $HTTPPORT
curl -s "http://127.0.0.1:$HTTPPORT/repos/SeuPut0705/ompdesk/releases/tags/$LAST_ELECTRON_TAG" | grep -q ompdesk-update; check $? "the stand-in serves the last Electron release's tag route on :$HTTPPORT"
SWITCHES=(--host-resolver-rules="MAP api.github.com 127.0.0.1:$FEEDPORT" --ignore-certificate-errors)
update_lines() { jq -r 'select(.source=="app-update") | "\(.message) \(.details.event // "") \(.details.outcome // "") \(.details.mode // "") \(.details.reason // "")"' "$1/logs/gui-runtime.jsonl" 2>/dev/null; }
has_line() { update_lines "$1" | grep -q "^$2"; }
wait_for() { local n=0; while [ $n -lt $2 ]; do eval "$1" && return 0; sleep 3; n=$((n+3)); done; return 1; }

# What the relaunch left when the new shell did not come up: what runs, what the shell wrote, the system's word on the
# process and crash reports; then the same bundle started directly (not through `open`), to tell a broken bundle from a
# broken launch context.
relaunch_diag() {
  local APPS=$1 UD=$2 name=$3
  evidence "diag: processes: $(ps -axo pid,command | grep 'OMPdesk' | grep -v grep | cut -c1-200 | tr '\n' '|')"
  evidence "diag: shell-webview: $(ls "$UD/shell-webview" 2>&1 | tr '\n' ' ')"
  evidence "diag: shell log tail: $(tail -n 8 "$UD/shell-webview/shell.log.jsonl" 2>&1 | cut -c1-200 | tr '\n' '|')"
  evidence "diag: swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-400)"
  evidence "diag: crash reports: $(ls -t ~/Library/Logs/DiagnosticReports 2>/dev/null | grep -i ompdesk | head -3 | tr '\n' ' ')"
  for r in $(ls -t ~/Library/Logs/DiagnosticReports/*OMPdesk* 2>/dev/null | head -1); do head -c 1800 "$r" | sed 's/^/EVIDENCE: diag crash: /'; done
  log show --last 6m --predicate 'process == "OMPdesk" OR process == "launchservicesd" AND eventMessage CONTAINS "OMPdesk"' --style compact 2>/dev/null | tail -25 | cut -c1-260 | sed 's/^/EVIDENCE: diag log: /'
  evidence "diag: spctl: $(spctl --assess --type execute -vv "$APPS/OMPdesk.app" 2>&1 | tr '\n' '|' | cut -c1-300)"
  evidence "diag: quarantine: $(xattr -l "$APPS/OMPdesk.app" 2>&1 | head -3 | tr '\n' '|')"
  # The relaunch as the swap script does it, by hand: its exit code and what the system says about the launch.
  open -n "$APPS/OMPdesk.app" --args --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-open.out" 2>&1; local rc=$?
  sleep 20
  evidence "diag: open -n exit $rc: $(head -c 400 "$W/$name-open.out" | tr '\n' '|'); running afterwards: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | head -1 | cut -c1-120)"
  log show --last 2m --predicate 'process == "syspolicyd" OR process == "amfid" OR process == "launchservicesd" OR process == "runningboardd"' --style compact 2>/dev/null | grep -i 'ompdesk\|reject\|deny\|kill' | tail -12 | cut -c1-260 | sed 's/^/EVIDENCE: diag system: /'
  kill_apps "$APPS/OMPdesk.app/Contents/MacOS"
  OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-direct.out" 2>&1 &
  sleep 25
  evidence "diag: started directly: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | head -1 | cut -c1-160); output: $(head -c 600 "$W/$name-direct.out" | tr '\n' '|')"
  crash_diag "$APPS/OMPdesk.app" "$W/$name-direct.out" "$UD"
}

# scenario <name> <0 success | 1 read-only apps folder | 2 shell start failure, launcher restores | 3 shell start failure,
# the v0.128.0 swap script restores .previous>
scenario() {
  local name=$1 fail=$2
  use_keychain "$name"
  local APPS=$W/$name/Applications UD=$W/$name/ud
  mkdir -p "$APPS" "$UD"; ditto rel.app "$APPS/OMPdesk.app"
  launchctl setenv OMP_GUI_TEST_USER_DATA_DIR "$UD"
  local OLDENV=(); [ "$fail" = 3 ] && OLDENV=(OMPDESK_SWAP_START_WAIT_S=20)
  if [ "$fail" = 2 ] || [ "$fail" = 3 ]; then
    # The swap script relaunches with `open -n`, which hands the new shell launchd's environment, not the old app's.
    launchctl setenv OMP_GUI_TEST_SHELL_FAIL_START 1
    launchctl setenv OMPDESK_LAUNCHER_RELEASE_URL "http://127.0.0.1:$HTTPPORT"
    launchctl setenv OMPDESK_LAUNCHER_START_WAIT_S 20
  fi
  step "$name: the released app seeds a token and Local Storage (its own IPC)"
  # No feed for this run: its updater would start a download that the clean-up below pulls the folder from under.
  OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:1" --ignore-certificate-errors >"$W/$name-seed.out" 2>&1 &
  (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $PORT) | tee "$W/$name-seed.json"; check ${PIPESTATUS[0]} "$name: seeded"
  kill_apps "$APPS/OMPdesk.app/Contents/MacOS"
  test -f "$UD/update-token.bin"; check $? "$name: update-token.bin is in the profile"
  rm -rf "$UD/logs" "$UD/updates"
  step "$name: the released app, left alone with its updater"
  env ${OLDENV[@]+"${OLDENV[@]}"} OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT "${SWITCHES[@]}" >"$W/$name-old.out" 2>&1 &
  wait_for "has_line $UD 'download verified'" 240; check $? "$name: check found, download verified"
  if [ "$fail" = 1 ]; then
    chmod -R a-w "$APPS"; evidence "S2 the apps folder is read-only before the countdown ends ($(stat -f %Sp "$APPS"))"
  fi
  wait_for "has_line $UD 'swap helper'" 300; check $? "$name: install auto, swap helper"
  update_lines "$UD" | sed 's/^/EVIDENCE: update log: /'
  if [ "$fail" = 2 ]; then
    wait_for "grep -q '^installed' $UD/updates/swap.log" 120; check $? "S3: the swap installed the shell bundle (swap.log installed)"
    wait_for "grep -q 'previous app restored\|restore failed' $UD/updates/swap.log" 300; check $? "S3: the launcher finished (swap.log)"
    evidence "S3 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-900)"
    for line in 'start failed' 'rollback: fetching' 'rollback: download ok' 'rollback: sha512 ok' 'rollback: verified' 'rollback: swapped' 'rollback: opened' 'start failed; previous app restored'; do
      grep -q "$line" "$UD/updates/swap.log"; check $? "S3: swap.log has \"$line\""
    done
    evidence "S3 launcher traffic: $(grep -c . "$W/feed.log") feed lines; http: $(grep http "$W/feed.log" | cut -c1-110 | tr '\n' '|')"
    sleep 5
    evidence "S3 restored bundle: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist"), shell binary present: $(ls "$APPS/OMPdesk.app/Contents/MacOS" | tr '\n' ' ')"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = "$ROLLBACK_VERSION" ] && [ ! -e "$APPS/OMPdesk.app/Contents/MacOS/ompdesk-shell" ]; check $? "S3: the last Electron release is back in place ($ROLLBACK_VERSION, no shell binary)"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S3: the restored app verifies"
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | sed 's/^/EVIDENCE: S3 update log: /'
    update_lines "$UD" | grep -Eq '^swap result (rolled back|changed)'; check $? "S3: the restored Electron logged swap result (rolled back/changed)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | grep -q .; check $? "S3: the Electron app is running"
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S3: no .updating or .previous leftovers"
    evidence "S3 shell started at all: $(ls "$UD/shell-webview" 2>&1 | tr '\n' ' ')"
  elif [ "$fail" = 3 ]; then
    wait_for "grep -q 'previous app restored\|previous app lost' $UD/updates/swap.log" 300; check $? "S4: the swap script finished (swap.log)"
    evidence "S4 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-900)"
    for line in '^installed' 'waiting for the new app to start' 'start failed; previous app restored'; do
      grep -q "$line" "$UD/updates/swap.log"; check $? "S4: swap.log has \"$line\""
    done
    grep -q 'rollback: download ok' "$UD/updates/swap.log"; [ $? != 0 ]; check $? "S4: the launcher downloaded nothing (the script owns the rollback)"
    sleep 5
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = $OLD_VERSION ] && [ ! -e "$APPS/OMPdesk.app/Contents/MacOS/ompdesk-shell" ]; check $? "S4: the old Electron app is back in place ($OLD_VERSION, no shell binary)"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S4: the restored app verifies"
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | sed 's/^/EVIDENCE: S4 update log: /'
    update_lines "$UD" | grep -Eq '^swap result (rolled back|changed)'; check $? "S4: the restored Electron logged swap result (rolled back/changed)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" | grep -v grep | grep -q .; check $? "S4: the Electron app is running"
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S4: no .updating or .previous leftovers"
  elif [ "$fail" = 0 ]; then
    wait_for "grep -q '^installed' $UD/updates/swap.log" 120; check $? "S1: swap.log says installed"
    evidence "S1 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-300)"
    wait_for "grep -q window.created $UD/shell-webview/shell.log.jsonl 2>/dev/null" 180; check $? "S1: the new shell started (window.created)"
    if ! grep -q window.created "$UD/shell-webview/shell.log.jsonl" 2>/dev/null; then relaunch_diag "$APPS" "$UD" "$name"; fi
    evidence "S1 shell command line: $(ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/" | grep -v grep | head -1 | cut -c1-260)"
    ps -axo command | grep "$APPS/OMPdesk.app/Contents/MacOS/" | grep -v grep | grep -q -- "--user-data-dir=$UD"; check $? "S1: the shell was started with Electron's argv (--user-data-dir)"
    grep -q '"migrate.localStorage"' "$UD/shell-webview/shell.log.jsonl"; check $? "S1: migrate.localStorage in the shell log"
    evidence "S1 shell log: $(grep -E 'migrate|cef.ready|window.created' "$UD/shell-webview/shell.log.jsonl" | cut -c1-200 | tr '\n' '|')"
    (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $PORT read) | tee "$W/$name-read.json"; check ${PIPESTATUS[0]} "S1: the shell's page answered"
    grep -q '"href":"app://ompdesk/' "$W/$name-read.json"; check $? "S1: the page loaded from app://ompdesk"
    grep -q '"draft":"a draft typed in Electron"' "$W/$name-read.json" && grep -q '"large":200000' "$W/$name-read.json"; check $? "S1: Local Storage reached the page"
    grep -q '"source":"stored"' "$W/$name-read.json" && grep -q '"droppedReason":null' "$W/$name-read.json"; check $? "S1: the seeded token was decrypted (source stored, none dropped)"
    wait_for "has_line $UD 'swap result'" 60; update_lines "$UD" | grep -q '^swap result installed'; check $? "S1: swap result outcome installed"
    codesign --verify --deep --strict "$APPS/OMPdesk.app"; check $? "S1: the installed app verifies"
    [ "$(xattr -lr "$APPS/OMPdesk.app" 2>/dev/null | grep -c com.apple.quarantine)" = 0 ]; check $? "S1: the moved bundle and everything in it carries no com.apple.quarantine (the swap's xattr -dr covers it)"
    evidence "S1 spctl: $(spctl --assess -vv --type execute "$APPS/OMPdesk.app" 2>&1 | tr '\n' ' ') (no spctl rule)"
    if [ "$SOURCE_TAG" = v0.128.0 ]; then
      wait_for "grep -q '^started' $UD/updates/swap.log" 180; check $? "S1: the start-checked script saw app-started.json for the new version (swap.log started)"
      evidence "S1 app-started.json: $(cat "$UD/app-started.json" 2>&1 | cut -c1-120)"
      ls "$APPS" | grep -q 'previous'; [ $? != 0 ]; check $? "S1: .previous is gone once the new app proved it started"
    fi
    evidence "S1 installed bundle: $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist") ($(codesign -d -r- "$APPS/OMPdesk.app" 2>&1 | sed -n 's/^designated => //p'))"
  else
    wait_for "grep -q 'copy failed\|install failed\|cannot move' $UD/updates/swap.log 2>/dev/null" 120; check $? "S2: the swap failed (swap.log)"
    evidence "S2 swap.log: $(tr '\n' '|' < "$UD/updates/swap.log" | cut -c1-300)"
    sleep 5
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPS/OMPdesk.app/Contents/Info.plist")" = $OLD_VERSION ]; check $? "S2: the Electron app is untouched (the old version)"
    ls "$APPS" | grep -q 'updating\|previous'; [ $? != 0 ]; check $? "S2: no .updating or .previous leftovers"
    kill_apps "$APPS/OMPdesk.app/Contents/MacOS"
    chmod -R u+w "$APPS"
    # The next launch, as a person's: the released app reports the failed move.
    OMP_GUI_TEST_USER_DATA_DIR=$UD "$APPS/OMPdesk.app/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=$PORT --host-resolver-rules="MAP api.github.com 127.0.0.1:1" --ignore-certificate-errors >"$W/$name-again.out" 2>&1 &
    wait_for "has_line $UD 'swap result'" 120; update_lines "$UD" | grep -q '^swap result rolled back'; check $? "S2: swap result outcome rolled back"
  fi
  evidence "$name feed log: $(tail -n 6 "$W/feed.log" | cut -c1-120 | tr '\n' '|')"
  dialogs; check $? "$name: no dialog (SecurityAgent) line"
  kill_apps "$APPS/OMPdesk.app/Contents/MacOS"; pkill -f "$W/$name" 2>/dev/null
  for v in OMP_GUI_TEST_SHELL_FAIL_START OMPDESK_LAUNCHER_RELEASE_URL OMPDESK_LAUNCHER_START_WAIT_S; do launchctl unsetenv $v; done
  restore
}
scenario s1 0
if [ "$SOURCE_TAG" = v0.128.0 ]; then
  scenario s4 3
else
  scenario s3 2
  scenario s2 1
fi
dialog_evidence
security delete-keychain "$KC0" 2>/dev/null
exit $FAILED
