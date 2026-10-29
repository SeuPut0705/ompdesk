# Correspondence: ToolchainLock.tla ↔ toolchain.ts

Every action carries a `@code` tag with its lines. One action is one file-system call (or one pure decision on what was read): node's sync fs calls do not interleave inside one process, while another process can run between any two of them.

| Model | Code | Notes |
|---|---|---|
| `lockExists`, `lockOwner`, `stale` | the `.lock-<name>` folder, its `owner.json`, and whether the mtime that `touched()` returns is older than staleMs | `lockOwner = "none"`: folder made, owner not written yet (between `mkdirSync` and `writeFileSync` in `makeLock`). `stale` is true for the planted lock; a made lock is fresh. |
| `guard` | `.lock-<name>.takeover` | Held by acquire (`ctx "ac"`), takeover (`"tk"`), release (`"rl"`) and, in the code, the heartbeat. Its 30 s staleness is out of scope. |
| `AcqPeek`, `AcqGuardOk`, `AcqGuardBusy`, `AcqMkdir`, `AcqWrite` | `acquire`, `makeLock` | `acquire` looks (`existsSync`), takes the guard, then `makeLock`: mkdir, owner write. `writeFileSync` writes into whatever folder exists by then, possibly another's: modeled so. ENOENT → `FailRm` (the catch's `rmSync(lock)`) → `failed`. A failed look or mkdir lets the guard go and judges. |
| `JOwner`, `JTouch`, `JAlive`, `JConfirm`, `JDecide` | `judge`, then the caller's decision | `JTouch` records the mtime verdict: `seenStale` counts only for an owner that cannot be asked (`R`, or no readable owner) unless `LocalStale`. `JAlive` = `local && !pidAlive`; dead = the planted `D` or a process that has exited. `JConfirm` = the second `readOwner`; a changed owner cancels dead and stale alike. |
| `GoneIsAbandoned = TRUE` | the code before 30 Oct 2026 (first fix) | `touched()` returned 0 for a gone lock, so `idle` was huge and the lock "abandoned"; `takeOver` then checked `existsSync(lock)` afresh. |
| `TrustFirstRead = TRUE` | the same | no second read: a pid found dead condemned the lock present at that time, whoever made it. |
| `GuardedAcq = FALSE` | the code before the second fix | acquire, release and the heartbeat did not take the guard. |
| `IdentityOnStale = FALSE` | the same | `abandoned = dead || idle > staleMs` with the stale half outside the identity check. |
| `LocalStale = TRUE` | the same | staleness condemned a live holder on this computer. |
| `TkGuardOk`, `TkGuardBusy`, `TkRm`, `TkUnguardOk`, `TkUnguardFail` | `takeOver` | `finally` removes the guard in each exit. |
| `Work`, `RlGuard`, `RelMine`, `RelRm`, `RelEnd` | `work()`, `release` | `release` = `underGuardSync(() => { if (mine()) rmSync(lock) })`: a blocking spin on the guard (the enabling condition of `RlGuard`). The heartbeat's touch is not modeled; `Sleep` stands for its silence. |
| `Sleep` | a computer asleep | environment; not tagged. `Freeze`: a live local holder in its work; `SleepMake`: a process between mkdir and its owner write. |
| `ROut`, `RGuard`, `RMine`, `RRm`, `REnd` | the same `release`, running on another computer | environment: the holder `R` wakes and releases; unguarded (old code) it reads the owner and removes the folder in two steps, guarded it does both under the guard. `R`'s own work and abort are outside `Procs` (see `SCOPE.md`). |
| `Exit` | the process ends after `withLock` returned | environment |

## Assumptions that could hide a bug

- A dead process's lock folder changes only through a takeover (no other writer, no pid reuse to a process that would write the same token).
- `rmSync` recursive is atomic. In the code it unlinks `owner.json` before the folder: in between, `judge` sees a folder without owner whose mtime was just updated, which counts as fresh, the same verdict as for a folder being made (and a takeover cannot judge it: it needs the guard, which the remover holds).
- Weak fairness of every process step and of `R`'s release, strong fairness of the guard waits of `release` and `R`'s release. The acquire's look (`AcqPeek`) is needed for `Termination`: without it two waiters polling a held lock take the guard in turn and every takeover finds it busy (a livelock TLC finds; mutation `acquire-without-peek`).
- A guard holder is not slower than 30 s and does not die while holding it.
- `stale` is a flag, not a clock: a holder that sleeps for a minute, not five, is not modeled (it is simply not stale).
- The release of a holder on this computer matters for exclusion only through the guard's uniformity: the model finds the gap only through `R`'s release (a local live holder is never judged abandoned). The guard on the local release and the heartbeat is kept so no change of the lock bypasses it.
