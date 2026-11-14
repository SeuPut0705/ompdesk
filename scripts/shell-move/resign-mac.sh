#!/bin/bash
# (ported from batch P) resign-mac.sh <App.app> <keychain> <identity sha1>: re-sign every Mach-O and nested bundle inside-out with one
# certificate, keeping each component's entitlements; the main bundle gets the release's form of designated
# requirement (identifier + certificate root), as scripts/mac-sign.cjs produces it.
set -euo pipefail
APP="$1"; KC="$2"; ID="$3"
sign() {
  local p="$1"; shift
  local ent=() tmp; tmp=$(mktemp)
  if codesign -d --entitlements - --xml "$p" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then ent=(--entitlements "$tmp"); fi
  codesign --force --keychain "$KC" --sign "$ID" --options runtime --timestamp=none ${ent[@]+"${ent[@]}"} "$@" "$p"
}
find "$APP/Contents" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.node' \) | awk '{print length, $0}' | sort -rn | cut -d' ' -f2- | while read -r f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  sign "$f" >/dev/null 2>&1 || echo "sign failed: $f"
done
find "$APP/Contents" -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) | awk '{print length, $0}' | sort -rn | cut -d' ' -f2- | while read -r b; do
  sign "$b" >/dev/null 2>&1 || echo "sign failed: $b"
done
BID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")
sign "$APP" -r="designated => identifier \"$BID\" and certificate root = H\"$(echo "$ID" | tr A-F a-f)\""
codesign --verify --deep --strict "$APP"
echo "signed: $APP cdhash=$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p' | head -1)"
