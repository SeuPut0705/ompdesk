# ompdesk-shell

OMPdesk's window host: a Rust program around CEF (Chromium Embedded Framework, the `cef` crate 156.4.0 = CEF 156.0.26 /
Chromium 156.0.8078.88, Views framework, Alloy runtime) that shows the React page and the Preview's Chromium pages,
driven by the Node process that runs the TypeScript main (`out/main/index.js`, whose `electron` import is the shim in
`src/main/shell-host/electron`). Packaging renames the binary to `OMPdesk(.exe)`.

It is a cargo workspace of its own, excluded from `native/ompdesk`'s (`exclude = ["crates/shell"]`): the core workspace,
`bun run build:native`, `cargo test --workspace` and every vitest run never need the CEF archive or a C++ toolchain.

## Build and run

```
bun run build:shell              # fetch the pinned CEF archive, cargo build --release --locked, stage
bun run build:shell -- --check   # staged bytes held to ompdesk-shell.build.json, the record to the sources
bun run build:shell -- --ensure  # build only when --check fails
bun run build:shell -- --cargo clippy --all-targets -- -D warnings   # any cargo command in the same environment
bun run build:shell -- --cargo test
```

Staging: `resources/ompdesk-shell/<platform>-<arch>/` (gitignored): on Windows `ompdesk-shell.exe` (manifest and icon
embedded), `libcef.dll` and CEF's runtime files, `locales/en-US.pak` and `ko.pak` only, and `ompdesk-shell.build.json`
(each file's SHA-256, the sources' hash, the CEF version and archive SHA-256, rustc, when); on macOS the one Mach-O and
`Chromium Embedded Framework.framework` trimmed to `en.lproj` and `ko.lproj` (the bundle with its five helper apps is
assembled by packaging from that one binary). `after-pack.cjs` holds the packaged bytes to the record.

