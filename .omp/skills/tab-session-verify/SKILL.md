---
name: tab-session-verify
description: "Checks that every spawn of a tab's omp opens the session the tab shows: a crash, machine setup, the desktop slot, an omp update or the person opening a stored session never puts the tab on a new empty session or another conversation. Use when changing session_open in native/ompdesk/crates/core/src/sidecar/launch.rs, or session_path / is_new, restart, observe, handle_ready, on_gated, attempt_restart or start_process in native/ompdesk/crates/core/src/sidecar/lane.rs; or when asked whether a restart can lose a tab's conversation."
---

# Tab session verification

## The promise and the harm

Every spawn of a tab's omp opens the session the tab shows: a written session is reopened, a session stock has not written yet or a new tab starts a new one (stock's `autoResume` pinned off), and only a move to another folder leaves the choice to omp.

If it breaks, a restart nobody asked to change the session puts the tab on a new empty session (the conversation stays in the sidebar), or, with the person's `autoResume` on, on another conversation of the folder.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `tab-session` | TLC 1.8.0 | `native/ompdesk/crates/core/src/sidecar/launch.rs#session_open`; `native/ompdesk/crates/core/src/sidecar/lane.rs` `Lane`: `launch`, `start_process`, `restart`, `observe`, `handle_ready`, `on_gated`, `on_child_exit`, `attempt_restart` | `formal/tab-session/tla/TabSession.tla` (`@code` tags on every action) |

Sync commit: see `syncCommit` of `tab-session` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- Bounds: one tab; 1 stored session and 1 other written session in the folder, 3 new session ids, 4 spawns (13,255 states, depth 20); a larger run with 2 stored sessions, 5 ids, 6 spawns (417,625 states, depth 26). About 40 s in all.
- Assumptions: `start()`'s awaits change neither `#sessionPath` nor `#isNew`; `get_state` names the running omp's session; `autoResume` picks only a written session of the folder; the pool's `sessionFile` equals `#sessionPath` after the same `get_state`. Full table: `formal/tab-session/CORRESPONDENCE.md`.
- Modeled besides spawns and restarts: the start gate's move into a worktree, `switch_session` and `new_session` inside the running omp.
- Not covered: the ownership wait (`sessionFree`), `fork`/`branch`/`handoff` inside a running omp (assumption A5), remote tabs, what else a spawn carries (`src/main/session-launch-parity.test.ts` compares extensions and settings across start paths). `formal/tab-session/SCOPE.md`.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only tab-session
```

Matrix of 7 runs (two that must pass, three code variants that must fail, two sanity runs) and 9 mutations, about 40 s.
- `PASS`, exit 0: no counterexample within the bounds. Not a proof the code is correct.
- `FAIL`, exit 1: a property broke, a mutation was MISSED, or an `@code` tag no longer resolves. The trace names each step's `@code` location.
- `DRIFT:`: covered code changed since the sync commit; look at the model again.
- `NOT CHECKED`, exit 3: the tool could not be prepared. Report "not checked", never a pass.

## Does my change touch this?

Yes when it changes which session a spawn opens, how a `switch_session` / `new_session` response or the start gate updates the tab's session (`session_open`, the `--session` / `--config` choice), when `session_path` or `is_new` are written (`grep -n "session_path\|is_new" native/ompdesk/crates/core/src/sidecar/lane.rs`), what `Lane::restart(cwd, resume_session_path)` does with its arguments, or adds a path that spawns omp without `start_process`. The lane's functions are tagged by name: after an edit run `bun formal/retag-core.ts` and the tags follow.

## A failure: real bug or modeling error?

Replay the trace on the real code with `src/main/session-launch-parity.test.ts` (its `FakeOmp` can skip the `get_state` answer and leave a session unwritten; fake timers drive the crash restart). If a step cannot happen in the code, fix the model and say what was wrong. If it can, it is a bug: write the failing test first (F1 is the example: "a new tab whose omp crashed before it named its session"). Never weaken a property, add a constraint or fairness to make it pass.

## Updating the verification for an intended change

1. Change the model from the code: each action keeps its `@code` tag; one message of the lane (`Lane`'s inbox, `sidecar/lane.rs`) is one action.
2. Change a frozen property (`formal/tab-session/Properties.md`) only for an intended change of the promise, with the old and new text and the evidence.
3. Add a mutation to `formal/tab-session/tla/mutations.json` for each new guard; keep the bug-mode runs in `matrix.json` failing.

## Moving the sync commit

Commit the code and the model first, then `bun <tools-dir>/scripts/verify-all.ts formal --only tab-session --stamp`. Never move it for a failed, blocked or UNAVAILABLE check.
