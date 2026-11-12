# Batch P on macOS: run sheet (Mac mini, Apple silicon)

Windows chose candidate (a), CEF through the `cef` crate (decision record: `.omp/rules/native-rust.md` › Ledger › P). This sheet confirms or overturns it on macOS. Branch `omp/agent/rust-batch-shell-prototype`, folder `native/shell-prototype/`. Nothing here touches `/Applications/OMPdesk.app`, its keychain item's value, or `~/Library/Application Support/ompdesk`.

(b) is not run: WKWebView has no CDP, no Playwright attach and no trusted input injection (sources in the ledger entry). Step 7 is the one-minute check of that claim.

## 0. Prepare (once)

```bash
git fetch origin && git switch omp/agent/rust-batch-shell-prototype   # or a worktree of it
bun install --frozen-lockfile && bun run build                          # out/renderer
bun native/shell-prototype/stand-in/build.ts                            # shell-assets/stand-in.js
bun native/shell-prototype/stand-in/make-video.ts                       # shell-assets/video.webm (needs Playwright's ffmpeg: bunx playwright install ffmpeg)
xcode-select -p && brew install cmake ninja                             # cef-dll-sys builds CEF's C++ wrapper
security find-identity -v -p codesigning | grep ecbd9595cf886bc3546e7456706a4b41c02a4ee6   # the app's own certificate (scripts/mac-signing.json); needed for step 6
```

