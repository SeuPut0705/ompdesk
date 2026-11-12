# macOS (Apple silicon) run sheet for candidate (a) and what is unverified

Everything below was written on Windows without a compiler for macOS. The Windows build is unchanged (it still compiles and passes the self-tests).

## Run it (on the Mac mini, macOS 26)
Prereqs: Xcode command line tools (`xcode-select --install`), `rustup`, `brew install cmake ninja`, Python 3, and the renderer built (`bun run build` -> `out/renderer`; `shell-assets/stand-in.js` and `video.webm` built as for Windows).
```
cd native/shell-prototype/cef
BUNDLE_ID=com.seuput.ompdesk.proto BUNDLE_VERSION=0.200.0 SIGN_IDENTITY=- ./bundle-mac.sh      # ad-hoc; or SIGN_IDENTITY="Developer ID Application: ..."
target/mac/OMPdesk.app/Contents/MacOS/OMPdesk --selftest --preview app://ompdesk/__shell/preview-test.html --debug-port 9301 --exit-after 60 --log /tmp/shell-cef.log.jsonl
curl -s 127.0.0.1:9301/json/list
open 'ompdesk-proto://open?x=1'        # second instance / Apple Event: expect a `deeplink` event
```
`OMPdesk.app` is also launchable by double-click (no flags: no Preview, no selftest). Preview host: `target/mac/OMPdesk Preview.app/Contents/MacOS/OMPdesk Preview --url <u> --cdp-port 9303 --offscreen --size 800,600`.
`bundle-mac.sh` fetches the CEF macosarm64 minimal archive itself (the crate's build script cannot read CEF's 10 MB index.json) and serves it from a temporary `python3 -m http.server` on 127.0.0.1:8123.

## What the code does on macOS
- `shared/mac_app.rs`: `NSApplication` subclass with `CefAppProtocol` (ported from cef-rs `cefsimple`), installed before anything touches `NSApp`; `terminate:` routes to the app's quit path.
- `shell-cef/src/mac.rs`: app delegate; `kAEGetURL` Apple Event -> `deeplink {from:"apple-event"}`; Dock re-open -> show window.
- Library loading (`cef::library_loader::LibraryLoader`): main exe loads `../Frameworks/Chromium Embedded Framework.framework`; helper apps load it `../../..` up. The same binary is the main exe and all five helpers (it acts as helper when started with `--type=`), so the custom scheme registration is in every process.
- Window: Views frameless + `with_standard_window_buttons` + `titlebar_height 46` (traffic lights centred at y=23, i.e. a 12 px button top at y=17). The page's `-webkit-app-region` regions go through the same `Window::set_draggable_regions` call as on Windows. No caption popup.
- Single instance: CEF profile singleton (`root_cache_path`) + `on_already_running_app_relaunch`, as on Windows. Tray: `tray-icon` (menu bar). User data: `~/Library/Application Support/ompdesk-proto`. `renderer/` and `shell-assets/` are looked up in `Contents/Resources` (after flag, env, `<exe dir>`).
- Scheme registration: `CFBundleURLTypes` `ompdesk-proto` in Info.plist (`--register-protocol` is a no-op); `lsregister -f` once.

## Unverified (nothing here has been compiled or run on a Mac)
1. Compilation of `shared/mac_app.rs`, `shell-cef/src/mac.rs` and the mac branches in both `main.rs` (objc2 0.6 / objc2-app-kit 0.3 APIs recalled from cefsimple; `msg_send!` argument encodings for the Apple Event; `MainThreadOnly` delegate; `cef::sys::cef_window_handle_t` being a raw pointer on macOS).
2. `bundle-mac.sh`: the extracted CEF folder name/layout (`find` is used), `cef-dll-sys` building with Xcode's clang/cmake/Ninja, helper layout (`OMPdesk Helper (GPU).app` ... in `Contents/Frameworks`, copied from the same binary; cef-rs's `bundle-cef-app` does the same with a separate helper binary), Info.plist keys, `lsregister` path.
3. Signing: entitlements (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`) are from memory of CEF's cefclient/Chromium helper entitlements, not re-read; one entitlements file is applied to the app and every helper; ad-hoc (`-`) signing with hardened runtime and `--timestamp=none`. Notarization is not scripted.
4. Traffic-light position (18, 17): CEF's `titlebar_height` centring is assumed; x is whatever CEF uses (not 18). `-webkit-app-region` dragging on a frameless Views window, resize edges, and the window shadow are unchecked.
5. No main menu: cefsimple loads a `MainMenu.xib`; this prototype has none, so Cmd-Q/Cmd-C/Cmd-V/Cmd-W may not work until an `NSMenu` (App + Edit) is added.
6. Deep link: the Apple Event handler is registered right after `NSApp`'s delegate is set (before `run_message_loop`); a cold launch by URL may deliver the event before the handler exists on some macOS versions. Second-instance forwarding via CEF's singleton is unchecked on macOS.
7. Tray (`tray-icon` on the NSApplication subclass), `titlebar` colours/dark mode, GPU/ANGLE behaviour with `no_sandbox` and no sandbox bootstrap (CEF's macOS sandbox is not used).
8. preview-host on macOS: `--offscreen` is the path to try first. Child mode (`--parent-hwnd` = a parent `NSView*` as a decimal, `bounds` flipped to NSView coordinates) is untested, and no mac replacement exists for the Windows "detach before close" workaround.
9. `measure/` scripts that use Win32 (hit tests, tray probes in `cef/test/*.py`) do not apply; the CDP self-tests are platform-free.

## Electron argv compatibility (both platforms; checked on Windows only)
`--user-data-dir=<dir>` and `--user-data-dir <dir>` are aliases of `--user-data <dir>` (precedence: `--user-data`, `--user-data-dir`, env `OMPDESK_PROTO_USER_DATA`, default). The switch is removed from CEF's own command line so Chromium does not point its profile at the bare folder; the profile stays in `<dir>/shell-webview/`. Unknown Electron/Chromium switches (`--host-resolver-rules=...`, `--ignore-certificate-errors`, `--updated`, `--force-run`) are ignored by the shell's parser; Chromium itself still sees (and honours) the real Chromium ones. Not checked on macOS: that `open -n OMPdesk.app --args ...` reaches the binary unchanged.
