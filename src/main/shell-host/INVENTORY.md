# Electron APIs `src/main` uses, and what the shell swap did to each

Static inventory, 12 Nov 2026 (every `import … from "electron"`, `original-fs`, `electron-store`, `electron-updater`
in `src/main/**` and `src/preload/**`, plus the members they call). `native/ompdesk/crates/shell/PROTOCOL.md` has the
frames; `electron/*.ts` has the shim. `electron-log` is a dependency nothing imports.

## Used by main, served by the shim as under Electron

| Module | Members main uses |
|---|---|
| `app` | `isPackaged`, `name`/`getName`/`setName`, `getVersion`, `getAppPath`, `getPath` (userData, appData, temp, downloads, exe…), `setPath`, `getLocale`, `getPreferredSystemLanguages`, `commandLine.{appendSwitch,hasSwitch,getSwitchValue}`, `setAppUserModelId`, `setAboutPanelOptions`, `showAboutPanel`, `setActivationPolicy`, `requestSingleInstanceLock`, `whenReady`, `quit`, `exit`, `relaunch`, `hide`, `getGPUInfo`, `getGPUFeatureStatus`, `dock.{setBadge,setIcon}`; events `ready`, `before-quit`, `will-quit`, `quit`, `window-all-closed`, `browser-window-created`, `browser-window-focus`, `child-process-gone` |
| `BrowserWindow` | `new` (+ `webPreferences`, `titleBarOverlay`, `backgroundMaterial`…), `getAllWindows`, `getFocusedWindow`, `fromWebContents`, `id`, `webContents`, `contentView.{addChildView,removeChildView}`, `show`, `showInactive`, `hide`, `close`, `focus`, `restore`, `minimize`, `maximize`, `isDestroyed`, `isVisible`, `isFocused`, `isMinimized`, `isMaximized`, `getBounds`, `getContentSize`, `setOpacity`, `setIgnoreMouseEvents`, `setSkipTaskbar`, `setFocusable`, `setProgressBar`, `setTitleBarOverlay`, `loadURL`, `loadFile`; events `close`, `closed`, `show`, `hide`, `minimize`, `restore`, `ready-to-show`, `unresponsive` |
| `webContents` | `id`, `send`, `getURL`, `getTitle`, `isLoading`, `isDestroyed`, `loadURL`, `stop`, `reload`, `executeJavaScript`, `executeJavaScriptInIsolatedWorld`, `setWindowOpenHandler`, `session`, `replaceMisspelling`, `copyImageAt`, `getZoomFactor`/`setZoomFactor`, `navigationHistory.*`, `setWebRTCIPHandlingPolicy`, `setFrameRate`, `invalidate`, `startPainting`, `stopPainting`, `capturePage`, `printToPDF`, `sendInputEvent`, `insertText`, `getUserAgent`, `close`, `debugger.{attach,detach,isAttached,sendCommand,on}`; events `did-start-loading`, `did-stop-loading`, `did-finish-load`, `did-fail-load`, `did-navigate`, `did-navigate-in-page`, `did-start-navigation`, `page-title-updated`, `dom-ready`, `render-process-gone`, `console-message`, `context-menu`, `preload-error`, `input-event`, `unresponsive`, `responsive`, `will-navigate`, `will-frame-navigate`, `will-redirect`, `will-attach-webview` (never raised: no `<webview>` exists), `will-prevent-unload`, `paint`, `destroyed` |
| `WebContentsView` | `new({webPreferences})`, `webContents`, `setVisible` |
| `session` | `defaultSession`, `fromPartition`, `resolveProxy`, `clearCache`, `clearStorageData`, `setProxy`, `setUserAgent`/`getUserAgent`, `getSpellCheckerLanguages`/`setSpellCheckerLanguages`/`availableSpellCheckerLanguages`, `addWordToSpellCheckerDictionary`, `setPermissionRequestHandler`/`setPermissionCheckHandler` (deny-all handlers only), `registerPreloadScript`, `protocol.handle`, `on("will-download")` |
| `protocol` | `registerSchemesAsPrivileged`, `handle` |
| `ipcMain` | `handle`, `on` (through `IpcRegistry`, and the Preview's dialog channel) |
| `dialog` | `showMessageBox`, `showOpenDialog`, `showSaveDialog` (with and without an owner window) |
| `clipboard`, `shell` | `writeText`; `openExternal`, `openPath`, `showItemInFolder`, `trashItem` |
| `Notification` | `new`, `show`, `close`, `on("click"/"close")` |
| `screen`, `nativeTheme`, `powerMonitor`, `powerSaveBlocker`, `globalShortcut` | `getPrimaryDisplay`, `getAllDisplays`; `shouldUseDarkColors`, `themeSource`; `on("suspend"/"resume"/"unlock-screen"/"on-ac"/"on-battery")`, `isOnBatteryPower`; `start`, `stop`; `register` |
| `net` | `fetch`, `request` (`redirect: "manual"`, `setHeader`, `on("redirect"/"response"/"error")`, `abort`), `isOnline`, `resolveHost` |
| `nativeImage` | `createFromPath`, `createFromDataURL`; `addRepresentation`, `setTemplateImage` |
| `safeStorage` | `isEncryptionAvailable`, `encryptString`, `decryptString` |
| `systemPreferences` | `getAnimationSettings` |
| `autoUpdater` (native) | `on`, `emit` only: `electron-updater` listens to it, and `NsisUpdater`/`MacUpdater` in the modes main uses never call its Squirrel methods |
| `electron-store` | `app.getPath("userData")`, `app.getVersion()`, `ipcMain.on("electron-store-get-data")`, `shell.openPath` |
| `electron-updater` | `app.{getVersion,getName,isPackaged,getPath,getAppPath,whenReady,quit,relaunch,once("quit")}`, `process.resourcesPath`, `net.request` through `session.fromPartition("electron-updater")`, `shell.openPath`, `Notification` (unused here), `autoUpdater.emit("before-quit-for-update")` |
| `process` | `resourcesPath` (defined by the shim from the facts), `versions.chrome` (CEF's), `versions.shell`, `versions.cef` |

## Made different, and what each call site does now

| Electron | Why it cannot stay | Now |
|---|---|---|
| `clipboard.readText()` | the clipboard is the shell's; a socket round trip is asynchronous | the shim's `readText()` throws; `shell-host/shell-calls.ts` `readClipboardText()` asks. Callers: `index.ts` (`readClipboard` of the Memory password copy, whose check now awaits) and `ipc.ts` (`gui_clipboard_read`, whose tool result now settles on the answer) |
| `powerMonitor.getSystemIdleTime()` | same | throws; `systemIdleSeconds()` is read just before each auto-install look (`updater.ts` `tickAutoInstall`), and the scheduler's synchronous facts hold that last value: never ahead of the moment of decision, so a person who just touched the computer is not taken for idle (it can only be older) |
| `systemPreferences.isTrustedAccessibilityClient`, `getMediaAccessStatus` | same (macOS) | throw; `accessibilityTrusted()` / `screenRecordingGranted()`; `MacPermissionDeps` accept a promise |
| `NativeImage#resize/toPNG/toJPEG` on a captured or painted page | no bitmap codec in main; the shell holds the pixels | `capturePage` returns PNG bytes that remember how to be captured again at another scale (`fitImage()` in `shell-host/image.ts`: `Page.captureScreenshot` `clip.scale`); a paint is a frame the shell encodes on request (`encodeImage()`, `wc.frame`). `preview/host.ts` (`paintImage`, region capture, the Preview check) and `web/preview-stream.ts` (`PaintImage.jpeg()` is asynchronous; `PageStream` encodes one frame at a time, drops a frame whose page navigated meanwhile, and parks one whose poll left) |
| `session.setPermissionRequestHandler(fn)` | a function cannot cross the socket | probed once with every permission: deny-all becomes the shell's `setPermissions deny-all` policy; a handler that grants anything throws |
| `registerPreloadScript` of the Preview's dialog shim | it used `contextBridge` and `ipcRenderer.sendSync` | `web/preview-dialog.ts` `DIALOG_PRELOAD_SOURCE` is a plain script using the shell's `__ompdeskSendSync` (taken and removed from `globalThis` first); `ipcMain.on` answers when a handler sets `returnValue`, however late |
| `process.getSystemVersion()` | Node has none | `system-version.ts` `systemVersion()` (Windows `os.release()`, macOS from the Darwin kernel) |
| `process.versions.electron` (system info, feedback, diagnostics) | no Electron | `shellEngine()` (`ompdesk-shell 0.1.0, CEF 156.0.26`); the shared type's key stays `electron`, the labels read "Shell" |
| `process.defaultApp`, `process.execPath` | main is `node <bundle> <the shell's args>` | `index.ts` reads arguments from `process.argv.slice(2)`; the shell reads a second launch's argv itself (`chrome.deepLink`) and registers `omp://` on its own exe (`chrome.linksReady {register}`); `updater.ts` reads the bundle from `app.getPath("exe")` and reopens with `process.argv.slice(2)` |
| `original-fs` / `node:original-fs` | no asar: nothing patches `fs` | every import is `node:fs`; `user-folder-fs.test.ts` (the guard against the patched `fs`) and the vitest alias are gone |
| `app.asar` identity (the old `window.ts`' "resources changed" restart) | no archive | the renderer entry `out/renderer/index.html`'s identity (`modules/chrome/window.rs`: size and mtime, plus the creation time on Windows) |
| `win.webContents` `preload` option | the shell injects `window.omp` itself | no preload in the shell's window creation (`modules/chrome/window.rs`); `src/preload/index.ts` (contextBridge + `webUtils`) is deleted once `src/preload/shell.ts` exists (`fs.pathForFile` is the shell's) |
| `autoUpdater` (Squirrel) | not in the shell | emitter only; its methods throw. macOS "relaunch"/"manual" modes never call them |
| `globalShortcut.register()` | returns synchronously | returns `true`; a refusal by the OS is logged and the shortcut forgotten |
| HTTP cache folder (`<userData>/Cache`, disk care) | CEF keeps it under `<userData>/shell-webview` | `shell-calls.ts` `defaultSessionCachePath()` (the shim `Session.getCachePath()`, from `session.create`'s `cachePath`) feeds `DiskCare`'s `httpCachePath`; null → the Electron path |

## Deleted

`src/main/user-folder-fs.test.ts`; the `original-fs` alias in `vitest.config.ts`; the `electron`/`original-fs`
externals in `electron.vite.config.ts` (and the `electron`/`original-fs`/`node:original-fs` allowance in
`scripts/check-main-bundle.ts`); `process.defaultApp` branches in `deep-link.ts` and `index.ts`; the `preload:`
option of `window.ts`; `process.getSystemVersion()`/`process.versions.electron` reads; `Electron.*` sync NativeImage
handling in `preview-stream.ts`. Batch SX1 (the `chrome` module) deleted `window.ts`, `menu.ts`, `tray.ts`,
`app-quit.ts`, `deep-link.ts`, `gpu-fallback.ts`, `hang-watchdog.ts` and `app-icon.ts` with their rule files, and the
shim's `Menu`, `MenuItem`, `Tray`, `menu.*`/`tray.*` frames, `app.setAsDefaultProtocolClient`, the `activate`,
`second-instance`, `open-url` and `open-file` events and `app.quitRequested` (the module is the only caller left of
each, PROTOCOL.md §15.5).
