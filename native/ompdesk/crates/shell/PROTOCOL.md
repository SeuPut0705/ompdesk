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
| `input-event` | `[{type: "mouseUp"\|"keyUp"}]` — **real** OS input only (CDP-dispatched input never produces it) |
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
| `session.create` | Node | `{partition, cache?: boolean}` | `{userAgent, acceptLanguages, spellCheckerLanguages: string[], availableSpellCheckerLanguages: string[]}` — idempotent; the shim mirrors these for `getUserAgent()`, `getSpellCheckerLanguages()`, `availableSpellCheckerLanguages` |
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
| `dialog.messageBox` | Node | `{winId?, options: {type, buttons, defaultId, cancelId, title, message, detail, checkboxLabel, checkboxChecked, noLink}}` | `{response, checkboxChecked}` — a sheet on macOS when `winId` is given |
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

_(none yet)_
