# seucode — Development Rules

Read this before any edit in this repository.

## Repository identity

- Product: **seucode** (lowercase), a desktop app for the omp agent; bundle id `com.seuput.seucode`, userData `~/Library/Application Support/seucode` (`%APPDATA%\seucode`). Say "omp" only for the agent/CLI (`omp update`, "omp 18.6+"). Brand sources are hand-written SVGs in `resources/icon-source.svg` and `resources/brand/`; `bun run gen:icons` regenerates `icon.png`/`icon.icns`/`icon.ico` and the tray PNGs, and the in-app mark is `components/common/BrandMark.tsx` (geometry in `src/shared/brand-mark.ts`, kept in sync with the SVGs by `brand-mark.test.ts`).
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
- CI (`.github/workflows/ci.yml`): `check` (types, biome, vitest, build) on macOS and Windows for every push/PR. `e2e` runs only on `workflow_dispatch` and published releases, against the latest published omp: the full suite on macOS, the `@smoke` subset (`e2e/smoke.e2e.ts`, `--grep @smoke`, fake omp) on Windows. Before a release: `gh workflow run ci.yml --ref <branch>`.
- Never drive the app with synthetic OS input (osascript keystrokes etc.); use Playwright.
- Dev: `bun run dev` (HMR against the system omp; opens a visible window).

## Release

- Version `X.Y.Z` semver; tag `vX.Y.Z`; release commit `release: vX.Y.Z`. Commit messages carry no AI attribution trailers.
1. `main` clean and current. `omp update`; confirm `omp --version` ≥ `MIN_OMP_VERSION`.
2. Bump `package.json` `version`, write the `CHANGELOG.md` section, update README version mentions.
3. `bunx vitest run && bun run check:types && bun run build && bunx playwright test`.
4. Commit, tag, push: `git commit -am "release: vX.Y.Z" && git tag vX.Y.Z && git push origin main vX.Y.Z`.
5. Package macOS: `bun run package:mac -- --publish never` (dmg + zip, Apple Silicon only; Intel Macs are not supported). Windows installers are built by `.github/workflows/release-windows.yml` on a Windows runner (NSIS's `makensis` is x86-only and fails on Apple Silicon with error -86); locally, `bun run package:win:dir` checks the unpacked Windows app.
6. Inspect: `codesign --verify --deep --strict "<dmg mount>/seucode.app"`; `Contents/Resources/gui-bridge` exists; launch with omp installed (reaches Ready) and with omp absent from `PATH` (install error shown).
7. Publish a GitHub Release on the tag with the DMG, the ZIP, and `latest-mac.yml` (the updater resolves the DMG from it), plus a version-free DMG copy for the README download button (`releases/latest/download/<name>`; the updater keeps using the versioned name):
   ```bash
   V=X.Y.Z
   cp dist/seucode-$V-arm64.dmg dist/seucode-mac-arm64.dmg
   gh release create v$V --title "v$V" --notes-file <changelog section> \
     dist/seucode-$V-arm64.dmg dist/seucode-$V-arm64-mac.zip dist/latest-mac.yml \
     dist/seucode-mac-arm64.dmg
   ```
   Publishing triggers the Windows workflow, which uploads the setup and portable exe (versioned and `seucode-windows-*.exe`) plus `latest.yml`. Release body = changelog section + minimum omp version.

macOS builds are ad-hoc signed and not notarized; locally built apps run without Gatekeeper prompts, downloaded ones need right-click → Open once.

## Code conventions

- TypeScript: no `any`, no inline `import("…")` types, `#private` fields, Bun APIs where cleaner.
- i18n: every user-visible string goes through `useT()` with the same key in `src/renderer/locales/en.ts`, `zh.ts`, and `ko.ts` (`locales.test.ts` enforces identical key sets). Settings-schema text lives in `src/renderer/components/settings/schema-{zh,ko}.ts` and `schema-option-{zh,ko}.ts`; main-process strings in `src/main/i18n.ts` and `tray-labels.ts`.
- Model output renders through `MarkdownRenderer` (`src/renderer/lib/markdown.tsx`, rehype-sanitize) — never `dangerouslySetInnerHTML` with model text.
- Tool-rendered text uses the helpers in `src/renderer/lib/format.ts`; preview ceilings come from `src/renderer/lib/preview.ts`; subprocess output renders through `AnsiText` (`src/renderer/lib/ansi.tsx`).
- Component tests use the linkedom harness (see `src/renderer/components/chat/ThinkingBlock.test.tsx`): mount through `I18nProvider`, reset zustand stores in `afterEach` via their `reset()`/setters — never `mock.module()`.
