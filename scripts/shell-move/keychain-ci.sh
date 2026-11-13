#!/bin/bash
# keychain-ci.sh: S's macOS keychain gate (native-rust ledger › S › The keychain on macOS), against the REAL shell bundle, on
# a throwaway GitHub macOS runner only (shell-batch-checks.yml: macos-15 and macos-26; macOS 27 has no hosted runner, so it
# is not covered). A keychain dialog must never appear on a person's screen, and none may appear here: every scenario fails on
# any SecurityAgent or coreauthd line in the system log. Runs in the runner's login keychain slot (a fresh keychain made
# the default for each scenario, so the item's access list is the one a real user's has; a test HOME would add a partition
# entry), and restores the runner's default keychain after each.
#
# Throwaway: a self-signed certificate; the released v0.127.0 Electron app re-signed with it as com.seuput.ompdesk with the
# release's form of designated requirement (`identifier … and certificate root = H"…"`, resign-mac.sh) or ad hoc; the shell
# bundle built by scripts/package-mac.ts and signed with the same certificate.
#   A. the real users' path: a release-signed Electron creates "ompdesk Safe Storage" and encrypts a stand-in token (through its
#      own IPC); the shell, signed with the same certificate, decrypts it via `--keychain-key`, and its page reads it.
#   B. an ad-hoc item (a development machine): the same Electron signed ad hoc creates the item; `--keychain-key` answers
#      {"unavailable":"keychain-would-ask"} within its time with no dialog line.
#   C. a profile without ciphertext: the shell starts and the keychain is never read (no `--keychain-key` process ever runs,
#      sampled every 0.2 s, and no item exists afterwards).
# Evidence lines start with "EVIDENCE:" for the ledger. Exit 1 on any failed check.
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
. "$HERE/mac-common.sh"

step "control: a prompt-free keychain read"
control_chatter

step "the shell bundle (scripts/package-mac.ts, signed with the throwaway identity)"
(cd "$REPO" && bun scripts/package-mac.ts --no-dmg --version 0.200.0 --sign-with "$ID" --keychain "$KC0"); check $? "package-mac built and signed OMPdesk.app"
SHELL_APP=$REPO/dist/mac-arm64/OMPdesk.app
codesign --verify --deep --strict "$SHELL_APP"; check $? "codesign --verify --deep --strict on the shell bundle"
evidence "shell bundle designated requirement: $(codesign -d -r- "$SHELL_APP" 2>&1 | sed -n 's/^designated => //p')"

step "the released app v0.127.0"
curl -sSL -o rel.dmg https://github.com/SeuPut0705/ompdesk/releases/download/v0.127.0/ompdesk-mac-arm64.dmg
mkdir mnt && hdiutil attach -nobrowse -readonly -noautoopen -mountpoint mnt rel.dmg >/dev/null && ditto mnt/OMPdesk.app rel.app && hdiutil detach mnt >/dev/null
ditto rel.app adhoc.app
bash "$HERE/resign-mac.sh" rel.app "$KC0" "$ID" | tail -1
codesign --force --deep -s - adhoc.app >/dev/null 2>&1; codesign --verify --deep adhoc.app; check $? "the ad-hoc copy of the released app is signed (codesign -s -)"
evidence "release-form requirement of the released app: $(codesign -d -r- rel.app 2>&1 | sed -n 's/^designated => //p')"
start_feed 18443 "$W/rel.dmg"
SWITCHES=(--host-resolver-rules="MAP api.github.com 127.0.0.1:18443" --ignore-certificate-errors)

# The released app is NOT headless here: OMP_GUI_HEADLESS makes its Chromium use a mock keychain (index.ts), so it would never
# create or read "ompdesk Safe Storage"; the real users' path has no such variable. (A window appears on the throwaway runner.)
seed_with() { # seed_with <app> <userData> <port>: the released app saves a token and Local Storage, then quits
  OMP_GUI_TEST_USER_DATA_DIR=$2 "$1/Contents/MacOS/OMPdesk" --user-data-dir="$2" --remote-debugging-port=$3 "${SWITCHES[@]}" >"$W/seed-$3.out" 2>&1 &
  (cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts $3) | tee "$W/seed-$3.json"; local rc=${PIPESTATUS[0]}
  kill_apps "$1/Contents/MacOS"; return $rc
}

