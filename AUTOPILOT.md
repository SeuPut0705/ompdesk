# Autopilot guide: OMPdesk

Project-wide direction for Autopilot runs on this repository, shared across sessions and computers. The rules in `AGENTS.md` win wherever they differ from this guide, and Autopilot's hard limits can never be lifted by it. This file is direction, not a task list: a run's own backlog lives in the Autopilot panel.

## Goals and roadmap

- OMPdesk is the desktop app for the omp coding agent: parallel sessions, Autopilot, the phone. v0.34.0 is out; v0.35.0 is the work in progress.
- Priority now: stability and polish of the v0.34 features over new features. A rough edge in something that already shipped beats a new idea.
- Public-repo first impression matters: README (en and ko), onboarding, first run, empty states and screenshots are product surfaces. Keep them accurate and polished.

## Principles

- Stock omp first, never fork. Use stock's own machinery (settings, roles, tools, `completeSimple`, goal continuation) before building anything of our own, and check stock's source before assuming it lacks something. A gap goes into the bridge, not into a patched omp.
- Smart features default ON. The user's choice always wins, every automatic behavior is reversible from Settings, quiet (no nagging, no extra dialogs) and cheap (a `smol`-role request, never the main model, for background work).
- Work continues after any restart: a crash, a SIGKILL, a normal quit, an omp restart. Minimize confirmation dialogs; decide, and make the decision undoable.
- Efficient account use: spread load across accounts, never burn quota on background niceties, and keep the prompt-cache prefix stable (static system sections stay byte-identical).
- Korean and English parity: every user-visible string has both, with the same keys in `en.ts` and `ko.ts`. Docs have a `.ko.md` twin.

## Area priorities

1. Bugs and stability (crashes, lost work, restart/resume, flaky behavior), with a test that fails first.
2. Polish: spacing, empty/loading/error states, copy, keyboard and screen-reader behavior, both themes, both languages.
3. Tests and docs that keep the above true.
4. Performance where it is measured.
5. New features last, small, finished, default-on only when cheap and reversible.

## Do not touch

- `/Applications/OMPdesk.app`: never reinstall it, and never schedule a swap.
- Release machinery and signing (`scripts/mac-sign.cjs`, `scripts/mac-signing.json`, `.github/workflows/release.yml`) unless an item is about the release itself; never replace the signing certificate.
- `package.json` version, `CHANGELOG.md` release sections and release commits: only the release procedure in `AGENTS.md` edits them. No `Unreleased` section on `main`.
- Generated media and brand assets under `docs/media/` and `resources/brand/` unless the item is about them.

## Done means

- `bun run check:changed` is green for every change (types, biome, surface policy, related vitest, build, touched e2e specs). Heavy steps run through `bun run locked`; Playwright runs headless (`OMP_GUI_HEADLESS=1`).
- A bug fix has a test that failed before it; a UI change is covered at unit/component level.
- Docs follow the code: `AGENTS.md`, the README feature line, and the matching `.ko` text.
- One small, focused commit per change, in the repo's style (`feat:`, `fix:`, `test:`, `docs:`, `ci:` ...), no AI attribution trailers.
- Finished, checked work is pushed to `main` as it lands (see "Change workflow" in `AGENTS.md`); never force-push. Releases go only through the release procedure in `AGENTS.md`, in small batches about once or twice a day.

## Taste

- Boring, minimal diffs that match the surrounding code; delete what a change makes dead instead of leaving shims.
- Keep the e2e suite small. Prefer unit and component tests; do not add theme or language variant matrices as blocking tests. A new e2e spec needs a reason a unit test cannot cover, and it runs on the fake omp.
- Quiet UI: no new modal where a default plus an undo would do.
- Prefer stock behavior and stock words over our own wording of the same thing.

## Release cadence

- Batched: a handful of user-visible fixes or features, once or twice a day at most, through `AGENTS.md`'s release procedure. A defect that makes the released app unusable ships at once, on its own.

## Long-lived ideas

- (Ideas that outlast a single run go here, written by a maintainer. A run's backlog stays in the Autopilot panel.)
