# Electron APIs `src/main` uses, and what the shell swap did to each

Static inventory, 12 Nov 2026 (every `import … from "electron"`, `original-fs`, `electron-store`, `electron-updater`
in `src/main/**` and `src/preload/**`, plus the members they call). `native/ompdesk/crates/shell/PROTOCOL.md` has the
frames; `electron/*.ts` has the shim. `electron-log` is a dependency nothing imports.

## Used by main, served by the shim as under Electron

| Module | Members main uses |
|---|---|
| `app` | `isPackaged`, `name`/`getName`/`setName`, `getVersion`, `getAppPath`, `getPath` (userData, appData, temp, downloads, exe…), `setPath`, `getLocale`, `getPreferredSystemLanguages`, `commandLine.{appendSwitch,hasSwitch,getSwitchValue}`, `disableHardwareAcceleration`, `setAppUserModelId`, `setAboutPanelOptions`, `showAboutPanel`, `setActivationPolicy`, `requestSingleInstanceLock`, `whenReady`, `quit`, `exit`, `relaunch`, `hide`, `setAsDefaultProtocolClient`, `getGPUInfo`, `getGPUFeatureStatus`, `dock.{setBadge,setIcon}`; events `ready`, `before-quit`, `will-quit`, `quit`, `window-all-closed`, `activate`, `second-instance`, `open-url`, `open-file`, `browser-window-created`, `browser-window-focus`, `child-process-gone` |
| `BrowserWindow` | `new` (+ `webPreferences`, `titleBarOverlay`, `backgroundMaterial`…), `getAllWindows`, `getFocusedWindow`, `fromWebContents`, `id`, `webContents`, `contentView.{addChildView,removeChildView}`, `show`, `showInactive`, `hide`, `close`, `focus`, `restore`, `minimize`, `maximize`, `isDestroyed`, `isVisible`, `isFocused`, `isMinimized`, `isMaximized`, `getBounds`, `getContentSize`, `setOpacity`, `setIgnoreMouseEvents`, `setSkipTaskbar`, `setFocusable`, `setProgressBar`, `setTitleBarOverlay`, `loadURL`, `loadFile`; events `close`, `closed`, `show`, `hide`, `minimize`, `restore`, `ready-to-show`, `unresponsive` |
| `webContents` | `id`, `send`, `getURL`, `getTitle`, `isLoading`, `isDestroyed`, `loadURL`, `stop`, `reload`, `executeJavaScript`, `setWindowOpenHandler`, `session`, `replaceMisspelling`, `copyImageAt`, `getZoomFactor`/`setZoomFactor`, `capturePage`, `close`, `debugger.{attach,detach,isAttached,sendCommand,on}`; events `did-start-loading`, `did-stop-loading`, `did-finish-load`, `did-fail-load`, `did-navigate`, `did-navigate-in-page`, `did-start-navigation`, `page-title-updated`, `dom-ready`, `render-process-gone`, `console-message`, `context-menu`, `preload-error`, `input-event`, `unresponsive`, `responsive`, `will-navigate`, `will-frame-navigate`, `will-redirect`, `will-attach-webview` (never raised: no `<webview>` exists), `will-prevent-unload`, `paint`, `destroyed` |
| `session` | `defaultSession`, `fromPartition`, `resolveProxy`, `clearCache`, `getSpellCheckerLanguages`/`setSpellCheckerLanguages`/`availableSpellCheckerLanguages`, `addWordToSpellCheckerDictionary`, `protocol.handle` |
| `protocol` | `registerSchemesAsPrivileged`, `handle` |
| `ipcMain` | `handle`, `on` (through `IpcRegistry`) |
| `Menu`, `MenuItem`, `Tray` | `buildFromTemplate`, `setApplicationMenu`, `popup`, `on("menu-will-show"/"menu-will-close")`; template `role`, `accelerator`, `submenu`, `click`; `Tray` `setToolTip`, `setContextMenu`, `destroy`, `on("click")` |
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
| `NativeImage#resize/toPNG/toJPEG` on a captured page | no bitmap codec in main | `capturePage` returns the PNG bytes the shell's CDP gave (`Page.captureScreenshot`); another size or format is asked of the page by the caller. The Preview's pictures (frames, region and check captures) are the shell's `preview` module's, never Node's |
| `process.getSystemVersion()` | Node has none | `system-version.ts` `systemVersion()` (Windows `os.release()`, macOS from the Darwin kernel) |
| `process.versions.electron` (system info, feedback, diagnostics) | no Electron | `shellEngine()` (`ompdesk-shell 0.1.0, CEF 156.0.26`); the shared type's key stays `electron`, the labels read "Shell" |
| `process.defaultApp`, `process.execPath` | main is `node <bundle> <the shell's args>` | `index.ts` reads arguments from `process.argv.slice(2)`, `deep-link.ts` from `argv.slice(1)` of a second launch; `setAsDefaultProtocolClient(PROTOCOL)` always registers the shell's own exe; `updater.ts` reads the bundle from `app.getPath("exe")` and reopens with `process.argv.slice(2)` |
| `original-fs` / `node:original-fs` | no asar: nothing patches `fs` | every import is `node:fs`; `user-folder-fs.test.ts` (the guard against the patched `fs`) and the vitest alias are gone |
| `app.asar` identity (window.ts' "resources changed" restart) | no archive | the renderer entry `out/renderer/index.html`'s identity |
| `win.webContents` `preload` option | the shell injects `window.omp` itself | dropped from `window.ts`; `src/preload/index.ts` (contextBridge + `webUtils`) is deleted once `src/preload/shell.ts` exists (`fs.pathForFile` is the shell's) |
| `autoUpdater` (Squirrel) | not in the shell | emitter only; its methods throw. macOS "relaunch"/"manual" modes never call them |
| `globalShortcut.register()` | returns synchronously | returns `true`; a refusal by the OS is logged and the shortcut forgotten |
| `app.setAsDefaultProtocolClient()` | returns synchronously | returns `true`; a refusal is logged |
| HTTP cache folder (`<userData>/Cache`, disk care) | CEF keeps it under `<userData>/shell-webview` | `shell-calls.ts` `defaultSessionCachePath()` (the shim `Session.getCachePath()`, from `session.create`'s `cachePath`) feeds `DiskCare`'s `httpCachePath`; null → the Electron path |

## Deleted

`src/main/user-folder-fs.test.ts`; the `original-fs` alias in `vitest.config.ts`; the `electron`/`original-fs`
externals in `electron.vite.config.ts` (and the `electron`/`original-fs`/`node:original-fs` allowance in
`scripts/check-main-bundle.ts`); `process.defaultApp` branches in `deep-link.ts` and `index.ts`; the `preload:`
option of `window.ts`; `process.getSystemVersion()`/`process.versions.electron` reads; `Electron.*` sync NativeImage
handling in `preview-stream.ts`.

SX2 (the Preview moved into the shell's `preview` module, PROTOCOL.md §15.6): `WebContentsView`/`contentView`, offscreen
windows, `paint` and `wc.frame` with the frame-source `NativeImage` and `shell-host/image.ts`, capture rescaling,
`setFrameRate`/`invalidate`/`startPainting`/`stopPainting`, `session.setPermissionRequestHandler`/
`setPermissionCheckHandler`, `registerPreloadScript`, `will-download` with `session.download`, and `ipc.sendSync` (with
`__ompdeskSendSync`) have no caller in `src/main` and are deleted with their `create.test.ts` cases. Removed with it, as no caller was left in `src/main` or `e2e`: `navigationHistory`, `executeJavaScriptInIsolatedWorld`,
`printToPDF`, `sendInputEvent` (with `input-events.ts`), `insertText`, `getUserAgent`, `setWebRTCIPHandlingPolicy`,
`session.setProxy`/`setUserAgent`/`getUserAgent`/`getAcceptLanguages`/`clearStorageData`. `getZoomFactor`/`setZoomFactor`
stay (`menu.ts`, `e2e/desktop.e2e.ts`).
