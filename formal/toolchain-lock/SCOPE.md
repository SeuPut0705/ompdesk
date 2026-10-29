# Scope: the formal skill's install lock

Model: `tla/ToolchainLock.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`. Tests on the real code: `src/main/formal/audit-toolchain.test.ts` › "lock takeover (finding 1)": the 8 × 12 process race, and "a takeover never removes a lock another waiter just made" (the two TLC traces, forced step by step with spies).

## The promise and the harm

`withLock` (`resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts`) lets one setup at a time install a tool into the shared cache (two agents may run `setup.ts` together). A waiter takes over a lock whose holder died, and only such a lock. If two holders get in at once, two installers download and unpack into the same folder; the toolchain can end up half-written or mismatched while setup reports success.

Why tests miss it: the harm needs a mkdir, or a release and a process exit, by another process exactly between two of the waiter's file-system calls (a stat and an existsSync, or a read of the owner file and a kill(0)). The 8 × 12 stress test hit it once, on a loaded Linux runner (release run 40891943183); on macOS it took 16 × 200.

## In scope

- `withLock`: `acquire`, `judge`, `takeOver` with the `.takeover` guard, the main wait loop, `release` with `mine()`, `touched`.
- The environment's process exit (after which `kill(pid, 0)` fails) and a planted lock of a dead process.

## Abstracted

- 2, 3 or 4 waiters and one planted dead holder `D`; every waiter takes the lock once.
- Time: a live holder's lock is never stale (it is touched every minute, `staleMs` is 5 min), so only a dead pid or a gone lock can make a waiter call it abandoned.
- `rmSync(lock, { recursive: true })` is one step.
- A holder's token is its identity (`randomUUID` per call): the model names owners by process.

## Out of scope (not checked)

- The 30 s stale guard (`TAKEOVER_STALE_MS`): a guard holder slower than that is not modeled.
- A holder alive but frozen past `staleMs`: a time lease cannot keep it out by design.
- pid reuse (a reused pid only makes a waiter wait), another computer's lock in a shared cache, Windows delete-pending EPERM (`audit-toolchain.test.ts` covers those), signals (`onInterrupt`).

## Status of the runs (30 Oct 2026)

- Fast tier: `MC_two.cfg` (3,857 states), `MC.cfg` (3 waiters with Termination, 1,062,013 states, depth 54, 94 s), the three bug modes and the sanity run, and the mutations (6 of 6 detected; run under `MC_safety.cfg`, 9 s).
- `MC_four.cfg` (4 waiters, safety, `SYMMETRY ProcSymmetry`) is tagged `deep`: 11,665,775 distinct states, depth 66, 109 s with `--workers auto`, 493 s on the matrix's one worker (without symmetry it passed 107M states and was stopped). `verify-all --only toolchain-lock` runs it too: about 9 minutes in all.
