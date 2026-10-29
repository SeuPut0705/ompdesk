---
name: toolchain-lock-verify
description: "Checks that the formal skill's install lock lets one setup in at a time and takes over only a dead holder's lock. Use when changing withLock, touched or readOwner in resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts, or when asked whether two setups can install into the formal cache at once."
---

# Toolchain lock verification

## The promise and the harm

`withLock` lets one installer at a time into the shared formal cache; a waiter takes over a lock only when its holder's pid is dead on this computer, or (another computer's lock) nobody touched it for minutes. A live holder on this computer is never taken over. Broken, two setups download and unpack into the same folder at once, and a half-written toolchain passes as installed.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `toolchain-lock` | TLC 1.8.0 | `toolchain.ts#withLock`, `#touched`, `#readOwner` | `formal/toolchain-lock/tla/ToolchainLock.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `toolchain-lock` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- 2 and 3 waiters plus a planted holder that is either dead (`D`) or on another computer and silent (`R`), liveness included; 4 waiters, safety only with symmetry, is the deep run in the matrix. Numbers: `formal/toolchain-lock/evidence/matrix-after.txt`.
- One action per fs call (sync fs calls of one process never interleave; another process can run between any two). Every change of the lock folder (make, release, takeover, heartbeat) runs under the `.takeover` guard; `acquire` looks first. A live holder on this computer is never taken over (`LiveHolderKept`); staleness condemns only another computer's lock or an ownerless one. Out of scope: the 30 s stale guard, pid reuse (waiters wait up to 2 h), Windows EPERM, and the abort of a taken-over holder of another computer (unit tests: `work(signal)` stops download, unpack and the child, then `withLock` fails Unavailable) (`formal/toolchain-lock/SCOPE.md`, `CORRESPONDENCE.md`).
- `MutualExclusion` holds because judge never calls a gone lock abandoned, a changed owner cancels abandonment, and the guard serializes every removal, make and release.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only toolchain-lock
```

`PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT:`: covered code changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against the code with each row's `@code` location. A step the code cannot take is a model error: fix the model and say so. Every step possible is a bug: pin it first as a failing test in `src/main/formal/audit-toolchain.test.ts` › "a takeover never removes a lock another waiter just made" (spies on `fs.mkdirSync`, `fs.existsSync`, `fs.statSync`, `fs.rmSync` and `process.kill`, and real peer processes, place the other processes' steps exactly). Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (one fs call per action), change a property only when the promise changed on purpose (`Properties.md`), add a mutation for each new guard, rerun, then move the sync commit with `verify-all.ts formal --only toolchain-lock --stamp` after committing.
