# Correspondence: RepoLockCore.tla ↔ code

| Model | Code | Atomic because |
|---|---|---|
| `Send` | `heldRequest` (`src/main/local/git/exec.ts`, under `coreGit` and `coreGh`): `hold.aborted` checked after the request's runners (`gitRunner()`, `ghRunner()`) are read, then `trackEffect(method, ended)` and `core().call` | no `await` between the last check and the stdin write |
| `Stop` | `SerialChain` `#step` timer or `onParentAbort` aborts the step's signal; `process.ts` abort listener writes `{"cancel": id}` | the abort runs its listeners synchronously |
| `Timeout` | `process.ts` call timer: the call rejects, the id moves to `#late` with `onEnded`, a cancel is written | one timer callback |
| `StepEnds` | `mutate` (`scm.ts`) rethrows or returns once the call settled | the step's code after its one `await` |
| `CoreReadsRequest` | `server.rs` `serve`: `Incoming::Request` inserts the cancel flag, then spawns the request's task | the frame loop inserts before reading the next frame |
| `CoreReadsCancel` | `server.rs` `serve`: `Incoming::Cancel` sets the flag of an id still in `in_flight` | under the map's mutex; an answered id was removed before its frame was sent |
| `Spawn` | `crates/core/src/run.rs` `Exec::run` (every git through `git/run.rs` `Git`, every gh through `gh/mod.rs` `Gh`): `scope.cancelled()` before `Command::spawn` | the check and the spawn have no `await` between them |
| `GitExits` | `crates/core/src/run.rs` `supervise`: `child.wait()`, or SIGTERM/kill after a cancel or the timeout; after the core's death, main's SIGKILL to the group (POSIX) or the job's kill (Windows) | the reaped exit |
| `HandlerEnds` | `server.rs` `answer`: the handler task returns (`?` on a cancelled git, `try_join!` dropping siblings) | the join of the handler task |
| `CoreAnswers` | `server.rs` `answer`: `ended.recv()` returns once every `Scope` clone (each git's `work` task holds one) dropped, then the frame | the last clone drops after `supervise` reaped its git |
| `MainReceives` | `process.ts` `#receive`: pending → `onEnded`, resolve/reject; late → `onEnded`, drop | one stdout chunk handler |
| `CoreDies` | the core process ends (environment); main's `close` handler (`#start`) calls `#ended` | the `close` event |
| `MainSeesDeath` | `process.ts` `#ended`: takes the dead core's pending and late requests out (timers cleared), `groupGone(pid)` SIGKILLs the process group and polls `kill(-pid, 0)` until ESRCH, then `onEnded` and the rejection | the settle runs after the poll answered, in one callback |
| `BoundPasses` | `groupGone` answers false after `GROUP_GONE_MS`; `#ended` settles with "git processes it started may still run" and logs it | the same callback |
| `NextStarts` | `serial-chain.ts` `#clearHolds`: waits for the stopped step's `settled` (its effects) | the chain's tail |

## Abstractions that could hide a bug

- Frames are FIFO and never lost or duplicated each way (two pipes, one writer task per side).
- A cancel for an id the core already answered is ignored: `in_flight` drops the id before the answer frame is queued.
- `GitExits` folds "finished by itself" and "ended after a cancel or a death": the model does not tell them apart (see SCOPE).
- The handler's gits are counted, not named; `Par` bounds how many run at once (`try_join!` of `head`, `log`, `commitDetail`).
- POSIX: every git (and what it starts: hooks, ssh, credential helpers) stays in the core's process group; a process that makes a group or session of its own leaves it, and main neither kills nor waits for it.
- Windows: `MainSeesDeath` waits for `alive = 0`, but main has nothing to poll there. The model assumes the job object ended the gits by the time main sees the core's `close` (the job's last handle closes while the core's process is torn down, before it is signalled); not verified on Windows.
- pid reuse: main signals `-pid` only while the dead core's group can still have members; POSIX does not reuse a pid as a group id while that group exists.
