# Shell prototype (batch P)

Throwaway. Decides which shell replaces Electron (`.omp/rules/native-rust.md` › The shell is chosen by measurement).
Nothing here ships; `native/ompdesk` is untouched. Each candidate is its own cargo workspace with its own `target/`.

| Folder | What |
|---|---|
| `shell-assets/` | Files every candidate serves under `/__shell/`: `stand-in.js` (built from `stand-in/`), `video.webm`, `preview-test.html`. |
| `stand-in/` | The stand-in IPC: `window.omp` built by the app's own `createOmpApi` over the dev harness transport (`src/renderer/dev-harness/transport.ts`), plus the page-side self-tests. `bun native/shell-prototype/stand-in/build.ts`. |
| `migrate/` | Rust library every candidate links: reads Electron's userData as it is (DPAPI `safeStorage` token, `Local Storage` of `file://`). |
| `cef/` | Candidate (a): `shell-cef` (whole app in CEF) and `preview-host` (CEF process for candidate (c)'s Preview). |
| `tauri2/` | Candidates (b) and (c): `shell-tauri2 --preview-mode webview2` is (b), `--preview-mode cef-child` / `cef-stream` is (c). |
| `measure/` | Measurement scripts (memory, size, Playwright attach, title-bar hit test, deep link). |
| `move/` | The update move from the released Electron app (handoff installer, fake release feed). |

## Contract every shell keeps

So one set of measurement scripts drives every candidate.

### Command line

| Flag | Meaning | Default |
|---|---|---|
| `--renderer <dir>` | The built renderer (`bun run build` → `out/renderer`). | env `SHELL_RENDERER_DIR`, else walk up from the exe to the first folder holding `out/renderer` |
| `--assets <dir>` | `shell-assets/`. | env `SHELL_ASSETS_DIR`, else walk up to `native/shell-prototype/shell-assets` |
| `--query <q>` | Query string appended to `index.html` (`long=2000`, `selftest=1`). | none |
| `--preview <url>` | Open the Preview pane (right 40 % of the window, below the 48 px top bar) on `url`. Without the flag no Preview exists. | none |
| `--debug-port <n>` | Chromium remote debugging port of the window's page (Playwright attaches here). | none |
| `--user-data <dir>` | Electron's userData folder to read; the shell's own webview profile lives in `<dir>/shell-webview/`, never in Electron's files. | env `OMPDESK_PROTO_USER_DATA`, else `%APPDATA%\ompdesk-proto` |
| `--log <file>` | JSON Lines log, one object per event, `{"t": <ms since start>, "event": "<name>", ...}`. | `<user-data>/shell-webview/shell.log.jsonl` |
| `--selftest` | Run the host-side self-tests below once the page and the Preview loaded, log each result. | off |
| `--exit-after <s>` | Quit after s seconds (measurement runs). | none |

### Custom scheme

- The page loads from `app://ompdesk/index.html` (the candidate may have to spell the origin otherwise, e.g. WebView2's `http://app.localhost/`; log the real URL as event `page.url`).
- `/<path>` serves `<renderer>/<path>`; `/__shell/<path>` serves `<assets>/<path>`; MIME by extension (`.html .js .mjs .css .json .svg .png .woff2 .webm .mp4 .mp3 .wasm .ico .txt`).
- **Range requests**: `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` answer `206` with `Content-Range: bytes a-b/size`, `Accept-Ranges: bytes`, the right `Content-Length`; every response carries `Accept-Ranges: bytes`. Log each ranged request as `scheme.range {path, range, status}`.
- **`index.html` gets `<script src="/__shell/stand-in.js"></script>` inserted right after `<head>`** (a classic script, so it runs before the app's module scripts and defines `window.omp`). Also add `data-platform="win32"` (macOS: `darwin`) to `<html>` if the stand-in has not.
- `POST /__shell/report` with a JSON body: log the body as event `page.report` (fields merged), answer `204`. This is the page→host channel the stand-in's self-tests use.
- `GET /__shell/local-storage.json`: serve `<user-data>/shell-webview/local-storage-import.json` if it exists (else `404`).
- `POST /__shell/window` with `{"action": "minimize"|"maximize"|"close"|"drag"}`: window controls for a candidate that draws its own caption buttons.

### Events every shell logs

`start {candidate, version}`, `page.url {url}`, `page.loaded {ms}` (navigation finished), `scheme.range {...}`, `page.report {...}`, `preview.loaded {url, ms}`, `tray.created {ok}`, `tray.click {item}`, `deeplink {url, from: "argv"|"second-instance"}`, `migrate.* {...}` (from the `migrate` crate), `selftest.<name> {ok, ms, ...}`, `exit`.

### Self-tests (`--selftest`), run from the host against the Preview

| Event | What |
|---|---|
| `selftest.cdp_evaluate` | Host-side CDP `Runtime.evaluate` `document.title` in the Preview (Electron: `webContents.debugger`). |
| `selftest.capture` | Capture the Preview to PNG (`Page.captureScreenshot` or the candidate's native capture); `{bytes, path}`. |
| `selftest.input` | `Input.dispatchMouseEvent` press+release at the centre of `#target` in `preview-test.html`; then evaluate `window.__clicks`; `{ok: clicks===1, ms}`. |
| `selftest.pdf` | `Page.printToPDF` (or native) of the Preview; `{bytes, path}`; `ok` when the file starts with `%PDF`. |
| `selftest.cdp_external` | A second, external CDP client can attach to the Preview (`/json/list` on the Preview's port lists it); `{port, targets}`. |

### Single instance and deep links

Scheme `ompdesk-proto://` (never `ompdesk://`: the real app on this computer owns it). `--register-protocol` writes `HKCU\Software\Classes\ompdesk-proto` for the exe and exits. A second launch hands its argv to the first (which logs `deeplink {from: "second-instance"}`) and exits.

### Tray

An icon with a menu `Show` / `Quit`; log `tray.created` and `tray.click`.

### Title bar

Windows: no system title bar; the page's `-webkit-app-region: drag` areas drag the window (a `WM_NCHITTEST` sent to the top-level window inside the top bar answers `HTCAPTION`), and minimize / maximize / close stand at the top right as Electron's `titleBarOverlay` draws them (138 × 48 px). macOS: `hiddenInset` with the traffic lights at (18, 17).