`make-video.ts` looks for `ffmpeg-win64.exe`; on the Mac change that one name to `ffmpeg-mac` (Playwright's mac build) or copy `video.webm` over from Windows.

## 1. Build and bundle candidate (a)

```bash
cd native/shell-prototype/cef
BUNDLE_ID=com.seuput.ompdesk.proto BUNDLE_VERSION=0.200.0 SIGN_IDENTITY=- ./bundle-mac.sh
```

Expect `target/mac/OMPdesk.app` and `target/mac/OMPdesk Preview.app`. `cef/MACOS.md` lists the nine things never compiled or run on a Mac; fix them in place (the prototype is throwaway). Most likely fixes, in order: objc2 call spellings in `shared/mac_app.rs` / `shell-cef/src/mac.rs`, the CEF archive layout in `bundle-mac.sh`, a missing `NSMenu` (Cmd-Q).

## 2. The pass list, one run each

```bash
APP=target/mac/OMPdesk.app/Contents/MacOS/OMPdesk
LOG=/tmp/p-a.jsonl; rm -f $LOG
$APP --selftest --query selftest=1 --preview app://ompdesk/__shell/preview-test.html --debug-port 9311 --log $LOG &
sleep 15
grep -E '"(page\.loaded|preview\.loaded|tray\.created|selftest\.[a-z_]+)"|selftest.video_seek' $LOG     # every selftest ok:true, video_seek ok:true, tray.created ok:true
grep -c scheme.range $LOG                                                                               # > 0: ranged requests served
curl -s 127.0.0.1:9311/json/list | grep -E '"url"'                                                       # app page and preview-test both listed
bun ../measure/playwright-attach.ts 9311 /tmp/p-a.png                                                    # {"ok":true,...}; look at /tmp/p-a.png
open 'ompdesk-proto://probe/a?x=1'; sleep 3; grep deeplink $LOG                                          # from "apple-event" (or "second-instance")
```

Do NOT let anything call Playwright's `browser.close()` over CDP: it sends `Browser.close` and quits the shell (seen on Windows).

By hand, with the window in front (macOS has no WM_NCHITTEST; this is the one manual step):
- the traffic lights sit at about (18, 17) from the window's top left, and the window has no title bar;
- dragging the empty part of the top bar moves the window; dragging a button in it does not;
- the menu-bar icon opens Show / Quit and both work (`grep tray.click $LOG`);
- Cmd-Q quits (if not: the missing `NSMenu`, `MACOS.md` item 5).
Screenshot the window (`screencapture -l$(osascript -e 'tell app "System Events" to id of window 1 of (first process whose unix id is <pid>)') /tmp/p-a-window.png`, or Cmd-Shift-4 Space) for the record.

Then `kill %1`.

## 3. Memory, 3 runs per scenario

```bash
cd native/shell-prototype
for s in idle long preview; do for r in 1 2 3; do
  L=/tmp/m-$s-$r.jsonl; rm -f $L
  A="--user-data /tmp/m-ud --log $L"; [ $s = long ] && A="$A --query long=2000"; [ $s = preview ] && A="$A --preview app://ompdesk/__shell/preview-test.html"
  cef/target/mac/OMPdesk.app/Contents/MacOS/OMPdesk $A & P=$!
  until grep -q page.settled $L 2>/dev/null; do sleep 0.5; done; sleep 10
  ps -axo pid=,ppid=,rss= | awk -v root=$P '{pp[$1]=$2; rss[$1]=$3} END {for (p in pp) {q=p; while (q && q!=root) q=pp[q]; if (q==root) {n++; t+=rss[p]}} printf "%s %s procs=%d rssMB=%.1f\n", "'$s'", "'$r'", n, t/1024}'
  footprint -p $P 2>/dev/null | tail -1      # phys_footprint of the browser process (macOS's own measure)
  kill $P; wait $P 2>/dev/null; sleep 2
done; done
```

The reference is the Electron shell with nothing of OMPdesk's main: `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/shell-prototype/measure/electron-baseline/main.cjs --user-data /tmp/m-ud-e --log $L` in the same loop.

## 4. Size on disk

```bash
du -sk cef/target/mac/OMPdesk.app "cef/target/mac/OMPdesk.app/Contents/Frameworks/Chromium Embedded Framework.framework"
du -sk /Applications/OMPdesk.app /Applications/OMPdesk.app/Contents/Frameworks/Electron\ Framework.framework
hdiutil create -volname OMPdesk -srcfolder cef/target/mac/OMPdesk.app -ov -format ULFO /tmp/p-a.dmg && ls -l /tmp/p-a.dmg   # release form: a DMG
```

## 5. (c) only if (a) fails an item in step 2

`OMPdesk Preview.app` is candidate (c)'s Preview process. (c)'s window needs a mac port of `tauri2/` (its Windows code: `with_webview`, the HWND subclass, the caption HTML): skip unless (a) fails, then mail the main session the failing item; it is a fork for the owner.

## 6. The update move from the released Electron app (v0.127.0)

What it must show: the released app's own updater, unchanged, finds the new version, verifies and stages the DMG (`stageBundleFromDmg`: `codesign --verify --deep --strict`, bundle id, version), swaps it in with `SWAP_SCRIPT` at the automatic install, and the new shell starts on the same userData and reads the `safeStorage` token from the keychain item without a prompt; a failed swap leaves Electron.

Identity: the bundle must be `com.seuput.ompdesk`, signed with the app's certificate (`ecbd9595…`), version above 0.127.0.

```bash
cd native/shell-prototype/cef
BUNDLE_ID=com.seuput.ompdesk BUNDLE_VERSION=0.200.0 SIGN_IDENTITY=ecbd9595cf886bc3546e7456706a4b41c02a4ee6 ./bundle-mac.sh
cp -R ../../../out/renderer target/mac/OMPdesk.app/Contents/Resources/renderer 2>/dev/null || true   # if bundle-mac.sh did not
codesign --verify --deep --strict target/mac/OMPdesk.app && codesign -dr - target/mac/OMPdesk.app     # DR must equal: codesign -dr - /Applications/OMPdesk.app
hdiutil create -volname OMPdesk -srcfolder target/mac/OMPdesk.app -ov -format UDZO /tmp/ompdesk-mac-arm64.dmg

# A second copy of the released app, so the real one is never replaced:
mkdir -p ~/Applications && rm -rf ~/Applications/OMPdesk-movetest.app && ditto /Applications/OMPdesk.app ~/Applications/OMPdesk-movetest.app
UD=/tmp/move-ud; HOMEX=/tmp/move-home; rm -rf $UD $HOMEX; mkdir -p $HOMEX
# Stand-in token + Local Storage, written by the same Electron the release uses:
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron native/shell-prototype/move/seed-profile.cjs --user-data-dir=$UD
```

`seed-profile.cjs` calls `app.setName("ompdesk")`, so its `safeStorage` uses the same keychain item "ompdesk Safe Storage" as the real app (the item's password is only read, never changed, and the token written is a stand-in). The first run may show a keychain prompt for the dev Electron: allow once.

Feed: `move/feed.ts` serves a Windows asset. Add the mac file to it (10 lines: `files.mac = {name: "ompdesk-mac-arm64.dmg", size, sha512}`, an asset `id: 2` at `/releases/assets/2`), then:

```bash
bun native/shell-prototype/move/feed.ts --setup /tmp/ompdesk-mac-arm64.dmg --version 0.200.0 --port 8443 &   # after the mac edit
HOME=$HOMEX OMPDESK_PROTO_USER_DATA=$UD ~/Applications/OMPdesk-movetest.app/Contents/MacOS/OMPdesk \
  --user-data-dir=$UD "--host-resolver-rules=MAP api.github.com 127.0.0.1:8443" --ignore-certificate-errors &
```

Watch `$UD/logs/gui-runtime.jsonl` (source `app-update`): `check found 0.200.0 mode relaunch` → `download started/verified` → `scheduler safe` → `countdown` → (60 s) `install` → `swap helper`. Then:
- `~/Applications/OMPdesk-movetest.app` is the CEF bundle (`ls Contents/Frameworks`), `/Applications/OMPdesk.app` untouched (`codesign -dv` and version unchanged);
- the new shell runs, started by `SWAP_SCRIPT`'s `open -n … --args <old argv>`; its log (`$UD/shell-webview/shell.log.jsonl`): `migrate.token ok:true sha256_8:` equal to the seeded stand-in's, `78f500e3` (as on Windows), `migrate.localStorage ok:true keys>0`, `page.report localStorage.imported`, `page.loaded`;
- no keychain prompt appeared (if one did: the DR differs; record it);
- `~/Library/Logs/…`/`$UD/updates/swap.log`: the swap's own lines.

Failure path: repeat with a bundle the swap refuses after staging (e.g. `chmod -R a-w ~/Applications` just before the countdown ends, or a DMG whose app fails `codesign --verify`: then staging refuses and nothing moves). Expect Electron still installed, the next launch's `swap result` line (`rolled back` / `install failed; previous app restored`), and the app starting as before.

Clean up: `kill` the shells and the feed, `rm -rf ~/Applications/OMPdesk-movetest.app /tmp/move-* /tmp/m-* /tmp/p-a*`.

## 7. (b)'s drop, one minute

Any wry/Tauri 2 app on macOS (e.g. `cargo create-tauri-app`, or `tauri2/` after deleting its Windows-only calls) started with `--debug-port`: `curl 127.0.0.1:<port>/json/version` answers nothing (WKWebView has no CDP endpoint); Safari › Develop lists the page only as a Web Inspector target. That confirms the ledger's reason.

## 8. Report back (mail the main session)

Per item: pass / fail with the log line; the memory table (idle / long / preview, rss and footprint, against the Electron reference); sizes (app, framework, DMG); the move's log lines; whether a keychain prompt appeared. If every item passes, (a) stands and the hub program starts on it; any failure is a fork for the owner.
