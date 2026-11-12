#!/usr/bin/env bash
# Run on the Mac (Apple silicon). Downloads CEF (macosarm64), builds shell-cef + preview-host, assembles and signs
#   target/mac/OMPdesk.app   and   target/mac/OMPdesk Preview.app
# env: BUNDLE_ID (com.seuput.ompdesk.proto) BUNDLE_VERSION (0.200.0) SIGN_IDENTITY ('-' = ad-hoc) RENDERER_DIR
# UNVERIFIED: written without a Mac; see MACOS.md.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
BUNDLE_ID="${BUNDLE_ID:-com.seuput.ompdesk.proto}"
BUNDLE_VERSION="${BUNDLE_VERSION:-0.200.0}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
RENDERER_DIR="${RENDERER_DIR:-$ROOT/../../../out/renderer}"
ASSETS_DIR="${ASSETS_DIR:-$ROOT/../shell-assets}"
CEF_VER="156.0.26"                       # = the cef crate 156.4.0+156.0.26
export CEF_PATH="$ROOT/cef-bin"
for t in cargo cmake ninja python3 curl codesign; do command -v "$t" >/dev/null || { echo "missing: $t (brew install cmake ninja; xcode-select --install; rustup)"; exit 1; }; done
[ -d "$RENDERER_DIR" ] || { echo "no renderer at $RENDERER_DIR (bun run build first, or set RENDERER_DIR)"; exit 1; }

# 1. CEF binary distribution. cef-dll-sys' build script reads CEF's 10 MB index.json through ureq (10 MiB body limit), which
#    fails; so fetch the minimal archive by hand and serve a trimmed index.json + the archive from localhost (CEF_DOWNLOAD_URL).
if ! ls "$CEF_PATH/$CEF_VER"/*/archive.json >/dev/null 2>&1; then
  mkdir -p dl && (cd dl
    curl -sL -o index_full.json https://cef-builds.spotifycdn.com/index.json
    python3 - "$CEF_VER" <<'PY'
import json, sys, urllib.parse, subprocess, os
d = json.load(open('index_full.json'))
v = [x for x in d['macosarm64']['versions'] if x['cef_version'].startswith(sys.argv[1] + '+')]
assert v, 'CEF version not in the index'
f = next(x for x in v[0]['files'] if x['type'] == 'minimal')
out = {k: {'versions': []} for k in d}
out['macosarm64']['versions'] = v
json.dump(out, open('index.json', 'w'))
if not os.path.exists(f['name']):
    subprocess.check_call(['curl', '-L', '-o', f['name'], 'https://cef-builds.spotifycdn.com/' + urllib.parse.quote(f['name'])])
PY
  )
  python3 -m http.server 8123 --bind 127.0.0.1 --directory dl >/dev/null 2>&1 &
  SERVER=$!; trap 'kill $SERVER 2>/dev/null || true' EXIT
  sleep 1
  export CEF_DOWNLOAD_URL=http://127.0.0.1:8123
fi

# 2. build (workspace members parent-window is Windows-only: build the two packages)
cargo build --release -p shell-cef -p preview-host
FW="$(find "$CEF_PATH" -maxdepth 4 -name 'Chromium Embedded Framework.framework' -type d | head -1)"
[ -n "$FW" ] || { echo "CEF framework not found under $CEF_PATH"; exit 1; }

OUT="$ROOT/target/mac"
rm -rf "$OUT" && mkdir -p "$OUT"

plist() { # plist <path> <executable> <identifier> <name> <helper:0|1> <urltypes:0|1>
  local url=""
  if [ "$6" = 1 ]; then url='<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>ompdesk-proto</string><key>CFBundleURLSchemes</key><array><string>ompdesk-proto</string></array></dict></array>'; fi
  local ui=""; if [ "$5" = 1 ]; then ui='<key>LSUIElement</key><string>1</string>'; fi
  cat > "$1" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>$2</string>
<key>CFBundleIdentifier</key><string>$3</string>
<key>CFBundleName</key><string>$4</string>
<key>CFBundleDisplayName</key><string>$4</string>
<key>CFBundleShortVersionString</key><string>$BUNDLE_VERSION</string>
<key>CFBundleVersion</key><string>$BUNDLE_VERSION</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleSignature</key><string>????</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSSupportsAutomaticGraphicsSwitching</key><true/>
<key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
$ui
$url
</dict></plist>
PL
}

assemble() { # assemble <AppName> <binary> <bundle id> <with renderer+assets 0|1> <urltypes 0|1>
  local name="$1" bin="$2" id="$3"
  local app="$OUT/$name.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
  cp "$bin" "$app/Contents/MacOS/$name"
  plist "$app/Contents/Info.plist" "$name" "$id" "$name" 0 "$5"
  cp -R "$FW" "$app/Contents/Frameworks/"
  # keep English and Korean only
  find "$app/Contents/Frameworks/Chromium Embedded Framework.framework/Resources" -maxdepth 1 -name '*.lproj' ! -name 'en.lproj' ! -name 'ko.lproj' -exec rm -rf {} +
  if [ "$4" = 1 ]; then
    cp -R "$RENDERER_DIR" "$app/Contents/Resources/renderer"
    cp -R "$ASSETS_DIR" "$app/Contents/Resources/shell-assets"
  fi
  # helpers: the same binary (it loads the framework three levels up when started with --type=...)
  for h in "Helper" "Helper (GPU)" "Helper (Renderer)" "Helper (Plugin)" "Helper (Alerts)"; do
    local hn="$name $h" hid="$id.helper"
    case "$h" in *"("*) hid="$id.helper.$(echo "$h" | sed 's/.*(\(.*\))/\1/')";; esac
    local happ="$app/Contents/Frameworks/$hn.app"
    mkdir -p "$happ/Contents/MacOS"
    cp "$bin" "$happ/Contents/MacOS/$hn"
    plist "$happ/Contents/Info.plist" "$hn" "$hid" "$hn" 1 0
  done
  # sign inside-out (framework libraries, framework, helpers, app)
  local sign=(codesign --force --options runtime --timestamp=none --entitlements "$ROOT/entitlements.plist" --sign "$SIGN_IDENTITY")
  local fw="$app/Contents/Frameworks/Chromium Embedded Framework.framework"
  find "$fw/Libraries" -name '*.dylib' -exec "${sign[@]}" {} \; 2>/dev/null || true
  "${sign[@]}" "$fw"
  for happ in "$app/Contents/Frameworks/"*.app; do "${sign[@]}" "$happ"; done
  "${sign[@]}" "$app"
  codesign --verify --deep --strict "$app" && echo "signed: $app"
}

assemble "OMPdesk" "$ROOT/target/release/shell-cef" "$BUNDLE_ID" 1 1
assemble "OMPdesk Preview" "$ROOT/target/release/preview-host" "$BUNDLE_ID.preview" 0 0

cat <<MSG

built: $OUT/OMPdesk.app  and  $OUT/OMPdesk Preview.app
register the scheme with Launch Services:  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$OUT/OMPdesk.app"
run (self-test):   "$OUT/OMPdesk.app/Contents/MacOS/OMPdesk" --selftest --preview app://ompdesk/__shell/preview-test.html --debug-port 9301 --exit-after 60 --log /tmp/shell-cef.log.jsonl
deep link:         open 'ompdesk-proto://open?x=1'
MSG
