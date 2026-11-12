#!/usr/bin/env bash
# macOS: build shell-tauri2 and wrap it as target/mac/OMPdesk T2.app (ad-hoc signed) so Launch Services can hand it
# `ompdesk-proto-t2://` links. The renderer and shell assets are found by walking up to the repository (README.md).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release
APP="target/mac/OMPdesk T2.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/shell-tauri2 "$APP/Contents/MacOS/OMPdesk T2"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OMPdesk T2</string>
<key>CFBundleIdentifier</key><string>com.seuput.ompdesk.proto.t2</string>
<key>CFBundleName</key><string>OMPdesk T2</string>
<key>CFBundleShortVersionString</key><string>0.200.0</string>
<key>CFBundleVersion</key><string>0.200.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>ompdesk-proto-t2</string><key>CFBundleURLSchemes</key><array><string>ompdesk-proto-t2</string></array></dict></array>
</dict></plist>
PL
codesign --force --sign - "$APP"
echo "built: $PWD/$APP"
