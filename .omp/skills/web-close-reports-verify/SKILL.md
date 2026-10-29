---
name: web-close-reports-verify
description: "Checks that a paired web page's Files-edit reports are kept per live connection and that no agent close releases a tab a settled live page holds unsaved edits in. Use when changing src/main/web/file-edit-reports.ts, src/main/agent-control/tab-close.ts, src/renderer/web/FileEditReporter.tsx, WsRouter.detach / WsConnection.receive / #dispatch in src/main/web/ws-router.ts, AgentControl.#closeTab in src/main/agent-control/service.ts or closeWindowTab in src/main/tab-release.ts; or when asked whether a phone's unsaved edit can be lost to an agent's close."
---

# Web close reports verification

## The promise and the harm

Main keeps each live connection's latest Files-edit report (`FileEditReports`, keyed by `connId`), an ended connection's report never counts again, and no close path (`tabCloseStep` through `#closeTab`) decides to release a tab a settled live page holds unsaved edits in. Broken, a person's unsaved edit on a phone is lost when an agent closes the tab, or a dropped page's stale word keeps a finished child open.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `web-close-reports` | TLC 1.8.0 | `file-edit-reports.ts`, `tab-close.ts`, `FileEditReporter.tsx`, `WsRouter.detach`, `WsConnection.receive`/`#dispatch`, `AgentControl.#closeTab`, `closeWindowTab` | `formal/web-close-reports/tla/WebCloseReports.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `web-close-reports` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- 2 pages in one window, 2 tabs, 2 connections per page, 3 editor changes, 2 frames in flight per connection: 1.48M states, depth 26, about 25 s.
- Assumptions: no `await` between a frame's `receive` and an accepted `FILE_EDIT_REPORT` (the handler's `parseFileEditReport` takes only one exact `{dirtyTabId}`, so a frame whose picture upload `#dispatch` awaits is refused; pinned by `ws-router.test.ts` "hands a Files-edit report to main within the frame…" and "never lets a report outlive its connection…"); detach → `forget` is one synchronous chain; frames are FIFO per connection. Full table: `formal/web-close-reports/CORRESPONDENCE.md`.
- Not covered: several windows (unit-tested in `file-edit-reports.test.ts`), the person at the tab, the desktop window path, liveness. `formal/web-close-reports/SCOPE.md`.
- `NoLateDirtyRelease` fails by design (`MC_late.cfg`): a report landing between the decision and the release does not stop it.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only web-close-reports
```

About a minute and a half (4 runs, 7 mutations). `PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT:`: covered code changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against the code with each row's `@code` location. A step the code cannot take is a model error: fix the model and say so. Every step possible is a bug: tell it in the code's words and pin it with a failing test first (`file-edit-reports.test.ts` exhaustive orders, `ws-router.test.ts`, `service.test.ts` "every close path follows tabCloseStep"). Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (keep one step per synchronous run; a new `await` splits a step), change a property only when the promise changed on purpose (old wording, new wording, evidence in `Properties.md`), add a mutation for each new guard, rerun, then move the sync commit with `verify-all.ts formal --only web-close-reports --stamp` after committing.
