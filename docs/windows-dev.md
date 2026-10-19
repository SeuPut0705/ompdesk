# Developing OMPdesk on Windows

OMPdesk is built mostly on macOS. This page lists what a developer (or an agent) needs on Windows and what does not work there.

## Setup

1. Install [Bun](https://bun.sh) (`irm bun.sh/install.ps1 | iex`), so `bun.exe` and `bunx.exe` are on PATH. A Bun installed through npm only has `.cmd` shims; it works through the lock wrapper, but prefer the official installer.
2. Install [Git for Windows](https://git-scm.com/download/win). Its Git Bash is the supported shell for anything written in POSIX shell.
3. Install stock omp: `bun install -g @oh-my-pi/pi-coding-agent` (or let the app's machine setup do it).
4. Clone, then `bun install`. `.gitattributes` forces LF on checkout (`* text=auto eol=lf`), which biome needs; do not override it with `core.autocrlf`.
5. Turn on **Developer Mode** (Settings › System › For developers). About 15 test files create file symlinks (`fs.symlinkSync` without `"junction"`: `open-path`, `server`, `models-config`, `cli-tools/detect`, `ext-update/mcp-owner`, `visuals`, `host-actions`, …), and Windows refuses them with `EPERM` otherwise. CI runners run as admin, so CI does not catch this. App code (worktree seeding) makes directory junctions and needs no privilege.

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
- `@smoke` Playwright specs run on Windows CI. `terminal` and `mobile-web` are macOS only there (no stock omp PTY natives on the runner; the fake Tailscale is a bun shebang script). Run a Windows e2e on CI with `gh workflow run ci.yml --ref <branch> -f win_e2e=true`.
- Never in a test: the real home. The real-home guard uses `os.userInfo().homedir`, which is `C:\Users\<you>` on Windows too.

## Known limits

- Mac signing, DMG and `reinstall-mac.sh` are macOS only.
- Nothing has checked the compact UI at 125/150 % display scaling or Malgun Gothic text metrics on a real Windows machine; CI runners run at 100 %.
- The terminal panel's shells (PowerShell, Git Bash, cmd) and the tray are covered only by `@smoke` on the runner, not by a human.
