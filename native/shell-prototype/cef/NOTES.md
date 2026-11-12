# CEF candidate (a) + preview-host

- Binding: the `cef` crate (tauri-apps/cef-rs 156.4.0 = CEF 156.0.26 / Chromium 156.0.8078.88), Views framework, Alloy runtime style.
- Why not Tauri 3's CEF runtime (alpha): tauri#16479 (scheme ranges), #14936 (title-bar drag crash), #9458 (no title-bar overlay); with the raw crate the scheme handler, draggable regions and caption buttons are ours.
- Build (Windows): `source env.sh` (cmake + Ninja from VS Build Tools, `CEF_PATH`, `CEF_DOWNLOAD_URL`), `unset INCLUDE LIB ...`, `cargo build --release`, `bash stage.sh`.
  Gotchas hit: (1) cef-dll-sys' build script reads CEF's 10 MB `index.json` through ureq (10 MiB limit): fetch the minimal archive by hand and serve a trimmed index + archive from a local `python -m http.server` via `CEF_DOWNLOAD_URL`;
  (2) the libcef_dll_wrapper object paths exceed MAX_PATH from a deep worktree: build through `subst X: native/shell-prototype` and `cd X:/cef`;
  (3) cl needs `INCLUDE` set only for the cef-dll-sys build script (with it set, rustc's own link.exe discovery breaks): build `-p cef-dll-sys` once with INCLUDE (see vcenv.sh), then everything else without;
  (4) the exe needs an embedded manifest (`app.manifest`, supportedOS + PerMonitorV2): without it the GPU process crash-loops (exit 0x80000003) on this machine.
- Tests: `test/preview-host-offscreen.ts`, `test/preview-host-child.ts` (bun), `test/hittest.py`, `test/caption_probe.py`, `test/tray_probe.py` (python, window messages only).
