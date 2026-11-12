#!/bin/bash
# keychain-ci.sh: the macOS keychain half of the update move, on a throwaway GitHub macOS runner (it can raise a
# keychain dialog, which must never happen on a person's screen). Throwaway: a temp keychain made the runner's default,
# a throwaway self-signed certificate, the released v0.127.0 app re-signed with it as com.seuput.ompdesk.
#  1. the released app's own binary and identity (app.asar swapped for seed-profile.cjs) encrypts a stand-in token
#     with safeStorage: Chromium creates "ompdesk Safe Storage" in the default keychain; its ACL is printed;
#  2. the same bundle reads it back (control);
#  3. the same bundle re-signed after a resource change (what the next release is) reads it;
#  4. the candidate's reader (migrate-check, the code shell-cef runs; signed com.seuput.ompdesk, same certificate);
#  5. 4 again after the item's partition list also names the reader's cdhash (needs the keychain password).
# A read that would show a dialog fails here with a timeout or errSecInteractionNotAllowed; SecurityAgent is logged.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); PROTO=$(dirname "$HERE")
W=${RUNNER_TEMP:-/tmp}/kc; rm -rf "$W"; mkdir -p "$W"; cd "$W"
KC=$W/proto.keychain-db; PW=proto
step() { echo; echo "=== $*"; }
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }
step keychain
security create-keychain -p $PW "$KC" && security unlock-keychain -p $PW "$KC" && security set-keychain-settings "$KC"
security list-keychains -d user -s "$KC" && security default-keychain -d user -s "$KC"
security default-keychain; security list-keychains
step certificate
printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=OMPdesk Shell Prototype Throwaway\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' > cs.cnf
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -config cs.cnf 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -out id.p12 -passout pass:$PW -name throwaway
security import id.p12 -k "$KC" -P $PW -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k $PW "$KC" >/dev/null
ID=$(/usr/bin/openssl x509 -in cert.pem -noout -fingerprint -sha1 | sed 's/.*=//; s/://g'); echo "identity $ID"
log stream --style compact --predicate 'process == "SecurityAgent" OR process == "coreauthd"' > "$W/dialogs.log" 2>&1 & WATCH=$!
step "released app v0.127.0"
curl -sSL -o rel.dmg https://github.com/SeuPut0705/ompdesk/releases/download/v0.127.0/ompdesk-mac-arm64.dmg
mkdir mnt && hdiutil attach -nobrowse -readonly -noautoopen -mountpoint mnt rel.dmg >/dev/null && ditto mnt/OMPdesk.app rel.app && hdiutil detach mnt >/dev/null
mkseed() { # mkseed <dir> <marker>: the release's bundle with app.asar swapped for the seed script, re-signed
  rm -rf "$1"; mkdir -p "$1"; ditto rel.app "$1/OMPdesk.app"; local r="$1/OMPdesk.app/Contents/Resources"
  rm -f "$r/app.asar"; mkdir -p "$r/app"; cp "$HERE/seed-profile.cjs" "$r/app/main.cjs"
  echo '{"name":"ompdesk","main":"main.cjs"}' > "$r/app/package.json"; echo "$2" > "$r/app/release.txt"
  "$HERE/resign-mac.sh" "$1/OMPdesk.app" "$KC" "$ID" | tail -1
}
mkseed s1 one
UD=$W/ud
step "1. the Electron copy encrypts a stand-in token (creates the item)"
limit 90 s1/OMPdesk.app/Contents/MacOS/OMPdesk --user-data-dir=$UD 2>/dev/null | grep userData
security dump-keychain -a "$KC" | awk '/ompdesk Safe Storage/{f=1} f' | sed -n '1,45p' | grep -E 'entry|authorizations|description|requirement|applications|/'
step "2. the same bundle reads it back"
SEED_READ=1 limit 60 s1/OMPdesk.app/Contents/MacOS/OMPdesk --user-data-dir=$UD 2>/dev/null | grep read || echo "read: timed out (a dialog would have asked)"
step "3. the next release: same identity, one resource changed, re-signed"
mkseed s2 two
SEED_READ=1 limit 60 s2/OMPdesk.app/Contents/MacOS/OMPdesk --user-data-dir=$UD 2>/dev/null | grep read || echo "read: timed out (a dialog would have asked)"
step "4. the candidate's reader (shell-migrate, as shell-cef links it), signed com.seuput.ompdesk"
cargo build --release --manifest-path "$PROTO/migrate/Cargo.toml" -q 2>&1 | tail -3
cp "$PROTO/migrate/target/release/migrate-check" mc
codesign --force --keychain "$KC" --sign "$ID" --options runtime --timestamp=none -i com.seuput.ompdesk -r="designated => identifier \"com.seuput.ompdesk\" and certificate root = H\"$(echo $ID | tr A-F a-f)\"" mc
codesign -dr - mc 2>&1 | tail -1; MC=$(codesign -dvvv mc 2>&1 | sed -n 's/^CDHash=//p' | head -1); echo "reader cdhash $MC"
OMPDESK_PROTO_KEYCHAIN_OK=1 limit 60 ./mc "$UD" "$W/wv" | grep migrate.token || echo "migrate.token: timed out (a dialog would have asked)"
step "5. the item's partition list also names the reader (security, with the keychain password)"
P1=$(security dump-keychain -a "$KC" | awk '/ompdesk Safe Storage/{f=1} f' | sed -n 's/.*description: \(cdhash:[0-9a-f]*\).*/\1/p' | head -1)
security set-generic-password-partition-list -S "apple-tool:,apple:,$P1,cdhash:$MC" -k $PW -s "ompdesk Safe Storage" "$KC" >/dev/null && echo "partition list now: apple-tool:,apple:,$P1,cdhash:$MC"
rm -rf "$W/wv"; OMPDESK_PROTO_KEYCHAIN_OK=1 limit 60 ./mc "$UD" "$W/wv" | grep migrate.token || echo "migrate.token: timed out (a dialog would have asked)"
step "6. as on the developer's Mac: a keychain reached through a test HOME (the item's ACL only, no read)"
H2=$W/home2; mkdir -p "$H2/Library/Keychains"; KC2=$H2/Library/Keychains/proto.keychain-db
HOME=$H2 security create-keychain -p $PW "$KC2" && HOME=$H2 security unlock-keychain -p $PW "$KC2" && HOME=$H2 security set-keychain-settings "$KC2"
ln -s proto.keychain-db "$H2/Library/Keychains/login.keychain-db"; HOME=$H2 security default-keychain
env -i HOME=$H2 PATH=/usr/bin:/bin limit 90 s1/OMPdesk.app/Contents/MacOS/OMPdesk --user-data-dir=$W/ud2 2>/dev/null | grep userData
HOME=$H2 security dump-keychain -a "$KC2" | awk '/ompdesk Safe Storage/{f=1} f' | sed -n '1,45p' | grep -E 'authorizations|description: cdhash|requirement'
kill $WATCH 2>/dev/null
step "security dialogs logged"
grep -v -E '^(Filtering|Timestamp)' "$W/dialogs.log" | head -20; echo "lines: $(grep -c -v -E '^(Filtering|Timestamp)' "$W/dialogs.log")"
echo; echo "expected stand-in sha256_8: $(printf %s ghp_STANDIN_not_a_real_token_0123456789 | shasum -a 256 | cut -c1-8)"
