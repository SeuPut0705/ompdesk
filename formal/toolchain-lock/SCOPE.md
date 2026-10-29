# Scope: the formal skill's install lock

Model: `tla/ToolchainLock.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`. Tests on the real code: `src/main/formal/audit-toolchain.test.ts` › "lock takeover (finding 1)" (the 8 × 12 process race, and "a takeover never removes a lock another waiter just made": the TLC traces, forced step by step with spies and real peer processes, the live local holder, and a taken-over holder's stop) and "the guard of the install lock" (each guard taken on its own, the guard's identity reclaim, a stalled guard holder, the shared archive, a failing release).

## The promise and the harm

`withLock` (`resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts`) lets one setup at a time install a tool into the shared cache (two agents may run `setup.ts` together). A waiter takes over a lock whose holder is gone, and only such a lock. If two holders get in at once, two installers download and unpack into the same folder; the toolchain can end up half-written or mismatched while setup reports success.

Why tests miss it: the harm needs a mkdir, or a release and a process exit, by another process exactly between two of the waiter's file-system calls (a stat and an existsSync, a read of the owner file and a kill(0), or a judgment and a delete). The 8 × 12 stress test hit it once, on a loaded Linux runner (release run 40891943183); on macOS it took 16 × 200. The stale branch (nobody touched the lock for 5 minutes) is the same hole with a longer gap: a holder asleep for 5 minutes wakes, releases, and another waiter acquires between the takeover's judgment and its delete. The guard that closes those gaps has the same kind of gap itself: a holder that stalls under it for 30 s (a laptop asleep mid-guard) has it reclaimed and then acts on a lock that is no longer the one it judged.

## In scope

- `withLock`: `acquire` (look, guard, mkdir, owner write), `judge`, `takeOver`, the main wait loop, `releaseLock` with `mine()` under the guard, the heartbeat's guarded touch, `touched`.
- The guard (`.lock-<name>.takeover`): its token, its reclaim after 30 s by identity (`reclaimStaleGuard`, `takeGuardAside`), a holder that stalls past 30 s under it, and the check that a holder still holds it right before each delete or make of the lock (`guardStillMine`).
- A planted lock of a holder on this computer whose pid is gone (`D`) or of a holder on another computer that has been silent for more than staleMs (`R`, which may wake and release at any time, with or without the guard); a lock untouched past staleMs with no readable owner (a process asleep between mkdir and its owner write, `SleepMake`).
- A live holder on this computer that sleeps past staleMs in its work (`Freeze`): `LiveHolderKept`.
- The environment's process exit (after which `kill(pid, 0)` fails).

## Abstracted

- 2, 3 or 4 waiters and one planted holder (`D` or `R`, both explored); every waiter gets the lock once.
- Time: `stale` is a flag. A fresh lock is not stale; the planted one is; `Sleep` sets it for a live local holder or a half-made folder. `gstalled` says the guard is more than 30 s old; `Stall` sets it (at most `Stalls` times a run) and `AgeUp` ages an ownerless folder.
- `rmSync(lock, { recursive: true })` is one step.
- A holder's token is its identity (`randomUUID` per call, per guard taking): the model names owners by process.
- The guard's blocking wait in `release` is an enabling condition (`rl_guard` waits for `gown = None`); `Termination` needs strong fairness on it (the code retries every 2 ms against a guard held for a few microseconds) and weak fairness on the others.
- The reclaim of a stale guard is one atomic step (`QReclaim`): the real one moves the folder aside, reads its token and deletes or puts it back. Its few calls are not interleaved with other processes in the model.
- `R`'s guard checks are always atomic, and a failed release (a busy guard for `guardWaitMs`, an fs error) is not modeled: it leaves the lock to a holder that has exited, which is the dead holder the model already has.

## Assumptions the model cannot discharge (the stall)

