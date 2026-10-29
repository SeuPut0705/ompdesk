# Scope: the formal skill's install lock

Model: `tla/ToolchainLock.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`. Tests on the real code: `src/main/formal/audit-toolchain.test.ts` › "lock takeover (finding 1)": the 8 × 12 process race, and "a takeover never removes a lock another waiter just made" (the TLC traces, forced step by step with spies and real peer processes, the live local holder, and a taken-over holder's stop).

## The promise and the harm

`withLock` (`resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts`) lets one setup at a time install a tool into the shared cache (two agents may run `setup.ts` together). A waiter takes over a lock whose holder is gone, and only such a lock. If two holders get in at once, two installers download and unpack into the same folder; the toolchain can end up half-written or mismatched while setup reports success.

Why tests miss it: the harm needs a mkdir, or a release and a process exit, by another process exactly between two of the waiter's file-system calls (a stat and an existsSync, a read of the owner file and a kill(0), or a judgment and a delete). The 8 × 12 stress test hit it once, on a loaded Linux runner (release run 40891943183); on macOS it took 16 × 200. The stale branch (nobody touched the lock for 5 minutes) is the same hole with a longer gap: a holder asleep for 5 minutes wakes, releases, and another waiter acquires between the takeover's judgment and its delete.

## In scope

- `withLock`: `acquire` (look, guard, mkdir, owner write), `judge`, `takeOver`, the main wait loop, `release` with `mine()` under the guard, the heartbeat's guarded touch, `touched`.
- A planted lock of a holder on this computer whose pid is gone (`D`) or of a holder on another computer that has been silent for more than staleMs (`R`, which may wake and release at any time, with or without the guard); a lock untouched past staleMs with no readable owner (a process asleep between mkdir and its owner write, `SleepMake`).
- A live holder on this computer that sleeps past staleMs in its work (`Freeze`): `LiveHolderKept`.
- The environment's process exit (after which `kill(pid, 0)` fails).

## Abstracted

- 2, 3 or 4 waiters and one planted holder (`D` or `R`, both explored); every waiter gets the lock once.
- Time: `stale` is a flag. A fresh lock is not stale; the planted one is; `Sleep` sets it for a live local holder or a half-made folder.
- `rmSync(lock, { recursive: true })` is one step.
- A holder's token is its identity (`randomUUID` per call): the model names owners by process.
- The guard's blocking wait in `release` is an enabling condition (`rl_guard` waits for `~guard`); `Termination` needs strong fairness on it (the code retries every 2 ms against a guard held for a few microseconds) and weak fairness on the others.

## Out of scope (not checked)

- The 30 s stale guard (`TAKEOVER_STALE_MS`): a guard holder slower than that is not modeled (nor a guard holder that dies: the next waiter removes the guard after 30 s).
- A holder on another computer whose lock was taken over: it overlaps the new holder until its next heartbeat (up to a minute) finds its token gone; then `work`'s `AbortSignal` stops it (download, unpack and the child process) and it fails as Unavailable. That path is checked by unit tests ("a holder of another computer that slept past staleMs and wakes writes nothing more", "a holder whose lock was taken over is told to stop"), not by the model.
- pid reuse (a reused pid makes waiters wait for it, up to `maxWaitMs`, 2 h, then Unavailable: a deliberate cost of never taking over a live local holder), Windows delete-pending EPERM (`audit-toolchain.test.ts` covers it), signals (`onInterrupt`).

## Status of the runs (30 Oct 2026)

`evidence/matrix-after.txt` is the full `verify-all --only toolchain-lock --stamp` log (about 15 min on one machine: the 4-waiter run alone is 738 s on one worker).

- `MC_two.cfg`: 2 waiters, planted `D` or `R`, `Freeze` and `SleepMake` on, liveness included: 42,473 states, depth 46, 10 s.
- `MC.cfg`: 3 waiters, planted `D`, liveness (`Termination`): 377,373 states, depth 59, 248 s. It leaves `Freeze`, `SleepMake` and `R` out: with them the liveness graph did not finish in 25 min.
- `MC_safety.cfg` (the mutation checker): 3 waiters, `D` or `R`, `Freeze` and `SleepMake` on, safety only: 8,678,702 states, depth 64, 154 s.
- `MC_four.cfg` (tagged `deep`): 4 waiters, `D` or `R`, safety only with symmetry: 31,947,324 states, depth 80, 738 s on one worker (145 s with `--workers auto`). It leaves `Freeze` and `SleepMake` out. `verify-all --only toolchain-lock` runs it too.
- Bug modes (must fail): `MC_original`, `MC_gone`, `MC_firstread`, `MC_gap`, `MC_gap_identity`, `MC_localstale`, and the sanity run.
- Mutations: 8 of 8 detected (`mutations.json`). The two older mutations (a gone lock counted as abandoned, a first read trusted) are gone: with every change of the lock under one guard those two defenses are redundant (nobody can change the lock between the reads), so the model cannot tell them apart; their bug-mode runs still show them as the earlier traces. Their tests stay.
- Traces: `evidence/F1-trace.json`, `F2-trace.json` (the earlier two), `F3-stale-judgment-gap-trace.json` (a holder of another computer wakes and releases between a takeover's judgment and its delete), `F4-identity-alone-trace.json`, `F5-live-local-holder-trace.json`. Tests failing on the code before the fix: `evidence/repro-before-stale-fix.txt`. Stress: `evidence/stress-macos.txt`.
