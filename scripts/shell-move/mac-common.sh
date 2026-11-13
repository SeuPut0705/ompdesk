#!/bin/bash
# mac-common.sh: what the macOS runner checks share (sourced by keychain-ci.sh and move-mac.sh, after they set HERE and
# REPO): a work folder, a signing keychain with a throwaway self-signed identity, a log watch for SecurityAgent and
# coreauthd (a keychain dialog must never appear, on a runner or anywhere), and a fresh default keychain per scenario
# that `restore` gives back to the runner's own. Runner only: never a person's Mac.
set -u
W=${RUNNER_TEMP:-/tmp}/kc; rm -rf "$W"; mkdir -p "$W"; cd "$W"
PW=move; FAILED=0
step() { echo; echo "=== $*"; }
check() { if [ "$1" = 0 ]; then echo "ok: $2"; else echo "FAILED: $2"; FAILED=1; fi; }
evidence() { echo "EVIDENCE: $*"; }
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }
OS=$(sw_vers -productVersion)
ORIG_DEFAULT=$(security default-keychain -d user | sed 's/^[ ]*"//; s/"$//'); ORIG_LIST=$(security list-keychains -d user | sed 's/^[ ]*"//; s/"$//' | tr '\n' ' ')

# Signing keychain: holds the identity every codesign below uses.
KC0=$W/sign.keychain-db
security create-keychain -p $PW "$KC0" && security unlock-keychain -p $PW "$KC0" && security set-keychain-settings "$KC0"
printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=OMPdesk Move Check Throwaway\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' > cs.cnf
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -config cs.cnf 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -out id.p12 -passout pass:$PW -name throwaway
security import id.p12 -k "$KC0" -P $PW -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $PW "$KC0" >/dev/null
ID=$(/usr/bin/openssl x509 -in cert.pem -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')
security list-keychains -d user -s "$KC0" $ORIG_LIST   # codesign finds the identity; the default stays the runner's
evidence "macOS $OS, throwaway identity $ID"

log stream --style compact --predicate 'process == "SecurityAgent" OR process == "coreauthd"' > "$W/dialogs.log" 2>&1 & WATCH=$!
# A dialog is a SecurityAgent line (it is the process that draws the keychain and credential prompts) or a coreauthd line that
# presents or asks (uiDelegate set, "present", "prompt", "dialog", "alert"). coreauthd's other chatter (a LocalAuthentication
# context created and "Skipping processing of request" for a policy no biometry hardware answers) is what any keychain access
# on a hosted runner logs: it is counted and printed as evidence, not failed on.
dialog_lines() { grep -v -E '^(Filtering|Timestamp)' "$W/dialogs.log" | grep -E 'SecurityAgent|coreauthd.*(uiDelegate:[1-9a-zA-Z<]|[Pp]resenting|[Pp]rompt|[Dd]ialog|[Aa]lert)' | grep -v 'uiDelegate:0'; }
dialogs() {
  evidence "log so far: $(grep -c -v -E '^(Filtering|Timestamp)' "$W/dialogs.log") SecurityAgent/coreauthd lines ('Skipping processing of request': $(grep -c 'Skipping processing of request' "$W/dialogs.log")), dialog lines: $(dialog_lines | wc -l | tr -d ' ')"
  [ "$(dialog_lines | wc -l | tr -d ' ')" = 0 ]
}
dialog_evidence() { evidence "dialog lines (SecurityAgent, or coreauthd presenting/asking): $(dialog_lines | wc -l | tr -d ' '); all SecurityAgent/coreauthd lines logged: $(grep -c -v -E '^(Filtering|Timestamp)' "$W/dialogs.log")"; dialog_lines | head -10; }

# A fresh keychain as the default (the login keychain's slot); `restore` puts the runner's own back.
use_keychain() {
  KC=$W/$1.keychain-db
  security create-keychain -p $PW "$KC" && security unlock-keychain -p $PW "$KC" && security set-keychain-settings "$KC"
  security default-keychain -d user -s "$KC"; security list-keychains -d user -s "$KC" "$KC0" $ORIG_LIST
}
# The control that makes the coreauthd rule provable: a keychain access that cannot raise a prompt (an item this job made, in
# the keychain it made, read by the `security` tool that created it, whose ACL names it) is run first; the coreauthd lines it
# logs are the runner's background chatter ("Skipping processing of request"), so the same lines in a scenario are not a dialog.
control_chatter() {
  security add-generic-password -a control -s ompdesk-control -w control -T /usr/bin/security -U "$KC0" >/dev/null 2>&1
  security unlock-keychain -p $PW "$KC0" >/dev/null 2>&1
  local before after; before=$(grep -c -v -E '^(Filtering|Timestamp)' "$W/dialogs.log")
  security find-generic-password -s ompdesk-control -w "$KC0" >/dev/null 2>&1; local rc=$?
  sleep 3; after=$(grep -c -v -E '^(Filtering|Timestamp)' "$W/dialogs.log")
  evidence "control: a prompt-free keychain read (security find-generic-password, exit $rc) logged $((after - before)) SecurityAgent/coreauthd lines; 'Skipping processing of request' among them: $(grep -c 'Skipping processing of request' "$W/dialogs.log"); dialog lines: $(dialog_lines | wc -l | tr -d ' ')"
  grep 'coreauthd' "$W/dialogs.log" | head -3 | cut -c1-200 | sed 's/^/EVIDENCE: control line: /'
  security delete-generic-password -s ompdesk-control "$KC0" >/dev/null 2>&1
}
# The item is looked up through the search list (where Chromium puts it is the default keychain of the user session: the one
# `use_keychain` made, or, if the session ignored that, the runner's login keychain); `item_where` says which. `restore` removes
# it from wherever it went, so the next scenario starts with none (the runner is throwaway).
restore() { security delete-generic-password -s "ompdesk Safe Storage" >/dev/null 2>&1; security delete-generic-password -s "ompdesk Safe Storage" >/dev/null 2>&1; security default-keychain -d user -s "$ORIG_DEFAULT"; security list-keychains -d user -s "$KC0" $ORIG_LIST; }
item_exists() { security find-generic-password -s "ompdesk Safe Storage" >/dev/null 2>&1; }
item_where() { security find-generic-password -s "ompdesk Safe Storage" 2>&1 | sed -n 's/^keychain: //p'; }
item_acl() { echo "keychain $(item_where)"; security dump-keychain -a 2>/dev/null | awk '/ompdesk Safe Storage/{f=1} f' | sed -n '1,40p' | grep -E 'description: cdhash|requirement|authorizations' | head -5; }
kill_apps() { pkill -f "$1" 2>/dev/null; sleep 3; }

# start_feed <port> <asset> [more feed.ts arguments]: the stand-in api.github.com (feed.ts, --platform mac) on
# 127.0.0.1:<port>, proven to answer.
start_feed() {
  local port=$1 asset=$2; shift 2
  (cd "$REPO" && bun scripts/shell-move/feed.ts --setup "$asset" --platform mac --version 0.200.0 --cert-dir "$W/cert" --port "$port" "$@" >"$W/feed.log" 2>&1) & FEED=$!
  sleep 4
  curl -sk --resolve "api.github.com:$port:127.0.0.1" "https://api.github.com:$port/repos/SeuPut0705/ompdesk" | grep -q full_name
  check $? "the stand-in feed answers the repository probe on :$port"
  head -3 "$W/feed.log"
}

# crash_diag <app> <out file> <userData>: why a bundle's process died (a trap, a signal): its output, the shell's log, the
# crash report the system wrote and the signatures of the launcher and the shell.
crash_diag() {
  local app=$1 out=$2 ud=$3
  evidence "diag: output: $(head -c 700 "$out" 2>&1 | tr '\n' '|')"
  evidence "diag: shell log tail: $(tail -n 6 "$ud/shell-webview/shell.log.jsonl" 2>&1 | cut -c1-220 | tr '\n' '|')"
  for f in "$app/Contents/MacOS/OMPdesk" "$app/Contents/MacOS/ompdesk-shell"; do
    evidence "diag: $(basename "$f"): $(codesign -dvv "$f" 2>&1 | grep -E 'Identifier|flags|Authority|TeamIdentifier|Signature' | tr '\n' ' ' | cut -c1-330)"
  done
  sleep 3
  for r in $(ls -t ~/Library/Logs/DiagnosticReports/*mpdesk* 2>/dev/null | head -1); do
    evidence "diag: crash report $(basename "$r")"
    grep -E '"(exception|signal|termination|codeSigningID|procPath)"|Exception Type|Termination|Triggered by|dyld|Library not loaded|Symbol not found' "$r" | head -14 | cut -c1-300 | sed 's/^/EVIDENCE: diag crash: /'
  done
}