step "A. a release-signed item, read by the shell signed with the same certificate"
use_keychain a; UD=$W/ud-a; mkdir -p "$UD"
seed_with rel.app "$UD" 19222; check $? "the release-signed Electron seeded a token and Local Storage"
item_exists; check $? "it created \"ompdesk Safe Storage\" in the (default, login-slot) keychain"
evidence "A item access: $(item_acl | tr '\n' ' ')"
test -f "$UD/update-token.bin"; check $? "update-token.bin (safeStorage ciphertext) is in the profile"
START=$(date +%s)
limit 60 "$SHELL_APP/Contents/MacOS/OMPdesk" --keychain-key "$UD" 2>/dev/null > "$W/key-a.json"
evidence "A --keychain-key answered in $(( $(date +%s) - START )) s: $(sed 's/"password":"[^"]*"/"password":"<hidden>"/' "$W/key-a.json")"
grep -q '"kind":"mac-v10"' "$W/key-a.json"; check $? "A: the shell's --keychain-key answered a mac-v10 key, no dialog"
OMP_GUI_TEST_USER_DATA_DIR=$UD "$SHELL_APP/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=19223 >"$W/shell-a.out" 2>&1 &
sleep 10; evidence "A: helper processes (which name CEF started): $(ps -axo command | grep 'Frameworks/.*Helper' | grep -v grep | sed 's/ --.*//' | sort -u | cut -c1-220 | tr '\n' '|')"
(cd "$REPO" && limit 120 bun scripts/shell-move/cdp-seed-mac.ts 19223 read) | tee "$W/read-a.json"; check ${PIPESTATUS[0]} "A: the shell's page answered"
kill_apps "$SHELL_APP/Contents/MacOS"
grep -q '"draft":"a draft typed in Electron"' "$W/read-a.json" && grep -q '"large":200000' "$W/read-a.json"; check $? "A: Local Storage came over (draft, Korean, 200 000 characters)"
grep -q '"source":"stored"' "$W/read-a.json" && grep -q '"droppedReason":null' "$W/read-a.json"; check $? "A: the shell decrypted the stand-in token (the token resolves from the stored file: source "stored", none dropped)"
evidence "A page: $(cut -c1-400 "$W/read-a.json")"
grep -q '"source":"stored"' "$W/read-a.json" || crash_diag "$SHELL_APP" "$W/shell-a.out" "$UD"
dialogs; check $? "A: no dialog (SecurityAgent) line"
restore

step "B. an ad-hoc item (development machine): the shell never asks"
use_keychain b; UD=$W/ud-b; mkdir -p "$UD"
seed_with adhoc.app "$UD" 19224; check $? "the ad-hoc Electron seeded a token"
item_exists; check $? "it created \"ompdesk Safe Storage\""
evidence "B item access: $(item_acl | tr '\n' ' ')"
START=$(date +%s)
limit 60 "$SHELL_APP/Contents/MacOS/OMPdesk" --keychain-key "$UD" 2>/dev/null > "$W/key-b.json"; EL=$(( $(date +%s) - START ))
evidence "B --keychain-key answered in ${EL} s: $(sed 's/"password":"[^"]*"/"password":"<hidden>"/' "$W/key-b.json")"
grep -q '"unavailable":"keychain-would-ask"' "$W/key-b.json" && [ "$EL" -lt 30 ]; check $? "B: {unavailable: keychain-would-ask} within its time"
dialogs; check $? "B: no dialog (SecurityAgent) line"
restore

step "C. a profile without ciphertext never reads the keychain"
use_keychain c; UD=$W/ud-c; mkdir -p "$UD"
( while true; do ps -axo command | grep -- '--keychain-key' | grep -v grep >> "$W/keychain-runs.txt"; sleep 0.2; done ) & SAMPLER=$!
OMP_GUI_TEST_USER_DATA_DIR=$UD "$SHELL_APP/Contents/MacOS/OMPdesk" --user-data-dir="$UD" --remote-debugging-port=19225 >"$W/shell-c.out" 2>&1 &
sleep 30; kill_apps "$SHELL_APP/Contents/MacOS"; kill $SAMPLER 2>/dev/null
grep -q cef.ready "$UD/shell-webview/shell.log.jsonl"; check $? "C: the shell started on the profile without ciphertext (cef.ready)"
[ ! -s "$W/keychain-runs.txt" ]; check $? "C: no --keychain-key process ran"
item_exists; [ $? != 0 ]; check $? "C: no \"ompdesk Safe Storage\" item was created or touched"
evidence "C shell log: $(grep -c . "$UD/shell-webview/shell.log.jsonl") lines, keychain runs sampled: $(wc -l < "$W/keychain-runs.txt" | tr -d ' ')"
dialogs; check $? "C: no dialog (SecurityAgent) line"
restore

kill $WATCH $FEED 2>/dev/null
step "security dialogs logged"; grep -v -E '^(Filtering|Timestamp)' "$W/dialogs.log" | head -20
dialog_evidence
security delete-keychain "$KC0" 2>/dev/null
exit $FAILED
