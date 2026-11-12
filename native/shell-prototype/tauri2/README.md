# shell-tauri2 (candidates b and c)

One binary. `--preview-mode webview2` (default) is candidate (b); `cef-child` and `cef-stream` are candidate (c).
Contract: `../README.md`. Throwaway.

Build: `cargo build --release` (no tauri CLI). Output: `target/release/shell-tauri2.exe`.
Needs the WebView2 runtime (system-installed). Candidate (c) also needs `preview-host.exe` + CEF runtime beside the exe
(`--preview-host <exe>`, else `<exe dir>/preview-host.exe`, else `../cef/target/release/preview-host.exe`).

Run: `shell-tauri2.exe --selftest --preview app://ompdesk/__shell/preview-test.html --debug-port 9302 --exit-after 60 --log run.jsonl`
`app://ompdesk/...` in `--preview` is rewritten to the real origin (`http://app.localhost/` for webview2,
a loopback HTTP server of the same files for the cef modes). `--cdp-port` (default 9303) is preview-host's port.

Files: `src/main.rs` (window, scheme, tray, single instance, layout), `scheme.rs` (file/range/injection),
`cdp.rs` (WebSocket CDP client), `selftest.rs`, `stream.rs` (cef-stream), `preview.rs` (preview-host process + loopback HTTP),
`hit.rs` (WM_NCHITTEST probe + top-level forwarder), `shell-ui.js` (caption buttons, caption-band CSS, stream canvas).
