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
dialogs() { [ "$(grep -c -v -E '^(Filtering|Timestamp)' "$W/dialogs.log")" = 0 ]; }

# A fresh keychain as the default (the login keychain's slot); `restore` puts the runner's own back.
use_keychain() {
  KC=$W/$1.keychain-db
  security create-keychain -p $PW "$KC" && security unlock-keychain -p $PW "$KC" && security set-keychain-settings "$KC"
  security default-keychain -d user -s "$KC"; security list-keychains -d user -s "$KC" "$KC0" $ORIG_LIST
}
restore() { security default-keychain -d user -s "$ORIG_DEFAULT"; security list-keychains -d user -s "$KC0" $ORIG_LIST; }
item_exists() { security dump-keychain "$KC" 2>/dev/null | grep -q 'ompdesk Safe Storage'; }
item_acl() { security dump-keychain -a "$KC" 2>/dev/null | awk '/ompdesk Safe Storage/{f=1} f' | sed -n '1,40p' | grep -E 'description: cdhash|requirement|authorizations' | head -5; }
kill_apps() { pkill -f "$1" 2>/dev/null; sleep 3; }

