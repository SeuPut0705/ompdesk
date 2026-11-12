#!/usr/bin/env bash
# Copies the CEF runtime files beside the exes in target/release (run after `cargo build --release`).
set -e
cd "$(dirname "$0")"
SRC=$(ls -d cef-bin/*/cef_windows_x86_64 | head -1)
DST=target/release
for f in libcef.dll chrome_elf.dll d3dcompiler_47.dll dxcompiler.dll vk_swiftshader.dll vk_swiftshader_icd.json vulkan-1.dll icudtl.dat resources.pak chrome_100_percent.pak chrome_200_percent.pak v8_context_snapshot.bin; do
  cp -f "$SRC/$f" "$DST/$f"
done
mkdir -p "$DST/locales"
cp -f "$SRC"/locales/*.pak "$DST/locales/"
echo staged into $DST
