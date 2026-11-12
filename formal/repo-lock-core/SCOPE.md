# Scope: a repository-lock holder whose git runs in the core process

## The promise

A repository-lock holder that runs past its bound is stopped as it was when main ran git itself (`execBin`): its caller hears of the stop at once, the git it runs is ended (asked, then killed 2 s later) and it starts no other, and the lock's next holder starts only once that git exited. Since unit 2c a holder's gits run in `ompdesk-core` as one request (`coreGit` in `exec.ts`), so the promise now crosses two processes: the stop becomes a `{"cancel": id}` frame, and the step's tracked effect is the request's end (`onEnded` in `process.ts`), which the core sends only once every git of the request exited (`server.rs` `answer`). When the core itself ends (a crash, a kill, `stop()`'s kill), main was the git's parent no more: the core leads its own process group (POSIX) or keeps its children in a kill-on-close job (Windows), and main settles what waited on it only once that group is gone.

## The harm

A stopped or orphaned commit, push, rebase or discard whose git keeps changing the checkout while the next holder (another commit, a worktree removal) works on it: a lost or mixed commit, an `index.lock` collision, a half-applied rebase under a new one.

## Why tests miss it

The orders that matter are a cancel against an answer already in flight, a main-side timeout before or after a stop, a handler that returned while a sibling git still runs, and a core that dies at any of those points. Tests pin a few (`repo-lock-fence.test.ts` "scm commit in the core…", `process.test.ts` "a core that ends while a request runs its git", `server.rs` "answers only once what the request left running has ended"); the model checks every order within the bounds.

## Bounds

One holder and one next holder, one request of at most 2 gits one at a time (`MC.cfg`, 6 088 states, depth 21) and of at most 3 gits two at a time (9 923 states, depth 23), with one scratch store the request may make and remove and up to 2 file system calls of its own (unit 2g), the core free to die at any step; any interleaving of main, the pipe both ways and the core.

## In the model

`coreGit`, `coreGitAnswer`, `coreHeld` and `coreGh` (`heldRequest`/`heldAnswer`: send in a live step, the request's end as the step's effect), the stop and its cancel frame, the call's timeout (fails the caller, sends a cancel, keeps waiting for the end), the step's end in `mutate`, the core's frame loop (a request registers its cancel flag before the next frame), `crates/core/src/run.rs` refusing a spawn once cancelled, a git's exit, disk care's own file system calls of a request (unit 2g: `crates/core/src/disk/tree.rs` `live` before each, the answer only after the worker that made it returned), the scratch object store a request makes and removes (`crates/core/src/git/branches.rs` `Scratch`: a merge prediction, and the landing check that runs under an orphan removal's lock since unit 2f), the handler's return, the answer after the wait group, the core's death, `#receive` and `#ended` (settling a dead core's requests after `groupGone`) in `process.ts`, and `#clearHolds` in `serial-chain.ts`.

## Not in the model

- Timing: the 2 s kill grace, the drain bound (`STALLED_DRAIN_MAX_MS`, after which the next holder is refused `repo_busy` rather than started), the timeouts' and `GROUP_GONE_MS`'s lengths. A killed git is modeled as one that exits.
- The difference between a git that finished and one that was ended: `CancelReachesCore` says the core heard of the stop; that it then ends the running git is `crates/core/src/run.rs` `supervise` (pinned by the Rust test "ends the running process of a cancelled request…").
- How the gits die with the core: one action stands for both platforms. POSIX: main kills the group and polls it (`groupGone`). Windows: the job object kills them as the core's last handle closes, which is before main sees the core's `close`; main has nothing to poll there (assumption, see CORRESPONDENCE).
- Main's own file calls in a step (`fenced-fs`): unchanged by 2c, pinned by `repo-lock-fence.test.ts`; since 2g disk care's under the lock are the saved record (`saved.json`, `writeFileAtomic` with `commitIf`) and the secret check's reads, its archive, scratch indexes, rollback and removals the core's. Since 2f the orphan removal's listing reads the worktree root's real path there (its case "a late listing never removes the worktree"), and the request's own real paths and scratch store are the core's.
- Which git writes into the scratch store: the gits are counted, not named. That the one writing there (`merge-tree --write-tree`) exited before the store goes is `run.rs` returning only after the exit, pinned by the Rust test `a_cancelled_merge_tree_has_exited_before_its_scratch_store_goes`; a git started beside it (`branchEvidence`'s diff) is waited for by `tokio::join!`, not dropped.
- Several requests in one step, several steps queued: each request is this one; the chain's queue is `SerialChain`, unchanged.

## Findings

- `git-starts-before-cancel-arrives` (sanity, reachable): between the stop in main and the cancel frame's arrival in the core, the request may start its next git; it is ended as soon as the cancel is read. `execBin` refused that spawn synchronously. Safety is unaffected (`NoOverlapAfterStop` holds: the next holder still waits for the request's end).
- `core-death-settled-at-once` (fixed): main settled what waited on a dead core at its `close`, and the lock's next holder started while the orphaned git still ran. Reproduced as a failing test first (`evidence/core-death-before.log`), fixed by the process group and the job object (`evidence/core-death-after.log`); `NoOverlapAfterCoreDeath` now holds.
- `group-outlives-its-bound` (residue, by design): a git still in the group `GROUP_GONE_MS` (3 s) after SIGKILL (a process stuck in the kernel) is settled past, with an error and a log line that say gits of the dead core may still run.
- `scratch-left-by-a-dead-core` (residue, by design): a core that dies while a request holds its scratch store leaves that folder in the temp directory (`ompdesk-merge-tree-XXXXXX`), as a main process that died between `mkdtemp` and `rm` left it before 2f. It holds only trees `merge-tree` built, never repository state; `NoScratchAfterStop` therefore speaks of a live core.
