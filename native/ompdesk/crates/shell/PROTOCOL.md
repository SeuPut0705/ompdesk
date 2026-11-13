# Host protocol: Node main ⇄ ompdesk-shell

Author of the method table: NodeShim (`src/main/shell-host/`). Implementer of the Rust side: ShellCrate, who records
deviations in the last section. The shim (`src/main/shell-host/electron/`) is the only Node-side speaker; every
Electron call `src/main` makes (found statically, see the inventory in `src/main/shell-host/INVENTORY.md`) maps to
one entry below. Nothing here is a general Electron emulation: a method the app never calls is not listed, and a
`win.op`/`wc.op` name the shell does not know answers `{code: "unsupported"}` (never silently ignored).

## 0. Wire

The core's wire (`crates/core/src/wire.rs`), over the named pipe / unix socket the shell hands Node in
`OMPDESK_SHELL_SOCKET`:

- one JSON object per line, UTF-8, `\n` (a trailing `\r` is tolerated on read);
- request `{"id": n, "method": "...", "params": {...}}`, answer `{"id": n, "ok": true, "result": ...}` or
  `{"id": n, "ok": false, "error": {"code": "...", "message": "..."}}`, event `{"event": "...", "data": {...}}`;
- `"bin": n` on any frame (request, answer, event): exactly `n` raw bytes follow the newline and belong to that frame;
- `{"cancel": id}`: the sender no longer waits for request `id` (a `net.fetch` aborted, a `protocol.request` the page
  dropped); the other side may stop work and need not answer;
- **both sides send requests**; ids are per direction (the shell's ids and Node's ids are independent counters). One
  writer per side, so frames never interleave. A malformed line is logged and skipped.