Every destructive step (`mkdirSync(lock)`, the owner write, the delete in a takeover and in a release, the heartbeat's touch) is preceded by `guardStillMine()`: the guard folder still holds this call's token and was taken less than 10 s ago. A holder that stalled past 30 s, or whose guard was reclaimed and taken by another, gives the step up (a release takes the guard again, 3 times). With that check TLC finds no violation (`MC_stall.cfg`, `MC_stall_three.cfg`); without it, a stalled holder deletes the lock another holder made (`MC_stall_norecheck.cfg`, mutation `no-guard-recheck`).

What is left is a stall that begins after the check returned and ends after a reclaimer removed the guard and another holder changed the lock, before the call that the check guarded: two adjacent statements, one fs call apart (`MC_stall_gap.cfg` is that interleaving and fails, as expected). The model does not make it impossible, it shows what it costs: the old lock, deleted or written into by a holder that should have stopped. The code makes it unlikely, not impossible: the check and the call are adjacent, the guard is reclaimed only after 30 s, and a holder acts only within the first 10 s of its guard. The cost of the remaining window is the original harm (two holders in the install folder for the rest of one of their runs); the holder whose lock was removed finds its token gone at its next heartbeat and stops (the abort signal below).

Also not modeled: the few calls of the reclaim itself. A guard that is replaced between the reclaimer's judgment and its move-aside is put back; if a third process takes the guard name during the put-back's window, the put-back is dropped and that guard's holder loses it. Its own re-check then makes it give up its step, so the window costs a retry, not a second holder (`GuardKept` is checked for the atomic version only: `race-9` shows the by-name reclaim breaking it).

## Out of scope (not checked)

- A holder on another computer whose lock was taken over: it overlaps the new holder until its next heartbeat (up to a minute) finds its token gone; then `work`'s `AbortSignal` stops it (download, unpack and the child process) and it fails as Unavailable. That path is checked by unit tests ("a holder of another computer that slept past staleMs and wakes writes nothing more", "a holder whose lock was taken over is told to stop", "keeps the archive when the holder is told to stop while the unpack ends": the archive at `downloads/<file of its url>` is shared by every holder of the lock and the next one reuses a verified one, so an aborted holder never deletes it), not by the model.
- pid reuse (a reused pid makes waiters wait for it, up to `maxWaitMs`, 2 h, then Unavailable: a deliberate cost of never taking over a live local holder), Windows delete-pending EPERM (`audit-toolchain.test.ts` covers it), signals (`onInterrupt`: the release a signal runs waits 250 ms for the guard, never the 60 s of a normal one; the test "a signal's release gives up on a busy guard within moments").
- A release that fails after the work did not: it is logged and never fails the work (tests "a release that fails does not fail the work" and "a guard that stays busy for the release does not fail the work either").

## Status of the runs (30 Oct 2026)

`evidence/matrix-after.txt` is the full `verify-all --only toolchain-lock --stamp` log (16.5 min on one machine, deep runs included: the 4-waiter run alone is 783 s, then the mutations).

- `MC_two.cfg`: 2 waiters, planted `D` or `R`, `Freeze` and `SleepMake` on, liveness included: 42,473 states, depth 46, 10 s.
- `MC.cfg`: 3 waiters, planted `D`, liveness (`Termination`): 377,373 states, depth 59, 262 s. It leaves `Freeze`, `SleepMake` and `R` out: with them the liveness graph did not finish in 25 min.
- `MC_safety.cfg` (the mutation checker): 3 waiters, `D` or `R`, `Freeze` and `SleepMake` on, safety only: 8,678,702 states, depth 64, 154 s.
- `MC_four.cfg` (tagged `deep`): 4 waiters, `D` or `R`, safety only with symmetry: 31,947,324 states, depth 80, 783 s on one worker. It leaves `Freeze` and `SleepMake` out. `verify-all --only toolchain-lock` runs it too.
- The guard holder stalls (30 Oct 2026, one stall per run, a reclaimer that works by identity, the check atomic): `MC_stall.cfg` 2 waiters, `D` or `R`, `Freeze` and `SleepMake` on: 577,914 states, depth 65, 17 s; with `Termination` (`MC_stall_live.cfg`): the same states, 155 s; `MC_stall_three.cfg` (tagged `deep`) 3 waiters with symmetry, safety only: 13,191,897 states, depth 82, 242 s.
- Bug modes (must fail): `MC_original`, `MC_gone`, `MC_firstread`, `MC_gap`, `MC_gap_identity`, `MC_localstale`, `MC_noacqguard` (acquire without the guard), `MC_norelguard` (release without it), `MC_stall_norecheck`, `MC_stall_gap` (the stall between the check and the call, the assumption above), `MC_stall_byname` (the guard reclaimed by its name: `GuardKept`), and the sanity run.
- Mutations: every one detected, two declared equivalent with their reason (`local-release-skips-guard`, `recheck-ignores-the-stall`); the count is in the log. The two older mutations (a gone lock counted as abandoned, a first read trusted) are gone: with every change of the lock under one guard those two defenses are redundant (nobody can change the lock between the reads), so the model cannot tell them apart; their bug-mode runs still show them as the earlier traces. Their tests stay. `no-takeover-guard` is checked with the guard check off (`MC_two_norecheck.cfg`): with the check on, two takeovers both "taking" the guard are still told apart by the token, so the check hides a missing exclusion on the guard itself (defense in depth).
- Traces: `evidence/F1-trace.json`, `F2-trace.json` (the earlier two), `F3-stale-judgment-gap-trace.json` (a holder of another computer wakes and releases between a takeover's judgment and its delete), `F4-identity-alone-trace.json`, `F5-live-local-holder-trace.json`. Tests failing on the code before each fix: `evidence/repro-before-fix.txt`, `repro-before-stale-fix.txt`, `repro-before-review-fixes.txt`. Stress: `evidence/stress-macos.txt`.
