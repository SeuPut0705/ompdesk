---
name: session-processes-verify
description: "Checks that OMPdesk ends only the processes of a tab that is gone, never those of an open tab, and forgets no tag with running processes. Use when changing src/main/session-processes.ts, Lane::dispose / when_all_exited in native/ompdesk/crates/core/src/sidecar/lane.rs, the pool's release_entry (native/ompdesk/crates/core/src/pool/windows.rs) or the tag's spawn in native/ompdesk/crates/core/src/sidecar/lane.rs, the sweep's keep set or frozen in src/main/index.ts, or when asked whether closing a tab, a quit or a relaunch can kill a live session's processes or leave a finished one's behind."
---

# Session processes verification

## The promise and the harm

OMPdesk ends a tag's processes only when the tab that held the tag was closed outside a quit, or the tag's session did not come back at a launch; an open tab never has its processes ended; nothing stays in the tag file at rest that no open tab answers for; a tag with running processes is never forgotten. Broken one way, a live session loses its omp and its dev server mid-turn (`procs.end` kills by force after five seconds). Broken the other way, finished work's processes pile up until the computer freezes (the owner's report, 12 Nov 2026).

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `session-processes` | TLC 1.8.0 | `src/main/session-processes.ts` (`open`, `close`, `sessionReleased`, `sweep`, `#endEntry`), `native/ompdesk/crates/core/src/sidecar/lane.rs` `Lane::dispose`, `when_all_exited`; the pool's `release_entry` (`pool/windows.rs`) | `formal/session-processes/tla/SessionProcesses.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `session-processes` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- 2 sessions, 3 tags, 3 launches (1.8M states, about 40 s; 7 mutations, about 2 minutes in all); any order of start, spawn, close, quit, crash, launch, sweep, the core's answers and the retry.
- Assumptions: the marks (`live`, `ending`) are synchronous and only `procs.end`'s answer is awaited; the tag file equals the registry's entries; the sweep's keep set is the restored layouts and the markers. Full table: `formal/session-processes/CORRESPONDENCE.md`.
- Not covered: which processes carry a tag and how they are ended (the core's `procs.*`, tested on real processes in `crates/core/src/procs/mod.rs` and `session-processes.test.ts`), hosted tabs' delayed sweep, a tab with no session file yet, liveness. `formal/session-processes/SCOPE.md`.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only session-processes
```

`PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT:`: covered code changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against the code with each row's `@code` location. A step the code cannot take is a model error: fix the model and say so. Every step possible is a bug: tell it in the code's words and pin it with a failing test first (`session-processes.test.ts`, "which tags end, and when": its ends are held until the test settles them, so any order of open, close, sweep and answer can be forced). Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (one step per synchronous run; a new `await` between a mark and its request splits a step), change a property only when the promise changed on purpose (old wording, new wording, evidence in `Properties.md`), add a mutation for each new guard, rerun, then move the sync commit with `verify-all.ts formal --only session-processes --stamp` after committing.