- Error `code`s: `unsupported`, `invalid`, `gone` (window/page/view destroyed), `denied`, `failed` (message says why),
  `cdp` (DevTools protocol error, `message` is the protocol's), `timeout`.
- Names: `winId` = Electron's `BrowserWindow.id`, `wcId` = `webContents.id`, `viewId` = a `WebContentsView`'s id.
  **Node assigns all three** (one counter each, from 1, never reused in a run) and sends them in `win.create` /
  `view.create`: Electron's constructors return at once with `win.id` and `win.webContents.id` readable, so they
  cannot wait for an answer. The shell processes requests in arrival order, so an op sent right after a `create`
  finds its target; a request about an id the shell does not know answers `gone`.
- Requests that need CEF (`win.*`, `wc.*`, `view.*`, `session.*`, `menu.*`, `tray.*`, `dialog.*`, `clipboard.*`,
  `shell.*`, `notification.*`, `theme.*`, `power.*`, `shortcut.*`, `net.*`, `system.*`) are sent by the shim only
  **after `app.ready`** (it holds earlier calls, in order); `hello` and `app.*` are never held. The shell therefore
  never has to queue work for a CEF that is not up.
- Rects are `{x, y, width, height}` in DIP (device independent pixels, Electron's unit); colours are CSS strings
  (`#rrggbb`, `#rrggbbaa`, `rgb(…)`).

Node → shell **events** never get an answer. Shell → Node events are listed with their method name in the
`Event` column.

## 1. Handshake and facts

| Method | Asks | Params | Result |
|---|---|---|---|
| `hello` | Node | `{token, pid, protocol: 1}` | `{protocol: 1, facts}` — wrong token: the shell closes the connection |

`hello` is the first frame. Node's main reads many Electron values synchronously at module top level, before it
could `await` anything, so **the answer to `hello` carries every fact the shim serves synchronously**; the shim's
entry awaits it (ESM top-level `await`) before any main code runs. Everything not in `facts` is a request or a
pushed event.

`facts`:

```
{
  paths: { userData, appData, sessionData, home, temp, exe, module, desktop, documents, downloads, music,
           pictures, videos, logs, crashDumps },        // every name app.getPath serves; absolute
  exe: string,                  // the shell's executable (`app.getPath("exe")`, what a relaunch starts)
  resourcesPath: string,        // `process.resourcesPath`: packaged <install>/resources, unpackaged: <appDir>/resources
  appPath: string,              // `app.getAppPath()`: the folder holding out/main/index.js (package.json beside it)
  isPackaged: boolean,
  rendererRoot?: string,        // the renderer folder served as app://ompdesk/ (dirname(entry)/../renderer); absent: <appPath>/out/renderer
  argv: string[],               // the shell's own argv, exe first (what a second launch would send as `argv`)
  locale: { appLocale, systemLocale, preferredLanguages: string[] },
  displays: Display[], primaryDisplayId: number,
  theme: { dark: boolean, highContrast: boolean, inverted: boolean },
  system: { reducedMotion: boolean, onBattery: boolean, online: boolean },
  versions: { chrome: string, cef: string, shell: string },
  safeStorage: { kind: "win-v10", key: base64(32 bytes) }
             | { kind: "mac-v10-lazy" }                      // macOS: no key at launch, see §11
             | { unavailable: string }                      // why (logged by the shim, never silent)
}
Display = { id, label, bounds: Rect, workArea: Rect, scaleFactor, rotation: 0|90|180|270, internal: boolean,
            colorDepth, monitorFrequency? }
```

`versions.shell` is what `process.versions.shell` reports; `versions.chrome` becomes `process.versions.chrome`;
`process.versions.electron` stays undefined (callers print `?`).

`app.getPath` of a name not in `paths` throws `Failed to get 'name' path`, as Electron does.

## 2. `app.*`

| Method | Asks | Params | Result / notes |
|---|---|---|---|
| `app.init` | Node | `{name, switches: [[name, value\|null]], schemes: Scheme[], disableHardwareAcceleration: boolean, appUserModelId?: string, activationPolicy?: "regular"\|"accessory"\|"prohibited", aboutPanel?: {applicationName?, iconPath?}}` | `{}` — sent once, on the first macrotask after main's top-level code ran (everything Electron's main does before `whenReady`). The shell then initialises CEF with these switches and schemes and sends `app.ready`. |
| `app.ready` (event) | shell→Node | `{}` | CEF's context is up; windows may be created. `app.whenReady()` resolves here. |
| `app.exit` (event) | Node | `{code}` | Node finished its quit sequence (`before-quit`, window closes, `will-quit`, `quit`) or `app.exit(code)` was called. The shell closes every window without asking, tears CEF down and exits with `code`; a pending `app.relaunch` is started after teardown. |
| `app.relaunch` (event) | Node | `{args: string[] \| null}` | After the shell exits, start `exe` again with `args`, or its own launch args when `null` (Electron's default). Last call wins. |
| `app.focus` | Node | `{steal?: boolean}` | `{}` |
| `app.hide` / `app.show` | Node | `{}` | macOS `NSApp hide/unhide`; no-op elsewhere. |
| `app.setBadge` | Node | `{text}` | macOS Dock badge (`app.dock.setBadge`); no-op elsewhere. |
| `app.setDockIcon` | Node | `{}` + `bin` PNG | macOS `app.dock.setIcon`. |
| `app.setAppUserModelId` | Node | `{id}` | Windows AppUserModelID (also in `app.init`). |
| `app.setAsDefaultProtocolClient` | Node | `{protocol}` | `{ok: boolean}` — registers the shell's own exe: Windows `HKCU\Software\Classes\<protocol>` (`shell\open\command` = `"exe" "%1"`), macOS LaunchServices (`LSSetDefaultHandlerForURLScheme`). The shell's exe only: dev runs register the dev shell. |
| `app.showAboutPanel` | Node | `{}` | macOS standard about panel using the init `aboutPanel` options; Windows: no-op. |
| `app.getGPUInfo` | Node | `{kind: "basic"\|"complete"}` | `{info: {gpuDevice: [{vendorId, deviceId, active, driverVendor?, driverVersion?, deviceString?}]}, features: Record<string,string>}`. `features` is Electron's `getGPUFeatureStatus()` (`gpu_compositing` is `"enabled"`, `"disabled_software"`, …); the shim serves the sync `getGPUFeatureStatus()` from the last answer. Resolves once the GPU process reported (CEF `GetGPUInfo`/the `chrome://gpu` feature status), never earlier. |
| `app.secondInstance` (event) | shell→Node | `{argv: string[], cwd: string}` | another launch for the same userData handed over and exited 0. `argv[0]` is that launch's exe. |
| `app.openUrl` (event) | shell→Node | `{url}` | macOS `kAEGetURL` (and Windows protocol launches arrive as `secondInstance`). |
| `app.openFile` (event) | shell→Node | `{path}` | macOS `kAEOpenDocuments`. |
| `app.quitRequested` (event) | shell→Node | `{}` | macOS ⌘Q / Dock › Quit: the shim runs `app.quit()` (before-quit, window closes, will-quit, quit), which ends in `app.exit`. |
| `app.activate` (event) | shell→Node | `{hasVisibleWindows: boolean}` | macOS Dock click. |
| `app.childProcessGone` (event) | shell→Node | `{type: "GPU"\|"Utility"\|"Renderer"\|…, reason, exitCode, name?, serviceName?}` | CEF helper process ended abnormally (the GPU one drives the software fallback). Renderer crashes are `wc.event render-process-gone` instead. |

`Scheme = {scheme, privileges: {standard?, secure?, bypassCSP?, allowServiceWorkers?, supportFetchAPI?, corsEnabled?, stream?, codeCache?}}`
(Electron's `CustomScheme`). `app://ompdesk` is the shell's own and is not registered here.

Not Node's to ask: single-instance (the shell enforces it before Node starts; `requestSingleInstanceLock()`
answers `true` locally), the userData choice (`app.setPath("userData", dir)` only updates Node's table; the
shell's own resolution of the same switch/env is authoritative and equal in every case main handles).

## 3. `win.*` (BrowserWindow)

| Method | Asks | Params | Result / notes |
|---|---|---|---|
| `win.create` | Node | `{winId, wcId, options}` | `{state: WinState}` — see options below. For `webPreferences.offscreen: true` there is no OS window: a windowless CEF browser (`wc.paint` events, `wc.frame`) and `state.visible` stays false. |
| `win.op` | Node | `{winId, op, args}` | `{}` unless noted; the ops below. |
| `win.closeRequested` | shell→Node | `{winId}` | `{prevent: boolean}` — the person closed the window (caption button, Alt+F4, taskbar, ⌘W, `win.op close` is **not** this). The shim runs `close` listeners with `preventDefault`; the shell closes only when `prevent` is false, then emits `win.event closed`. No answer within 5 s counts as not prevented. |
| `win.state` (event) | shell→Node | `WinState` + `{winId}` | pushed after every change; the shim answers `getBounds()`, `isMaximized()`, … synchronously from it. |
| `win.event` (event) | shell→Node | `{winId, name, args?}` | `show`, `hide`, `focus`, `blur`, `minimize`, `maximize`, `unmaximize`, `restore`, `enter-full-screen`, `leave-full-screen`, `resize`, `move`, `ready-to-show`, `unresponsive`, `responsive`, `closed`. `focus`/`blur`/`closed` come *after* the `win.state` that shows their effect. |

`WinState = {bounds: Rect, normalBounds: Rect, contentBounds: Rect, visible, focused, minimized, maximized, fullscreen, title, opacity}`
(`bounds` is the outer rect, `contentBounds` the web area; `minimized` etc. as Chromium reports them).

`win.create` `options` — the `BrowserWindowConstructorOptions` main uses:
`x, y, width, height, minWidth, minHeight, show, useContentSize, enableLargerThanScreen, autoHideMenuBar,
icon` (an absolute file path), `backgroundColor`, `transparent`,
`titleBarStyle: "hidden"|"hiddenInset"`, `trafficLightPosition {x, y}`,
`titleBarOverlay {color, symbolColor, height}`, `backgroundMaterial: "mica"`,
`webPreferences {offscreen, backgroundThrottling, spellcheck, session: <partition name>, sandbox, contextIsolation,
nodeIntegration, webSecurity, navigateOnDragDrop}` (the sandbox/isolation fields are information: a CEF page never
has Node). The shim drops `webPreferences.preload`; the shell injects `out/preload/shell.js` itself into every
page of the **app session** (never into a Preview partition). The window loads nothing until `wc.op loadURL`.
Chrome as in the contract: frameless; Windows draws the caption buttons (138 × 48 px popup, `titleBarOverlay`
colours), macOS hidden-inset traffic lights at `trafficLightPosition`.

`win.op` ops (`args` object):
`show`, `showInactive`, `hide`, `close` (`{force: true}` — Node already ran the `close` listeners and the
window closes without `win.closeRequested`; the shell then emits `win.event closed`), `destroy`, `focus`, `blur`,
`minimize`, `maximize`, `unmaximize`, `restore`, `setFullScreen {on}`, `setBounds {bounds}`, `setSize {width,height}`,
`setContentSize {width,height}`, `setPosition {x,y}`, `center`, `setMinimumSize {width,height}`, `setMaximumSize`,
`setOpacity {value}`, `setIgnoreMouseEvents {ignore, forward?}`, `setSkipTaskbar {skip}`, `setFocusable {focusable}`,
`setProgressBar {value, mode?}` (-1 clears), `setTitleBarOverlay {color, symbolColor, height}`, `setTitle {title}`,
`setBackgroundColor {color}`, `setBackgroundMaterial {material}`, `setAlwaysOnTop {flag}`, `setMenuBarVisibility {visible}`,
`setAutoHideMenuBar {hide}`, `setIcon {path}`.

## 4. `wc.*` (webContents of a window, a view or an offscreen window)

| Method | Asks | Params | Result / notes |
|---|---|---|---|
| `wc.op` | Node | `{wcId, op, args}` | the ops below |
| `wc.send` (event) | Node | `{wcId, channel, args: unknown[]}` | main → page push (the hot path); delivered to the page's `window.omp` listeners in order. Pages that are not app pages (Preview partitions) ignore it. |
| `wc.state` (event) | shell→Node | `{wcId, url, title, loading, canGoBack, canGoForward, zoomFactor, audioMuted, devtoolsOpened, crashed, userAgent, frameRate?}` | pushed on every change; `getURL()`, `isLoading()`, `getTitle()`, `navigationHistory.canGoBack()`, `getZoomFactor()`, `getUserAgent()` are answered from it. |
| `wc.event` | shell→Node | `{wcId, name, args}` | Electron's webContents events, in Electron's argument shapes (below). Delivered after the `wc.state` that shows their effect. |
| `wc.windowOpen` | shell→Node | `{wcId, url, frameName, disposition, features, referrer?}` | `{action: "deny"}` — `setWindowOpenHandler`; the app only ever denies (it opens the Preview tab or the system browser itself), so the shell treats anything but `deny` as deny. The shell waits for the answer (2 s, then denies). |
| `wc.navigate` | shell→Node | `{wcId, kind: "will-navigate"\|"will-frame-navigate"\|"will-redirect", url, isMainFrame, isSameDocument, isRedirect}` | `{prevent: boolean}` — emitted only for pages whose Node side registered a listener for that kind (`wc.op watchEvents`, below), so a page nobody watches never blocks. The shell holds the navigation (CEF `OnBeforeBrowse`) for the answer (2 s, then **prevents**). |
| `wc.cdp.attach` | Node | `{wcId}` | `{}` — start forwarding `wc.cdp.message` (Electron `debugger.attach`). |
| `wc.cdp.detach` | Node | `{wcId}` | `{}` |
| `wc.cdp.send` | Node | `{wcId, method, params?, sessionId?}` | `{result}`; protocol error → `error.code "cdp"`. Works with or without `attach` (the shell registers its DevTools observer on first use); the shim builds `capturePage`, `printToPDF`, `sendInputEvent`, `insertText`, `executeJavaScriptInIsolatedWorld` and the Preview relay on it. |
| `wc.cdp.message` (event) | shell→Node | `{wcId, method, params, sessionId?}` | protocol events and, for `sessionId`, the target's; only while attached. |
| `wc.cdp.detached` (event) | shell→Node | `{wcId, reason}` | the page went away or DevTools took the page. |
| `wc.frame` | Node | `{wcId, format: "jpeg"\|"png", quality?: 0..100, width?: number}` | `{width, height}` + `bin` = the page's **latest painted frame** encoded (offscreen browsers only), scaled to `width` DIP-independent pixels when given, never larger than the source. Encode only what is sent. |
| `wc.paint` (event) | shell→Node | `{wcId, width, height, scale}` | an offscreen browser painted (dirty rect dropped; the full frame is `wc.frame`). |

The DevTools commands the shim itself sends through `wc.cdp.send` (so the shell must pass them to the page's DevTools agent
unchanged): `Page.getFrameTree`, `Page.createIsolatedWorld`, `Runtime.evaluate` (`contextId`, `awaitPromise`,
`returnByValue`, `userGesture`), `Page.getLayoutMetrics`, `Page.captureScreenshot` (`format: "png"`, `fromSurface`,
`clip {x, y, width, height, scale}` — a `scale` below 1 must shrink the picture: the app takes a smaller capture this way
instead of resizing a bitmap), `Page.printToPDF` (`transferMode: "ReturnAsBase64"`), `Input.dispatchMouseEvent`,
`Input.dispatchKeyEvent`, `Input.insertText`; the agent's browser relay sends any command the agent asks.

`wc.op` ops: `loadURL {url, userAgent?, httpReferrer?, extraHeaders?}` (the shim turns `loadFile` into a
`loadURL` of `app://ompdesk/…` for files under `out/renderer`, `file://` otherwise), `reload`, `reloadIgnoringCache`,
`stop`, `goBack`, `goForward`, `executeJavaScript {code, userGesture?}` → `{result}` (JSON value; a throw is
`error.code "failed"` with the page's message), `setZoomFactor {factor}`, `setUserAgent {userAgent, acceptLanguages?}`,
`openDevTools {mode?}`, `closeDevTools`, `undo`, `redo`, `cut`, `copy`, `paste`, `pasteAndMatchStyle`, `selectAll`,
`delete`, `replaceMisspelling {text}`, `copyImageAt {x, y}`, `setWebRTCIPHandlingPolicy {policy}`,
`setFrameRate {fps}`, `invalidate`, `startPainting`, `stopPainting`, `focus`, `setAudioMuted {muted}`,
`setBackgroundThrottling {allowed}`, `ignoreBeforeUnload`, `close` (destroys the page), `watchEvents {names}`.

`wc.event` names and `args` (all the page-level events the app listens to):

| name | args |
|---|---|
| `did-start-loading`, `did-stop-loading`, `did-finish-load`, `dom-ready`, `unresponsive`, `responsive` | `[]` |
| `did-start-navigation` | `[{url, isInPlace, isMainFrame, frameProcessId, frameRoutingId, isSameDocument}]` |
| `did-navigate` | `[url, httpResponseCode, httpStatusText]` |
| `did-navigate-in-page` | `[url, isMainFrame]` |
| `did-fail-load` | `[errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId]` (a load that is cancelled by a new one is `-3`) |
| `page-title-updated` | `[title, explicitSet]` |
| `render-process-gone` | `[{reason, exitCode}]` (`crashed`, `killed`, `oom`, `launch-failed`, `integrity-failure`, `abnormal-exit`, `clean-exit`) |
| `console-message` | `[{level: "debug"\|"info"\|"warning"\|"error", message, lineNumber, sourceId}]` |
| `context-menu` | `[{x, y, isEditable, selectionText, misspelledWord, dictionarySuggestions: string[], mediaType: "none"\|"image"\|…, linkURL, srcURL, editFlags: {canUndo, canRedo, canCut, canCopy, canPaste, canSelectAll}}]` — optional (see below). |
| `input-event` | `[{type: "mouseUp"\|"keyUp"}]` — a trusted pointer or key release on the page: a person's, or browser-process input sent through the DevTools protocol (`sendInputEvent`), as Electron's; never a script's `dispatchEvent` |
| `will-prevent-unload` | `[]` — an offscreen page's beforeunload prompt; the Preview's listener always prevents it (the page unloads): the shim then sends `wc.op ignoreBeforeUnload`. Optional. |
| `preload-error` | `[preloadPath, {message, stack}]` — the shell's injected `shell.js` threw |
| `destroyed` | `[]` — last event of a page |

Optional events are switched on per page with `wc.op watchEvents {names: string[]}` (Node → shell, sent when the
first listener of a name is added; `names` is the full set so far): `context-menu`, `input-event`,
`console-message`, `paint`, `will-prevent-unload`, `will-navigate`, `will-frame-navigate`, `will-redirect` (the last
three are what `wc.navigate` serves). The unconditional ones are the loading, navigation, title,
`render-process-gone`, `unresponsive`/`responsive`, `destroyed`, `did-fail-load`, `dom-ready` and `preload-error`
events. `console-message` and `did-start-navigation` carry their details as the event object in Electron 36 (the shim
spreads `args[0]` into the event).

## 5. `view.*` (WebContentsView: the Preview)

| Method | Asks | Params | Result |
|---|---|---|---|
| `view.create` | Node | `{viewId, wcId, webPreferences: {session: <partition name>, sandbox, contextIsolation, nodeIntegration, webSecurity, navigateOnDragDrop}}` | `{}` — a CEF browser in a Views `BrowserView` with the partition's request context; not attached anywhere yet |
| `view.op` | Node | `{viewId, op, args}` | ops: `attach {winId}` (`win.contentView.addChildView`), `detach {winId}` (`removeChildView`), `setBounds {bounds}` (window-content DIP), `setVisible {visible}`, `setBackgroundColor {color}`. A destroyed window's views are destroyed with it. |

`wc.op`/`wc.cdp.*`/`wc.event` serve a view's page by its `wcId`. `view.op destroy` / `wc.op close` destroys it.

## 6. `session.*` and `protocol.*`

A partition is CEF request context: `app` = the app session (`session.defaultSession`; shares `<userData>/shell-webview`
with the page), a name without `persist:` is in memory only, `persist:<name>` is `<userData>/shell-webview/Partitions/<name>`.

| Method | Asks | Params | Result |
|---|---|---|---|
| `session.create` | Node | `{partition, cache?: boolean}` | `{userAgent, acceptLanguages, spellCheckerLanguages: string[], availableSpellCheckerLanguages: string[], cachePath: string \| null}` — idempotent; the shim mirrors these for `getUserAgent()`, `getSpellCheckerLanguages()`, `availableSpellCheckerLanguages` and `getCachePath()`. `cachePath` is the folder of the partition's HTTP cache on disk (`app`: the shell's own `<userData>/shell-webview/Default/Cache`; `persist:<n>`: that partition's cache folder; an in-memory partition: `null`); disk care measures it and `session.op clearCache` must empty it, for `app` too |
| `session.op` | Node | `{partition, op, args}` | `setProxy {mode: "direct"\|"system"\|"fixed_servers"\|"pac_script", proxyRules?, pacScript?, proxyBypassRules?}`, `resolveProxy {url}` → `{result: "PROXY h:p; DIRECT"}`, `clearCache`, `clearStorageData`, `setUserAgent {userAgent, acceptLanguages?}`, `setSpellCheckerLanguages {languages}`, `addWordToSpellCheckerDictionary {word}`, `setPermissions {mode: "deny-all"\|"default"}` (the Preview denies every permission request **and** check; no round trip), `setDownloads {mode: "deny"\|"default"}` (denied: the shell cancels, and tells Node with `session.download`), `registerPreload {id, source}` (below), `handleScheme {scheme}`, `unhandleScheme {scheme}` |
| `session.download` (event) | shell→Node | `{partition, wcId, url, filename, mimeType, totalBytes}` | a cancelled download (`setDownloads deny`) |

`registerPreload {id, source}`: the shell runs `source` (a classic script) in every frame's main world of that
partition before page scripts. It runs with one extra global function, `__ompdeskSendSync(channel, payload)`, a
synchronous page → Node call answered by `ipc.sendSync` below (the Preview's alert/confirm/prompt shim,
`src/main/web/preview-dialog.ts`, uses it instead of Electron's `ipcRenderer.sendSync`). No other global exists in
such a script.

| Method | Asks | Params | Result |
|---|---|---|---|
| `protocol.request` | shell→Node | `{scheme, partition, url, method, headers: [[k, v]], hasBody}` + `bin` = the request body when `hasBody` | `{status, statusText, headers: [[k, v]], streamId}` — the answer is the head; the body follows as events `protocol.chunk {streamId}` (`bin`) and a final `protocol.end {streamId, error?}`, Node → shell. A `{cancel: id}` frame or `protocol.cancel {streamId}` (shell→Node event) means the page dropped the request. Range semantics are Node's (`omp-media://` answers 206 itself). A scheme registered with `stream` is read incrementally. |
| `protocol.chunk` / `protocol.end` (events) | Node | as above | |
| `protocol.cancel` (event) | shell→Node | `{streamId}` | |

A scheme is served by Node only on partitions that called `handleScheme` for it (`omp-media` on the app session,
`omp-visual` on a window's visual partition); a request for it elsewhere fails with `net::ERR_UNKNOWN_URL_SCHEME`.

## 7. `menu.*`, `tray.*`

`MenuItem = {id: string, label?, type?: "normal"\|"separator"\|"submenu"\|"checkbox"\|"radio", enabled?, visible?, checked?, accelerator?, sublabel?, toolTip?, role?, submenu?: MenuItem[]}`.
The shim assigns every `id`; a click on an item with a JS `click` handler or a role it implements itself comes
back as `menu.click`. Roles the shim implements by itself are expanded before sending (it sets the label default and
accelerator); `role` stays set only for those that need native handling: macOS `about`, `services`, `hide`,
`hideOthers`, `unhide`, `front`, `zoom`, `quit`, `minimize`, `close` (and `appMenu`/`windowMenu` containers if used).

| Method | Asks | Params | Result |
|---|---|---|---|
| `menu.setApplication` | Node | `{menuId, template: MenuItem[] \| null}` | `{}` — macOS menu bar; Windows: the window's menu bar is not shown (frameless), but accelerators of the items work while an app window has focus |
| `menu.popup` | Node | `{menuId, template, winId, x?, y?}` | `{itemId: string \| null}` — answered when the menu closes; `null` for a dismissal. Also emits `menu.event` `will-show`/`will-close` |
| `menu.click` (event) | shell→Node | `{menuId, itemId, checked?}` | an item was chosen (application menu, accelerator, tray menu) |
| `menu.event` (event) | shell→Node | `{menuId, name: "will-show"\|"will-close"}` | tray/popup menus |
| `tray.create` | Node | `{trayId, images: [{scaleFactor, dataURL}], template: boolean, tooltip}` | `{}` — the shell picks the closest representation to the display scale |
| `tray.op` | Node | `{trayId, op, args}` | `setToolTip {text}`, `setImage {images, template}`, `setContextMenu {menuId, template}` (right/left click shows it per platform convention), `destroy` |
| `tray.event` (event) | shell→Node | `{trayId, name: "click"\|"right-click"\|"double-click"}` | `click`: Windows left click and macOS click without a menu |

## 8. `dialog.*`, `clipboard.*`, `shell.*`, `notification.*`

| Method | Asks | Params | Result |
|---|---|---|---|
| `dialog.messageBox` | Node | `{winId?, options: {type, buttons, defaultId, cancelId, title, message, detail, checkboxLabel, checkboxChecked, noLink}}` | `{response, checkboxChecked}` — a sheet on macOS when `winId` is given. A `{cancel: id}` (Electron's `signal`) closes the box as the Esc key would and is still answered, with `cancelId`; the shim waits for that answer (`answerAfterCancel`) |
| `dialog.openDialog` | Node | `{winId?, options: {title, defaultPath, buttonLabel, filters: [{name, extensions}], properties: string[], message}}` | `{canceled, filePaths: string[]}` |
| `dialog.saveDialog` | Node | `{winId?, options: {title, defaultPath, buttonLabel, filters, message, nameFieldLabel, showsTagField, properties}}` | `{canceled, filePath?: string}` |
| `clipboard.readText` | Node | `{}` | `{text}` |
| `clipboard.writeText` | Node | `{text}` | `{}` |
| `shell.openExternal` | Node | `{url}` | `{}`; failure → `error.code "failed"` |
| `shell.openPath` | Node | `{path}` | `{error: string}` ("" on success), as Electron |
| `shell.showItemInFolder` | Node | `{path}` | `{}` |
| `shell.trashItem` | Node | `{path}` | `{}`; failure → `error.code "failed"` |
| `shell.beep` | Node | `{}` | `{}` |
| `notification.show` | Node | `{id, title, body, icon?, silent?, urgency?, timeoutType?}` | `{}` (Windows toast keyed on the AppUserModelID; macOS `UNUserNotificationCenter`) |
| `notification.close` | Node | `{id}` | `{}` |
| `notification.event` (event) | shell→Node | `{id, name: "show"\|"click"\|"close"\|"failed", reason?}` | |

## 9. `screen.*`, `theme.*`, `power.*`, `shortcut.*`

| Method | Asks | Params | Result |
|---|---|---|---|
| `screen.changed` (event) | shell→Node | `{displays: Display[], primaryDisplayId, reason: "added"\|"removed"\|"metrics"}` | mirrors `screen.*`; the first value is in `facts` |
| `screen.cursorPoint` | Node | `{}` | `{x, y}` |
| `theme.setSource` | Node | `{source: "system"\|"light"\|"dark"}` | `{dark, highContrast, inverted}` — pushed again as `theme.changed` if the effective scheme moved |
| `theme.changed` (event) | shell→Node | `{dark, highContrast, inverted, reducedMotion}` | OS change or `setSource` effect; mirrors `nativeTheme.shouldUseDarkColors`, `systemPreferences.getAnimationSettings()` |
| `power.event` (event) | shell→Node | `{name: "suspend"\|"resume"\|"lock-screen"\|"unlock-screen"\|"on-ac"\|"on-battery"\|"shutdown", onBattery?: boolean}` | `on-ac`/`on-battery` update the mirrored `isOnBatteryPower()` |
| `power.idleTime` | Node | `{}` | `{seconds}` — idle input time (`GetLastInputInfo` / `CGEventSourceSecondsSinceLastEventType`) |
| `power.blockerStart` | Node | `{id, type: "prevent-app-suspension"\|"prevent-display-sleep"}` | `{}` — `id` is Node's (Electron's `start()` returns it at once) |
| `power.blockerStop` | Node | `{id}` | `{}` |
| `shortcut.register` | Node | `{accelerator}` | `{registered: boolean}` |
| `shortcut.unregister` | Node | `{accelerator}` | `{}` |
| `shortcut.fired` (event) | shell→Node | `{accelerator}` | |
| `net.online` (event) | shell→Node | `{online}` | mirrors `net.isOnline()` |

The system-permission calls main makes on macOS (`systemPreferences.isTrustedAccessibilityClient(prompt)`,
`getMediaAccessStatus("screen")`) are `system.accessibilityTrusted {prompt}` → `{trusted}` and
`system.mediaAccessStatus {mediaType}` → `{status}`; both Node → shell, answered `{trusted: false}` /
`{status: "not-determined"}` off macOS.

## 10. `net.*` (Electron's `net`)

Chromium's network stack through CEF's `CefURLRequest`, so the system proxy, PAC and certificate store are Electron's.

| Method | Asks | Params | Result |
|---|---|---|---|
| `net.fetch` | Node | `{reqId, url, method, headers: [[k, v]], hasBody, redirect: "follow"\|"manual"\|"error", partition?, credentials?: "include"\|"omit"\|"same-origin", bypassCustomProtocolHandlers?: boolean}` + `bin` = the body when `hasBody` | `{status, statusText, url, redirected, headers: [[k, v]]}` once the head arrived; the body follows as events `net.chunk {reqId}` (`bin`) and `net.end {reqId, error?: string}`, shell → Node. `redirect: "manual"` answers the 3xx itself. A `{cancel: id}` frame (or `net.cancel {reqId}` event, Node → shell) aborts. Network failure before the head → `error.code "failed"`, `message` = Chromium's `net::ERR_…`. |
| `net.chunk` / `net.end` (events) | shell→Node | | |
| `net.cancel` (event) | Node | `{reqId}` | |
| `net.login` | shell | `{reqId, isProxy, scheme, host, port, realm}` | `{username, password}` or `{cancel: true}`: an HTTP authentication challenge (server or proxy) of the `net.fetch` `reqId` in flight (CEF `GetAuthCredentials`; answered asynchronously, no timeout on the shell's side beyond the request's own end). The shim raises Electron's `login` on that `net.request` with `authInfo` `{isProxy, scheme, host, port, realm}` and a `callback(username?, password?)`; no listener, or `callback()` with nothing, answers `{cancel: true}` and the challenge's 401/407 is the response, as in Electron. A `net.fetch` made by `net.fetch()` (no `ClientRequest`) always gets `{cancel: true}` |
| `net.resolveHost` | Node | `{host, cacheUsage?}` | `{endpoints: [{address, family: "ipv4"\|"ipv6"}]}` |

`net.request` (the streaming `ClientRequest` API `updater.ts` and electron-updater use) is built by the shim on
`net.fetch` (`redirect: "manual"` + `net.chunk`), with `response`, `redirect`, `error`, `abort` semantics.

## 11. safeStorage

No requests: the shell hands the key over in `facts.safeStorage` and the shim implements Electron's synchronous
API with `node:crypto`, byte-identical to Chromium's OSCrypt (Electron 36), so a value written by either app reads
in the other:

- Windows `{kind: "win-v10", key}`: `key` is the 32-byte AES key from `<userData>/Local State`
  `os_crypt.encrypted_key` (base64; after the ASCII prefix `DPAPI` the rest is DPAPI-protected; the shell
  unwraps it with `CryptUnprotectData`). Encrypt: `"v10" ‖ nonce(12 random) ‖ AES-256-GCM(plaintext) ‖ tag(16)`;
  decrypt reverses it, refusing another prefix.
- macOS: **never read at launch**: any keychain dialog at launch or in the move is a failure. `facts.safeStorage` is
  `{kind: "mac-v10-lazy"}` and the shim reads the key on the **first** `isEncryptionAvailable` / `encryptString` /
  `decryptString` / `getSelectedStorageBackend` call (Electron's own semantics; `update-auth.ts` and `mail-accounts.ts`
  touch safeStorage only when a stored secret exists or one is saved) by a synchronous one-shot of the shell binary
  itself, so the keychain ACL sees the app's own code identity: `execFileSync(facts.exe, ["--keychain-key", userData])`
  (stdin closed, stderr ignored, 120 s limit because the keychain may show its prompt). The process answers **one JSON
  line on stdout** and exits 0: `{"kind":"mac-v10","password":"<base64 of the keychain item's password bytes>"}` or
  `{"unavailable":"<reason>"}` (item missing and not creatable, access denied, …); any other output, a non-zero exit or
  a timeout is treated as unavailable with that reason. It must not start CEF, a window, or a second Node, and must
  not take the single-instance lock. The item is "ompdesk Safe Storage" (account "ompdesk"); key = PBKDF2-HMAC-SHA1(password,
  salt `"saltysalt"`, 1003 iterations, 16 bytes); encrypt: `"v10" ‖ AES-128-CBC(PKCS7, IV = 16 × 0x20)`.
  The one-shot reads with keychain user interaction disabled: a read that **would show a dialog** answers exactly
  `{"unavailable":"keychain-would-ask"}` (`src/shared/keychain.ts` `KEYCHAIN_WOULD_ASK`). The shim then keeps safeStorage
  unavailable for the rest of the run and never runs the one-shot again; `safeStorage.getUnavailableReason()` (shim-only)
  returns that string so main can tell it from other failures. A missing item is created (as Chromium does; creation never
  asks). Other `unavailable` texts: `access to the keychain item "ompdesk Safe Storage" was denied`, or
  `reading the keychain item … failed: … (OSStatus n)`. On `keychain-would-ask` main drops the stored update token
  (`update-token.bin` removed, `update-token.dropped` left, Settings › Updates says why), marks each mail account whose
  password file exists as needing re-entry (`MailAccount.needsReentry`, one in-app notice names them), and refuses to store
  a new secret (`keychain_would_ask`).
- Windows `{kind: "win-v10", key}` stays in the `hello` facts (no prompt exists there).
- `{unavailable: reason}`: `isEncryptionAvailable()` is false, the reason is logged once; `encryptString` and
  `decryptString` throw.
- The shell creates the Windows `Local State` key itself when the file lacks one (first run of a clean profile),
  as Chromium would, so a later Electron install reads it.

## 12. Page ⇄ Node IPC

| Method | Asks | Params | Result |
|---|---|---|---|
| `ipc.invoke` | shell→Node | `{wcId, frameUrl, channel, args}` | `{value}`; a handler's rejection is an error answer (`code "failed"`, `message` = the thrown message) and the page's promise rejects with `Error(message)` |
| `ipc.send` (event) | shell→Node | `{wcId, frameUrl, channel, args}` | fire and forget |
| `ipc.sendSync` | shell→Node | `{wcId, frameUrl, channel, args}` | `{value}` — only `__ompdeskSendSync` and Electron-style `sendSync` channels (`ipcMain.on` handlers that set `event.returnValue`); the shell blocks the page for the answer. Node answers when a handler sets `returnValue` — possibly much later (the Preview's dialog waits for a person, up to 60 s) — and with `null` when no handler listens. The shell sends `{cancel: id}` when the page stops waiting (navigated, closed). |
| `wc.send` | Node | (section 4) | |

Bytes: JSON cannot carry a `Uint8Array`, so the page and the shell write one as `{"$bin": "<base64>"}` anywhere inside `args` of `ipc.invoke` / `ipc.send` / `ipc.sendSync`, inside the `{value}` of an answer and inside `wc.send` `args`; the shell forwards the JSON untouched and the page-side reviver turns it back; the shim decodes incoming `args` to `Buffer` and encodes `Buffer`/`Uint8Array`/`ArrayBuffer` in answers and `wc.send`.

`frameUrl` is the sending frame's URL (`event.senderFrame.url`); Node serves only `app://ompdesk/` for app channels,
and `ipc.sendSync` from Preview partitions only for their registered preload (`__ompdeskSendSync`).

## 13. Values the shim mirrors (sync getters)

| Electron | Source |
|---|---|
| `app.getPath(name)`, `getLocale`, `getSystemLocale`, `getPreferredSystemLanguages`, `getAppPath`, `isPackaged`, `process.resourcesPath` | `facts` |
| `app.getGPUFeatureStatus()` | last `app.getGPUInfo` answer (`{}` before) |
| `screen.getPrimaryDisplay/getAllDisplays/getDisplayMatching/getDisplayNearestPoint` | `facts.displays` + `screen.changed` |
| `nativeTheme.shouldUseDarkColors`, `…HighContrastColors`, `…InvertedColorScheme`, `themeSource` | `facts.theme` + `theme.changed`; `themeSource` is what Node last set |
| `systemPreferences.getAnimationSettings().prefersReducedMotion` | `facts.system.reducedMotion` + `theme.changed` |
| `powerMonitor.isOnBatteryPower()` | `facts.system.onBattery` + `power.event` |
| `net.isOnline()` | `facts.system.online` + `net.online` |
| `BrowserWindow#getBounds/isMaximized/isMinimized/isVisible/isFocused/isFullScreen/getContentSize/getTitle/getOpacity` | `win.state` |
| `webContents#getURL/isLoading/getTitle/getZoomFactor/getUserAgent/navigationHistory.canGoBack/canGoForward/isCrashed` | `wc.state` |
| `session#getUserAgent/getSpellCheckerLanguages/availableSpellCheckerLanguages` | `session.create` |
| `safeStorage.*` | `facts.safeStorage` |

Made asynchronous (cannot be mirrored; each call site changed, see `src/main/shell-host/INVENTORY.md`):
`clipboard.readText()` → `readClipboardText()` (`clipboard.readText` request), `powerMonitor.getSystemIdleTime()` →
`systemIdleSeconds()` (`power.idleTime`), `NativeImage#toJPEG/toPNG/resize` of a captured or painted page →
`capturePage`/`wc.frame` encode options.

## 14. Shell deviations (ShellCrate records here)

What the Rust shell does differently from this table or from Electron. README.md › Deviations has the user-visible list.

- **Startup**: `hello`'s answer carries `facts` (also `rendererRoot`, the folder served as `app://ompdesk/`:
  `<dirname(main script)>/../renderer`, where the main script is `OMPDESK_APP_ENTRY` or `<appDir>/out/main/index.js`).
  `app.init` is answered `{}` after CEF initialised; `app.ready` follows `on_context_initialized`. Node's argv after the
  executable is the shell's own argv after it. `OMPDESK_APP_ENTRY`, `OMPDESK_APP_DIR`, `OMPDESK_NODE`,
  `OMP_GUI_TEST_USER_DATA_DIR`, `OMP_GUI_TEST_NODE_INSPECT` are the shell's environment seams.
- **Ids**: Node's `winId`/`wcId`/`viewId` are used as sent; the shell's own counters only serve a create that omits them.
- **`app.exit`**: windows close without `win.closeRequested`; browsers that have not closed after 4 s do not hold the quit.
  Node dying unexpectedly: the shell exits 1 after logging it on stderr.
- **`app.secondInstance`** is sent for a second launch of the same user-data folder (named pipe, unix socket on macOS: `$TMPDIR/ompdesk-<16 hex of SHA-256(userData)>-shell.sock`, `/tmp/…` when TMPDIR is long, 0600; the host socket Node gets is `…-host-<pid>.sock` beside it);
  `app.openUrl`, `app.openFile`, `app.activate` are macOS only and unverified.
- **`wc.navigate`**: for main-frame navigations Node did not start itself. A click on a `file:` link is reported by the
  injected preload (`POST /__shell/will-navigate`) and the request is sent without waiting for the answer: Blink refuses
  that navigation before the browser process sees it, so it is always blocked.
  `isSameDocument` is always false. As in Electron, a reload, a back/forward step or a fragment change of the shown
  document is not asked about (`transition.rs`): the main script prevents every navigation it is asked about that it did
  not start, which would cancel a DevTools reload.
- **`wc.event`**: `did-navigate` carries status 200 / "OK" (CEF gives none there); `did-start-navigation` is per frame,
  with `frameProcessId`/`frameRoutingId` 0; `will-prevent-unload` is
  not produced (the before-unload dialog is accepted without asking).
- **`input-event`** comes from the page: once a page watches it, the shell enables `Runtime` and `Page` on the page's
  DevTools session and registers a script in an isolated world of its own (`ompdesk-input`) that reports each trusted
  `pointerup`/`keyup` through a binding only that world has (`input_watch.rs`); the binding's calls never reach a
  debugger, and a debugger's detach arms the page again. A release on an out-of-process frame is not seen.
- **`wc.windowOpen`** is sent but not waited for: the popup is always cancelled.
- **`wc.op`**: `setBackgroundThrottling` and `ignoreBeforeUnload` are accepted and do nothing; `copyImageAt` copies through
  the page's clipboard API; `executeJavaScript` is CDP `Runtime.evaluate` (by value, promises awaited).
- **`wc.cdp.send`**: every call times out after 60 s with `timeout`.
- **`wc.frame`**: `width` scales by area averaging, never up.
- **`win.op`**: `setMenuBarVisibility`, `setAutoHideMenuBar`, `setBackgroundMaterial` (Mica is set at creation) are
  accepted and do nothing. `setProgressBar {value, mode?}`: Windows shows it through `ITaskbarList3` (`value` 0..1
  determinate, below 0 removes the bar, above 1 indeterminate; `mode` none, normal, indeterminate, error or paused
  overrides), retried for 2 s while the taskbar button does not exist yet; macOS draws it on the Dock tile with an
  `NSProgressIndicator` (UNVERIFIED); on a window that cannot take focus `show` and `showInactive` do not activate and
  `win.state.focused` stays false.
- **`win.closeRequested`**: no answer within 5 s closes the window.
- **`view.*`**: a view is hidden until its first `setVisible`/`setBounds` with a non-empty size; an empty `setBounds` only
  hides the view (a zero-sized browser view is a fatal check in Chromium).
- **`session.*`**: `setProxy` writes Chromium's `proxy` preference; `resolveProxy` is answered from the user's WinINET /
  WinHTTP settings on Windows, not Chromium's resolver; on macOS from CFNetwork's system proxy settings (static
  HTTP/HTTPS/SOCKS, the exceptions list, exclude-simple-hostnames; a PAC script or auto-discovery is run through
  `CFNetworkExecuteProxyAutoConfigurationURL` on a run loop for at most 3 s on the calling thread and falls back to the
  fixed settings; a script answer is read for none/HTTP/HTTPS/SOCKS only and an HTTPS entry is written `PROXY`;
  UNVERIFIED on macOS). `setSpellCheckerLanguages {languages}` normalises the codes (`en_US` to `en-US`; a language without
  a dictionary falls back to its bare or first regional one, else is dropped) and writes Chromium's `spellcheck.dictionaries`
  (and `browser.enable_spellchecking`) on the partition's context; `addWordToSpellCheckerDictionary {word}` adds to the
  profile's custom dictionary through a page of that partition and answers `failed` when it has none yet. Chromium
  downloads a language's dictionary on first use (needs network) or uses the OS spellchecker where it has the language.
  `session.create` reports `spellCheckerLanguages` (what was set; for `app` the preference's value), the fixed
  `availableSpellCheckerLanguages` list of Chromium's dictionary codes and `cachePath` (`app`:
  `<userData>/shell-webview/Default/Cache`; `persist:<n>`: `<userData>/shell-webview/Partitions/<n>/Cache`, inferred;
  in-memory: `null`). `clearCache`/`clearStorageData` on `app` run DevTools `Network.clearBrowserCache` (plus
  `clearBrowserCookies`) on the first app page, never touching Local Storage, and clear the global context directly only
  when no page exists. They do nothing for an in-memory partition (clearing a Chrome-style in-memory context ends the
  process). Creating the Preview's two in-memory contexts logs Chromium's non-fatal `NOTREACHED hit. Observers can only be
  added once!` on stderr.
- **`protocol.request`**: request headers are one `[name, value]` pair per value; a failed head fails the request with
  `ERR_FAILED`.
- **`ipc.sendSync`** is sent from a `prompt()` the Preview preload's `__ompdeskSendSync` makes (message starting with NUL +
  `omp-sync:`); it is answered when Node answers, and the page waits in the dialog meanwhile, not the UI thread.
- **Page transport**: `Uint8Array` crosses as `{"$bin": "<base64>"}` in `ipc.invoke`/`ipc.send` args, `wc.send` args and
  `{value}` of an invoke answer; the shim decodes and encodes it.
- **`dialog.*`**: Windows dialogs run on a thread of their own (their modal loop does not block CEF's UI thread); a
  macOS `messageBox` is app-modal, not a sheet. A cancelled message box: Windows clicks the TaskDialog's IDCANCEL,
  macOS `abortModal`s the session (queued on the main thread; a cancel in the instant between `runModal` returning and
  the box being forgotten aborts the next modal session, if one has started by then). File dialogs are not cancelled.
- **`notification.*`**: WinRT toasts keyed on the AppUserModelID; without a Start-menu shortcut carrying it a toast may
  not show, though `show` is still reported.
- **`theme.setSource`** is pushed into every page as CDP `Emulation.setEmulatedMedia` (`prefers-color-scheme`) and reaches
  native chrome: Windows sets `DWMWA_USE_IMMERSIVE_DARK_MODE` on every window (when the source changes, on window creation
  and on `theme.changed`), macOS sets `NSApp.appearance` (UNVERIFIED).
- **`app.childProcessGone`**: CEF has no callback for a helper process ending, so a thread polls the shell's children once
  a second and reports a gone non-renderer, non-crashpad child. Windows: ToolHelp plus `--type=` from the command line, the
  exit code from the process handle; reasons come from the NTSTATUS table in `shell_core::childproc::reason` (exit code 1 is
  `killed`). macOS (UNVERIFIED): children from `proc_listpids(PROC_PPID_ONLY)`, `--type=` read once from `KERN_PROCARGS2`,
  liveness by `kill(pid, 0)`; the helpers are Chromium's to reap, so no status is readable and a helper that disappears is
  `reason: "crashed"`, `exitCode: -1`. A helper that lives under a second is missed, and nothing is reported once the shell
  is exiting (an app quit).
- **`win.event`** `unresponsive`/`responsive` is sent for a window's main page in addition to its `wc.event`; views and
  Preview pages produce only the `wc.event`.
- **`wc.event preload-error`** `[preloadPath, {message, stack}]` is produced for `shell.js` throwing in an app page, via
  `POST /__shell/preload-error`; a throw in a Preview partition's preload (`app.rs`) is not reported.
- **`net.fetch`**: `credentials: "same-origin"` behaves as `include`; `resolveHost` with `cacheUsage: "disallowed"` (or `"disabled"`) resolves with the OS resolver (`getaddrinfo`) on a worker thread, bypassing Chromium's host cache (it ignores Chromium's own DNS configuration, the OS resolver's cache still applies, and it answers `net::ERR_NAME_NOT_RESOLVED` after at most 15 s; `staleAllowed` behaves as `allowed`); an HTTP 401/407 challenge of a `net.fetch` is asked of Node with `net.login` (CEF re-asks after wrong credentials); request headers
  `Content-Length`, `Host`, `Connection`, `Transfer-Encoding` are not forwarded; a body is streamed without back-pressure.
- **Application menu accelerators** are matched by a message hook for typed keys; a key sent through the DevTools protocol
  (the e2e harness) reaches the shell as an unhandled key event and is matched there.
- **`OMP_GUI_TEST_SHELL_FAIL_START=1`** (test seam): the shell exits 1 right after CEF initialised, before `app.init` is
  answered, so the installer's swap-back path can be exercised. The "app started" mark (`<userData>/app-started.json`) is
  written by the app's main script, not by the shell.
- **macOS launcher** (`ompdesk-launcher`, `launcher.rs`, `launcher_main.rs`): the bundle's `CFBundleExecutable`
  (`Contents/MacOS/OMPdesk`); the shell is `Contents/MacOS/ompdesk-shell`, which the launcher `exec`s with the same argv (the
  app's pid stays the shell's). Armed only when `<userData>/update-install.json` has `to` == the bundle's
  `CFBundleShortVersionString` and `<userData>/app-started.json` does not hold that version: it then leaves a detached copy
  of itself (`--ompdesk-launcher-watch`, stdio to `<userData>/updates/swap.log`) that waits up to 120 s (also: the shell's pid
  gone for 10 s) for the mark. Not seen: `<bundle>.previous` present → the old app's swap script owns the rollback
  (`start failed; the swap restores`); else the shell and every process under `<bundle>/Contents/` are ended and the last
  Electron release (`last-electron.json` → compile-time `OMPDESK_LAST_ELECTRON_TAG`) is fetched with `/usr/bin/curl`
  (`GET <api>/repos/SeuPut0705/ompdesk/releases/tags/<tag>`, its `<!-- ompdesk-update … -->` comment, the `ompdesk-mac-arm64.dmg`
  asset by its API `url` with `Accept: application/octet-stream`), SHA-512 and size checked, mounted read-only, copied out,
  `codesign --verify --deep --strict`, bundle id and version checked, swapped in (`<bundle>.failed` aside, the S bundle put
  back on any failure) and opened with `open -n`. swap.log lines: `swap <date>: start check <bundle> -> <bundle>`, then
  `started` | `start failed; the swap restores` | `rollback: ending <pids>`, `fetching <tag>`, `download ok <bytes>`,
  `sha512 ok`, `staged <path>`, `verified`, `swapped`, `opened`, and `start failed; previous app restored` or
  `start failed; restore failed: <why>`. Test seams (only beside `OMP_GUI_TEST_USER_DATA_DIR`):
  `OMPDESK_LAUNCHER_RELEASE_URL` (the API base) and `OMPDESK_LAUNCHER_START_WAIT_S`. Compiled on macOS by CI only.
- **Diagnostics**: `OMPDESK_SHELL_TRACE=1` logs every host request (`host.request`); a Rust panic writes
  `%TEMP%/ompdesk-shell-panic.log`.
- **`menu.popup`** answers `null` when another popup is open; popup choices never emit `menu.click`.
- **macOS**: `facts.safeStorage` is `{kind: "mac-v10-lazy"}` (the key is fetched with `--keychain-key <userData>`, never at
  launch); every CEF process runs with `--use-mock-keychain`; Cmd-Q sends `app.quitRequested`. All macOS code is
  unverified on a Mac.
