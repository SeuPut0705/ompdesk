# seucode — Development Rules

Read this before any edit in this repository.

## Repository identity

- Product: **seucode** (lowercase), a desktop app for the omp agent; bundle id `com.seuput.seucode`, userData `~/Library/Application Support/seucode` (`%APPDATA%\seucode`). Say "omp" only for the agent/CLI (`omp update`, "omp 18.6+"). The mark (an interlaced knot, full and ≤48px simplified forms) is defined once in `src/shared/brand-mark.ts`; `bun run gen:icons` writes the SVGs in `resources/icon-source*.svg` and `resources/brand/` from it (`scripts/brand-svgs.ts`; never hand-edit them, `brand-mark.test.ts` fails on drift) and regenerates `icon.png`/`icon.icns`/`icon.ico` and the tray PNGs. The in-app mark is `components/common/BrandMark.tsx`.
- Product repo: [`SeuPut0705/seucode`](https://github.com/SeuPut0705/seucode) (`origin`). All code, tags, and releases live here.
- Originally derived from [`nornzach/oh-my-pi-gui`](https://github.com/nornzach/oh-my-pi-gui) (MIT). It is not tracked as a remote; this repo evolves independently.
- The agent is **stock omp** ([`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)) installed on the user's machine. It is never built, vendored, or forked here. Users get agent updates with `omp update`.
- Platforms: **macOS and Windows only.**

## Architecture

```
renderer (React) ── IPC ──▶ main (Electron)
                              ├─ src/main/local/*      fork-era commands served in main
                              │     (git/gh, fs, ~/.omp files, `omp` CLI, translation to stock RPC)
                              ├─ src/main/sidecar.ts   spawns `omp --mode rpc-ui -e <gui-bridge>/index.ts`
                              │                         (stock RPC over stdio)
                              └─ src/main/bridge-client.ts ◀── unix socket / named pipe ──▶
                                                         resources/gui-bridge/*  (omp extension,
                                                         live AgentSession access)
```

- The renderer speaks one command set. `RpcClient.command()` (`src/main/rpc-client.ts`) first looks for a **local handler** (`src/main/local/index.ts` merges `src/main/local/<area>.ts` maps; duplicate keys throw at startup). Commands without a local handler go to stock omp unchanged.
- A local handler (`LocalHandler`, `src/main/local/types.ts`) either does the work in main (git, gh, files, `ctx.omp.run([...])`), translates to stock RPC (`ctx.send(...)`), or calls the bridge (`ctx.bridge.request(method, params)`) when it needs live session state. `ctx.emit(frame)` pushes a frame to the renderer as if omp had sent it.
- **Bridge** (`resources/gui-bridge/`): an omp extension loaded with `-e`. Area modules export `methods` maps; `env.session()` is the live `AgentSession`, `env.pi.pi` the stock package index. Bare `@oh-my-pi/pi-coding-agent/...` subpath imports resolve through omp's own resolver. These are **internal omp APIs without semver** — keep methods small, feature-detect, and throw clear errors.
- **Compatibility self-check**: every omp internal a bridge module uses is listed per GUI feature in `resources/gui-bridge/capabilities.ts` (`REQUIREMENTS`); add the new internal there (and its module to `LOADERS` in `health.ts`, literal specifier) whenever a bridge method starts using one. `index.ts` loads each area module separately, `guard(feature, methods)` refuses a feature's methods with `unsupported_omp` while anything it needs is missing, and the `capabilities` method reports them; `src/main/bridge-health.ts` probes once per omp version per launch and the renderer toasts the result. `OMP_GUI_BRIDGE_PROBE_HIDE=<label>,…` (labels as `capabilities` prints them, e.g. `AgentSession.setPlanModeState`) makes the probe treat those internals as missing, to rehearse a broken omp.
- `src/main/omp-runtime.ts` finds omp (`OMP_GUI_OMP` override → login-shell `PATH` → `~/.bun/bin/omp`, `/opt/homebrew/bin/omp`, `/usr/local/bin/omp`; Windows `%USERPROFILE%\.bun\bin\omp.exe`, `omp.cmd`/`omp.exe` on `PATH`) and enforces `MIN_OMP_VERSION` (18.6.0).
- Stats: `resources/gui-bridge/stats-host.ts` runs the user's omp-stats server (stock `omp stats` always opens a browser) and adds the paginated `/api/stats/requests` route stock lacks.
- Packaged apps ship `resources/gui-bridge` **outside the asar** (`extraResources` in `electron-builder.yml` and `electron-builder.win.yml`; `src/main/packaging-config.test.ts` enforces it). The app contains no `omp` binary.

### Where a new feature goes

1. Stock RPC already has it (`omp://rpc.md`) → call it; add a local handler only to reshape.
2. Data the GUI can get on its own (git, files, `~/.omp` config, `omp <subcommand>`) → local handler in main.
3. Needs the live session → bridge method + thin local handler.
4. Needs a change inside omp → contribute upstream; never fork.

When an omp update breaks a bridge method, fix the method against the new internals and raise `MIN_OMP_VERSION` if the fix requires it.

## Build, test

- Typecheck: `bun run check:types`. Lint/format: `bunx biome check src e2e`.
- Unit/component tests: `bunx vitest run` (full suite must stay green; `vitest.setup.ts` pins `navigator.language` to en-US and `navigator.platform` to MacIntel, so keymap defaults and shortcut labels are the macOS ones on every runner — Windows behavior is tested by passing `"windows"` to the `lib/keymap.ts` functions).
- Build: `bun run build` (electron-vite → `out/`).
- E2E: `bunx playwright test`. `playwright.config.ts` sets `OMP_GUI_HEADLESS=1`: windows are transparent, click-through, off the Dock/taskbar, and never focused, so tests never cover the user's screen. Set `OMP_GUI_HEADLESS=0` only when you must watch. `e2e/real-core.e2e.ts` and `e2e/deep-audit.e2e.ts` run against the real system omp (isolated agent dir, no credentials); the other suites use the fake omp in `e2e/sidecar-fixture.ts`, installed per test by `fixtureOmp()` (`e2e/harness.ts`: an `omp.cmd` shim on Windows) and passed as `OMP_GUI_OMP`; it speaks stock `--mode rpc-ui` and serves the gui-bridge methods those suites reach on `OMP_GUI_BRIDGE`. Tear apps down with `exitApp()` (same file); shortcuts in tests use `ControlOrMeta`. `e2e/performance.e2e.ts` only runs with `OMP_GUI_PERFORMANCE=1` (optional `OMP_GUI_BASELINE_DIR` compares another built checkout).
- CI (`.github/workflows/ci.yml`): `check` (types, biome, vitest, build) on macOS and Windows for every push/PR. `e2e` runs only on `workflow_dispatch` and inside the release workflow (`workflow_call` with `e2e: true`), against the latest published omp: the full suite on macOS, the `@smoke` subset (`e2e/smoke.e2e.ts`, `--grep @smoke`, fake omp) on Windows. Ad hoc: `gh workflow run ci.yml --ref <branch>`.
- Never drive the app with synthetic OS input (osascript keystrokes etc.); use Playwright.
- Dev: `bun run dev` (HMR against the system omp; opens a visible window).

## Release

- Version `X.Y.Z` semver; tag `vX.Y.Z`; release commit `release: vX.Y.Z`. Commit messages carry no AI attribution trailers.
1. Bump `package.json` `version`, add a dated `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` (it becomes the release notes), update README version mentions. Confirm `MIN_OMP_VERSION` is current.
2. `git commit -am "release: vX.Y.Z" && git push origin main`. Do not tag.
3. `.github/workflows/release.yml` does the rest: runs ci.yml (checks on both platforms, macOS e2e, Windows `@smoke`), packages macOS arm64 (dmg + zip, ad-hoc signed, codesign + `gui-bridge` verified) and Windows x64 (NSIS setup + portable; `makensis` cannot run on Apple Silicon), and only if everything passed creates tag `vX.Y.Z` and the GitHub Release: notes = changelog section + minimum omp version; assets = versioned dmg/zip/exe, `*.blockmap`, `latest-mac.yml`, `latest.yml`, and the version-free copies `seucode-mac-arm64.dmg`, `seucode-windows-setup.exe`, `seucode-windows-portable.exe`. An existing tag or an `Unreleased` heading makes the run a no-op.
4. Re-run after a failure: `gh workflow run release.yml` (on main). Rehearse without releasing from any branch: `gh workflow run release.yml --ref <branch> -f dry_run=true` (packages land as run artifacts).

Manual fallback: `bun run package:mac -- --publish never` on a Mac, `bun run package:win -- --publish never` on Windows, then `gh release create vX.Y.Z --target main --notes-file <section> <assets above>`.

The repo is private, so the in-app updater authenticates as the user (`src/main/update-auth.ts`: `GH_TOKEN`/`GITHUB_TOKEN` → `gh auth token` → a safeStorage-encrypted token from Settings › Updates) and feeds electron-updater a `private: true` GitHub provider; the ad-hoc macOS DMG is fetched through the API asset endpoint. Never bundle a token. Exercise it unpackaged with `OMP_DEV_UPDATE_CHECK=1 OMP_DEV_UPDATE_MODE=manual` (plus `OMP_DEV_UPDATE_PRERELEASE=1` to accept a throwaway pre-release), launching Electron on the repo root so the version is `package.json`'s.

macOS builds are ad-hoc signed and not notarized; locally built apps run without Gatekeeper prompts, downloaded ones need right-click → Open once.

## Code conventions

- TypeScript: no `any`, no inline `import("…")` types, `#private` fields, Bun APIs where cleaner.
- i18n: every user-visible string goes through `useT()` with the same key in `src/renderer/locales/en.ts`, `zh.ts`, and `ko.ts` (`locales.test.ts` enforces identical key sets). Settings-schema text lives in `src/renderer/components/settings/schema-{zh,ko}.ts` and `schema-option-{zh,ko}.ts`; main-process strings in `src/main/i18n.ts` and `tray-labels.ts`.
- Model output renders through `MarkdownRenderer` (`src/renderer/lib/markdown.tsx`, rehype-sanitize) — never `dangerouslySetInnerHTML` with model text.
- Tool-rendered text uses the helpers in `src/renderer/lib/format.ts`; preview ceilings come from `src/renderer/lib/preview.ts`; subprocess output renders through `AnsiText` (`src/renderer/lib/ansi.tsx`).
- Component tests use the linkedom harness (see `src/renderer/components/chat/ThinkingBlock.test.tsx`): mount through `I18nProvider`, reset zustand stores in `afterEach` via their `reset()`/setters — never `mock.module()`.