The CEF archive is pinned in `cef-pin.json` (name, SHA-256, SHA-1, size per platform), fetched once into
`target/cef-dl/`, checked, and served to the `cef-dll-sys` build script from a local HTTP server
(`CEF_DOWNLOAD_URL`): that script reads CEF's whole 10 MB `index.json` through a client limited to 10 MiB, which fails.
Windows build facts (from the prototype): cmake and Ninja come from the Visual Studio Build Tools; the wrapper's object
paths pass MAX_PATH from a deep worktree, so cargo runs on a `subst` drive of the crate folder; `cl` needs `INCLUDE` only
while `cef-dll-sys` builds (with it set, rustc's own linker discovery breaks), so that package is built first with it;
the exe needs an embedded manifest (`app.manifest`) or CEF's GPU process crash-loops. `cargo test` needs no CEF DLL:
the pure parts are the `shell_core` library and the binary has no tests of its own (`test = false`).

Run unpackaged, against a checkout that has `bun run build` output (`out/`):

```
OMPDESK_APP_DIR=<repo> resources/ompdesk-shell/win32-x64/ompdesk-shell.exe --user-data-dir=<temp dir>
```

Environment: `OMPDESK_APP_DIR` (the folder holding `out/main/index.js`; else found by walking up from the exe),
`OMPDESK_APP_ENTRY` (an absolute main script instead of `<appDir>/out/main/index.js`: the e2e harness runs pinned
snapshots), `OMPDESK_NODE` (node binary; else `node` on PATH; packaged `<resources>/node/node(.exe)`),
`OMP_GUI_TEST_USER_DATA_DIR` (user-data folder when no `--user-data-dir`), `OMP_GUI_TEST_NODE_INSPECT=1` (Node with
`--inspect=127.0.0.1:0`; its `Debugger listening` line comes out on the shell's stderr). Chromium switches among the
shell's arguments (`--remote-debugging-port`, `--lang`, `--host-resolver-rules`, `--ignore-certificate-errors`, …)
reach CEF; `--user-data-dir` is removed from CEF's own command line (the Chromium profile is
`<userData>/shell-webview/`, never Electron's `Local State`, `Local Storage` or `Cookies`). The same arguments go to
Node after the executable. A log line per event goes to stderr and `<userData>/shell-webview/shell.log.jsonl`.

## Process model and startup order

```
ompdesk-shell(.exe)          the shell; also every CEF helper (same exe, `--type=…`)
  ├─ node out/main/index.js  the TypeScript main (shim as `electron`), stdin = a pipe the shell holds
  └─ ompdesk-core            started by main as before
```

1. `--type=` in argv: `execute_process`, exit with its code (macOS first loads the CEF framework).
2. User-data folder: `--user-data-dir`, else `OMP_GUI_TEST_USER_DATA_DIR`, else Electron's own rule
   (`FOLDERID_RoamingAppData\ompdesk`, `~/Library/Application Support/ompdesk`).
3. One instance per user-data folder: named pipe `\\.\pipe\ompdesk-shell-<16 hex of SHA-256(lower-cased path)>` (unix
   socket `<userData>/shell.sock` on macOS). A second launch hands `{argv, cwd}` over and exits 0; the first emits
   `app.secondInstance`.
4. Electron's `file://` Local Storage is exported once (`migrate/local_storage.rs`, read from a copy of the LevelDB);
   the injected preload copies it into the `app://ompdesk` origin before any page script and the shell marks it done.
5. Facts (paths, locale, displays, theme, `safeStorage` key) are read from the OS and answer `hello`; Node is started
   with `OMPDESK_SHELL_SOCKET` and `OMPDESK_SHELL_TOKEN`; `app.init` (switches, schemes) starts CEF; `app.ready`
   follows `on_context_initialized`.
6. `app.exit {code}`: windows close without asking, CEF shuts down, the shell exits with the code (a pending
   `app.relaunch` starts the exe again after the instance pipe is free). Node dying unexpectedly: the shell logs it and
   exits 1.

## Layout

| Path | What |
|---|---|
| `PROTOCOL.md` | the host protocol (method table by NodeShim, deviations in §14) |
| `src/lib.rs` + `src/{wire,range,startup,facts,frame,color,conn,chunks,proxy_rules,…}.rs`, `src/migrate/`, `src/sys/` | `shell_core`: everything CEF-free, with the Rust tests; `src/sys/` is the one place raw Win32 lives (`unsafe` allowed there, each block with `// SAFETY:`), `src/sys_mac/` the macOS twin |
| `src/main.rs`, `lifecycle.rs`, `node.rs`, `host.rs`, `dispatch.rs` | startup, exit, Node process, the socket and its handshake, routing |
| `src/app.rs` | CEF `App`: command line, custom schemes, browser- and renderer-process handlers |
| `src/window.rs`, `view.rs`, `wc.rs`, `cdp.rs`, `wcframe.rs`, `session.rs` | windows, Preview views, pages and their events, DevTools protocol, offscreen frames, request contexts |
| `src/scheme.rs`, `ipc.rs`, `protocol.rs` | `app://ompdesk` (files, range requests, `/__ipc/`, `/__shell/`), the page ⇄ Node relay, schemes served by Node |
| `src/{menu,tray,dialog,clipboard,shellops,notification,screen,theme,power,shortcut,system,net}.rs` | the remaining namespaces |
| `build.rs`, `app.manifest`, `cef-pin.json` | Windows manifest and icon resource, the CEF pin |
| `../../../../src/preload/shell.ts` | `window.omp`, built to `out/preload/shell.js` (IIFE) by `electron.vite.config.ts` |

## Page transport

`window.omp = createOmpApi(shellTransport)` (`src/preload/shell.ts`), injected as the first script of `index.html` by the
scheme handler. `invoke` is a `fetch` POST to `app://ompdesk/__ipc/invoke` answered when Node answers (CEF's async
resource handler: nothing blocks the renderer), `send` a `fetch` POST in order, `on` a never-ending `GET /__ipc/events`
read as lines, so Node's `wc.send` pushes reach listeners in the order they were sent. `Uint8Array` travels as
`{"$bin": "<base64>"}`. `fs.pathForFile` asks `/__shell/drag-files` (the paths CEF saw when the drag entered, matched by
file name).

## Deviations from Electron

- **Page origin**: `app://ompdesk` instead of `file://`: Local Storage is imported once (above); IndexedDB and cookies of the
  `file://` origin are not.
- **`will-navigate` and friends** hold CEF's `OnBeforeBrowse` (the UI thread) for Node's answer up to 2 s, then prevent.
  Navigations Node started itself (`loadURL`, reload, back, forward) are never asked about, and `isSameDocument` is
  always false.
- **`did-navigate`** is the first address change after a navigation started (status 200, "OK": CEF gives no code there);
  later address changes are `did-navigate-in-page`.
- **Popups** (`window.open`): cancelled at once; Node is told with `wc.windowOpen` but its answer is never waited for.
- **JS dialogs**: `__ompdeskSendSync` of a Preview preload is a `prompt()` whose message starts with `NUL` + `omp-sync:`,
  answered asynchronously through `ipc.sendSync` (so a 60 s wait for a person blocks the page, not the shell). Other
  dialogs are CEF's own; `beforeunload` never asks.
- **`webContents.setBackgroundThrottling`** is accepted and ignored.
- **`copyImageAt`** copies the image under the point through the page's own clipboard API (CEF has no such call).
- **`session.setProxy`/`resolveProxy`**: proxy modes go to Chromium's `proxy` preference of the request context;
  `resolveProxy` is answered from the user's WinINET/WinHTTP settings (fixed proxy, bypass list, WPAD/PAC), not
  from Chromium's resolver.
- **Display bounds** are physical pixels divided by each display's own scale (Electron's DIP space differs on mixed-DPI
  setups).
- **`theme.setSource`** changes what Node reports and is pushed into every page as CDP `Emulation.setEmulatedMedia`
  (`prefers-color-scheme`).
- **Preview partitions** (no `persist:` prefix) are in-memory request contexts that keep nothing, so `clearCache` and
  `clearStorageData` do nothing for them; creating the two Preview contexts logs a non-fatal Chromium `NOTREACHED` line.
- **Diagnostics**: `OMPDESK_SHELL_TRACE=1` logs each host request; a Rust panic writes `%TEMP%/ompdesk-shell-panic.log`.
- **Dialogs** run on a thread of their own so their modal loop does not block CEF's UI thread; macOS `messageBox` is
  an app-modal alert, not a sheet.
- **Notifications** are WinRT toasts keyed on the AppUserModelID; an unpackaged run without a Start-menu shortcut with
  that id may show nothing (the `show` event is still sent).
- **Locales**: only `en-US` and `ko` ship; any other OS language falls back to `en-US` pak resources (`app.getLocale()`
  still reports the OS locale).
- **Windows caption buttons** are one native popup window (138 × 48 DIP) owned by the top-level window, in
  `titleBarOverlay`'s colours; `setProgressBar` is accepted and has no effect yet.

## macOS: written here, not run here

Everything under `src/sys_mac/`, `src/macos.rs`, `src/platform.rs` and the macOS branches in `main.rs`, `app.rs`,
`window.rs`, `facts.rs` and `scripts/build-shell.ts` was written on Windows without a compiler for that target and is
unverified: the `CefApplication` NSApplication subclass and the Apple Event delegate, framework loading from the helper
apps, hidden-inset traffic-light placement (`titlebar_height` 46 for a 12 px button at y = 17), the default main menu,
sheet-less dialogs, NSMenu and tray, notification centre, display/theme/power observers, the staged framework layout,
and `--keychain-key` (the keychain item is read only when the shim first needs it, never at launch; every CEF process
runs with `--use-mock-keychain`).
