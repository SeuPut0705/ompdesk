---
name: repo-lock-core-verify
description: "Checks that a repository-lock holder whose git runs in the ompdesk-core process is stopped as execBin stopped it, and that no git of a stopped holder or of a core that died runs beside the next holder. Use when changing heldRequest, coreGit or coreGh in src/main/local/git/exec.ts, the cancel, timeout, onEnded, process-group or death paths of src/main/core/process.ts, the frame loop, Scope or answer in native/ompdesk/crates/core/src/server.rs, Exec::run or supervise in native/ompdesk/crates/core/src/run.rs, the scratch object store (Scratch) in native/ompdesk/crates/core/src/git/branches.rs, the job object in native/ompdesk/crates/core/src/sys.rs, or SerialChain's holds; or when asked whether a stopped commit or push, or one whose core crashed, can still change the checkout under the next one."
---

# Repository lock over the core: verification

## The promise and the harm

A holder of `withRepoLock` that runs past its bound fails its caller at once; the request it has in the core is cancelled (`{"cancel": id}`), the core ends the git it runs (SIGTERM, kill 2 s later) and starts no other, and answers only once every git of the request exited; main keeps that answer (`onEnded`) as the step's tracked effect, so the next holder starts only after it. When the core itself ends, its gits end with it (its process group on POSIX, which main kills and waits out; its kill-on-close job on Windows) before main settles what waited. Broken, a stopped or orphaned commit, push, rebase or discard keeps changing the checkout while the next holder works on it.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `repo-lock-core` | TLC 1.8.0 | `heldRequest` and `coreGit` (`exec.ts`), `mutate` (`scm.ts`), `process.ts`, `serial-chain.ts`, `server.rs`, `run.rs`, `sys.rs`, `main.rs`, the scratch object store of `git/branches.rs` (`Scratch`) | `formal/repo-lock-core/tla/RepoLockCore.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `repo-lock-core` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- One holder and one next holder, the core free to die at any step; one request of 2 gits one at a time (1 752 states) and of 3 gits two at a time (2 777 states), each with one scratch store the request may make and remove.
- Assumptions: frames FIFO both ways; the core registers a request's cancel flag before it reads the next frame; an answered id leaves `in_flight` before its frame is queued; a killed git counts as an exited one; on Windows the job ended the gits by the time main sees the core's `close` (main has no group to poll there; not verified on Windows). Full table: `formal/repo-lock-core/CORRESPONDENCE.md`.
- Known limits, in `SCOPE.md`: a git may start between the stop and the cancel's arrival (then ended at once; `git-starts-before-cancel-arrives`); a git that outlives SIGKILL past `GROUP_GONE_MS` is settled past with an error that names it (`group-outlives-its-bound`); a core that dies while a request holds its scratch store leaves that temp folder (`scratch-left-by-a-dead-core`).

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only repo-lock-core
```

A few seconds (7 runs, 11 mutations). `PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT:`: covered code changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against the code with each row's `@code` location. A step the code cannot take is a model error: fix the model and say so. Every step possible is a bug: pin it with a failing test first (`src/main/repo-lock-fence.test.ts` "scm commit in the core…", `src/main/core/process.test.ts` "a core that ends while a request runs its git" (also on Windows), the `server.rs` and `run.rs` cancel tests, `git/branches.rs` "a cancelled merge-tree has exited before its scratch store goes"). Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (one step per synchronous run; a new `await` splits a step), change a property only when the promise changed on purpose (old wording, new wording, evidence in `Properties.md`), add a mutation for each new guard, rerun, then move the sync commit with `verify-all.ts formal --only repo-lock-core --stamp` after committing.
