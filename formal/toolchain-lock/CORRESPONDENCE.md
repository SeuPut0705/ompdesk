# Correspondence: ToolchainLock.tla ↔ toolchain.ts

Every action carries a `@code` tag with its lines. One action is one file-system call (or one pure decision on what was read): node's sync fs calls do not interleave inside one process, while another process can run between any two of them.

| Model | Code | Notes |
|---|---|---|
| `lockExists`, `lockOwner` | the `.lock-<name>` folder and its `owner.json` | `lockOwner = "none"`: folder made, owner not written yet (between `mkdirSync` and `writeFileSync` in `acquire`). |
| `guard` | `.lock-<name>.takeover` | Its 30 s staleness is out of scope. |
| `AcqMkdir`, `AcqWrite` | `acquire` | `writeFileSync` writes into whatever folder exists by then, possibly another's: modeled so. ENOENT → `FailRm` (the catch's `rmSync(lock)`, which removes whatever lock is there) → `failed`. |
| `JOwner`, `JTouch`, `JAlive`, `JConfirm`, `JDecide` | `judge` then the caller's decision | `JTouch` false = `touched()` returned null (no owner file, no folder). `JAlive` = `!pidAlive`; dead = the planted `D` or a process that has exited. `JConfirm` = the second `readOwner` (the fix). |
| `GoneIsAbandoned = TRUE` | the code before 30 Oct 2026 | `touched()` returned 0 for a gone lock, so `idle` was huge and the lock "abandoned"; `takeOver` then checked `existsSync(lock)` afresh. |
| `TrustFirstRead = TRUE` | the code before 30 Oct 2026 | no second read: a pid found dead condemned the lock present at that time, whoever made it. |
| `TkGuard`, `TkRm`, `TkUnguardOk`, `TkUnguardFail` | `takeOver` | `finally` removes the guard in each exit. |
| `Work`, `RelMine`, `RelRm` | `work()`, `release` | The heartbeat is not modeled (it touches only its own lock and never decides). |
| `Exit` | the process ends after `withLock` returned | environment |

## Assumptions that could hide a bug

- A dead process's lock folder changes only through a takeover (no other writer, no pid reuse to a process that would write the same token).
- Locks of live holders are never stale (`staleMs` 5 min against a 1 min heartbeat); a frozen holder is out of scope.
- `rmSync` recursive is atomic. In the code it unlinks `owner.json` before the folder: in between, `judge` sees a folder without owner whose mtime was just updated, which counts as fresh, the same verdict as for a folder being made.
