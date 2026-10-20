# Developing OMPdesk on Windows

OMPdesk is built mostly on macOS. This page lists what a developer (or an agent) needs on Windows and what does not work there.

## Setup

1. Install [Bun](https://bun.sh) (`irm bun.sh/install.ps1 | iex`), so `bun.exe` and `bunx.exe` are on PATH. A Bun installed through npm only has `.cmd` shims; it works through the lock wrapper, but prefer the official installer.
2. Install [Git for Windows](https://git-scm.com/download/win). Its Git Bash is the supported shell for anything written in POSIX shell.
3. Install stock omp: `bun install -g @oh-my-pi/pi-coding-agent` (or let the app's machine setup do it).
4. Clone, then `bun install`. `.gitattributes` forces LF on checkout (`* text=auto eol=lf`), which biome needs; do not override it with `core.autocrlf`.
5. Turn on **Developer Mode** (Settings › System › For developers). About 15 test files create file symlinks (`fs.symlinkSync` without `"junction"`: `open-path`, `server`, `models-config`, `cli-tools/detect`, `ext-update/mcp-owner`, `visuals`, `host-actions`, …), and Windows refuses them with `EPERM` otherwise. CI runners run as admin, so CI does not catch this. App code (worktree seeding) makes directory junctions and needs no privilege.
6. Install the browsers the Playwright specs launch themselves: `bunx playwright install chromium webkit`. `chromium` is Playwright's own Chromium (`device-prefs`, `pwa-install` and the Pixel side of the phone specs); `webkit` serves the phone specs (`mobile-attach`, `mobile-composer`, `mobile-enter`, `mobile-notification-open`, `mobile-pages`, `mobile-panels`, `mobile-shell`, `mobile-work-strip`, `phone-day`, `phone-run-sheet`, `web-no-reload`, `web-perf`). Without WebKit every case of those fails with `browserType.launch: Executable doesn't exist at …\ms-playwright\webkit-<n>\Playwright.exe`, and `mobile-shell`, which launches it in `beforeAll`, fails its first case and skips the rest. Run it again after a Playwright upgrade.

## Shells

- Every `package.json` script runs through Bun's own shell, so `bun run <script>` works the same in PowerShell, cmd.exe and Git Bash.
- `scripts/agent-commit.sh`, `scripts/ci-failure.sh`, `scripts/ci-fetch-out.sh` and `scripts/reinstall-mac.sh` are bash only: run the first in Git Bash (`bash scripts/agent-commit.sh …`); the CI ones run on runners and the last is macOS only.
- Copy-paste commands in AGENTS.md use POSIX syntax (`FOO=1 cmd`, `&&`, `/tmp/...`). In PowerShell write `$env:FOO=1; cmd`; or use Git Bash.

## Scripts that behave differently

| Script | Windows behaviour |
|---|---|
| `bun run locked`, `gate`, `check:changed` | Lock root is `%TEMP%\ompdesk-locks`, log `%TEMP%\ompdesk-build.log`. Commands run through cmd.exe where needed (so `bunx`/`npx` shims start) with arguments quoted by `spawnArgs` (`src/main/spawn.ts`); interrupting kills the tree with `taskkill /T /F`. |
| `bun run build` | The `out-<hash>/` snapshot is a plain copy (no APFS clone), about 17 MB per build; old ones are deleted 30 min after last use. |
| `bun run gen:icons` | Skips `icon.icns` and `dmg-background.tiff` (`iconutil`/`tiffutil` are macOS only). Commit only the files it changed. |
| `bun run sync:rea-skill` | Needs `npm` and `tar` (`tar.exe` ships with Windows 10 1803+). |
| `bun run package:win` | Builds the NSIS setup locally. `package:mac` cannot run. |
| `.ompdesk/worktree-setup.cmd` | The Windows form of the worktree setup hook, checked in beside the POSIX `.ompdesk/worktree-setup`: `bun install --frozen-lockfile`, then `bun scripts/ensure-electron.ts`. |

## Tests

- `bun run test:platform` is the suite Windows CI runs (everything but `src/renderer/**`). Renderer tests never read the host platform, so the full `bunx vitest run` also works.
- `@smoke` Playwright specs run on Windows CI. `terminal` is macOS only there (no stock omp PTY natives on the runner). Run a Windows e2e on CI with `gh workflow run ci.yml --ref <branch> -f win_e2e=true`.
- The fake tools the e2e specs launch are files Windows can start: `.cmd` shims that call bun for omp, the Tailscale CLI, the test installer, Claude Code and the bundled Codex; a bun-compiled `gh.exe` for `gh` (`e2e/fixture/fake-gh-install.ts`; Windows starts `gh` only as `gh.exe`); npm's `node_modules` layout with its `.cmd` shim for an npm global. The mobile-web, phone-work, Autopilot-on-a-phone, GitHub sign-in, CLI and extension update specs therefore run on a Windows PC. The one that does not is `github-cli-install`: Windows installs gh with winget only, so the archive download it drives does not exist there (see AGENTS.md › Windows › Fake tools on Windows).
- Never in a test: the real home. The real-home guard uses `os.userInfo().homedir`, which is `C:\Users\<you>` on Windows too.
- Writing e2e specs for a Windows machine (each of these failed on a developer PC at 125 % scaling with Git for Windows' default config):
  - `git worktree list` prints `C:/x/wt`, the app and `node:path` use `C:\x\wt`: compare through `path.normalize`, never as raw substrings.
  - Git for Windows sets `core.autocrlf=true` in its system config. The app's git runs under it (a merge writes CRLF checkouts that the user's git calls clean), so a spec that isolates its own git with `GIT_CONFIG_NOSYSTEM=1` must read the final `git status` without that isolation.
  - The app spawns `gh` with no shell and finds `gh.exe` (then a bare `gh`), so a shell-script stand-in on PATH never runs: PR Center lists nothing, an Autopilot release never sees its run succeed. Write the stand-in with `writeShellGh(bin, script)` (`e2e/fixture/shell-gh.ts`): POSIX gets the script, Windows gets a `gh.exe` launcher (compiled once into `%TEMP%\omp-e2e-fake-gh`, hard-linked into `bin`) that runs the same script with Git for Windows' `bin\sh.exe`.
  - `ps -axo` does not exist in Git for Windows' `ps`: list what a killed app left with `survivors` (`e2e/process-tree.ts`), which asks `Win32_Process`.
  - A fixture that stands in for the bridge runs the bridge's own state class (`CheckoutPeersState`), not a copy: main sends Windows paths with backslashes and the bridge normalizes them, so a fixture that keeps the raw message compares `C:\x\project` with `c:/x/project`.
  - A shortcut written ⌘ is Ctrl on Windows and the Windows key is no chord: press `ControlOrMeta`, never `Meta`.
  - A press that must land on one caret offset (drag-select) aligns to a device pixel: `Math.round(v * devicePixelRatio) / devicePixelRatio`.
  - Some chords move on Windows because Ctrl+X is taken there (keymap `windowsDefaults`, `platformDefaults`): reopen a tab is Ctrl+Alt+Shift+T, quick open Ctrl+Alt+P, the thinking toggle Ctrl+Alt+T; Ctrl+J is the side panel toggle and never the composer newline (`composer.newline` is macOS-only). A spec presses the Windows form when `process.platform !== "darwin"`.
  - Paths the app shows or inserts keep the host's separators: the composer's `@` mention of a picked file is `@docs\spec.pdf` (`fileMentionFor`), so build the expected string with `path.join`. Labels follow the host too: the path menu's reveal row reads "Show in Explorer" / "탐색기에서 보기".
  - `getBoundingClientRect` is float32: at 125 % a 37.6 px box abutting the next one reads 4e-6 px past it. An overlap check needs an epsilon (`EDGE_EPSILON` in `starter-guide.e2e.ts`).
- The phone specs launch WebKit as an iPhone and run on macOS CI only (`e2e-shards.yml`); no Windows job installs WebKit, so a Windows PC is the only place they run on Windows. Playwright's WebKit for Windows is not Safari: it has no `OffscreenCanvas` and no HEIC decoder, `navigator.platform` is `Win32`, Korean is Malgun Gothic (a syllable a full em wide) and its `resize` comes well after the page has set `data-kb`. A spec asks the page what the browser can do rather than skipping WebKit on `win32`; see AGENTS.md › Windows › Playwright's WebKit.

## Known limits

- Mac signing, DMG and `reinstall-mac.sh` are macOS only.
- Nothing has checked the compact UI at 125/150 % display scaling or Malgun Gothic text metrics on a real Windows machine; CI runners run at 100 %.
- The terminal panel's shells (PowerShell, Git Bash, cmd) and the tray are covered only by `@smoke` on the runner, not by a human.
