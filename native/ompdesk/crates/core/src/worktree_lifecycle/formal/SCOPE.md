# Worktree lifecycle race scope

The model covers one fresh local tab, its one stock creation, an optional start question, close, quit preparation, one cleanup claim, the exact disposed omp's exit, removal approval and one later file or ref change. It explores their interleavings, including a dropped start waiter. It does not model git internals, stock clone backends, filesystem symlinks, native window transport, process death or unbounded tab identities.

## Frozen properties

- `SingleCleanupOwner`: close and quit take an owned worktree at most once. Source: `src/main/worktree-lifecycle.ts` `released` and `finalize` identity check.
- `NoBindAfterClose`: creation finishing after close never binds the closed tab. Source: `startGate` binding refusal and late-created cleanup.
- `NoRemoveWhileOmpAlive`: removal waits for the exact disposal that closed this tab. Source: `#awaitExit`; native Base captures the disposal future before releasing the canonical source.
- `OnlyApprovedFingerprint`: removal requires approval and an unchanged fingerprint. Source: `#plan` and `#remove`.
- `NoLostCreatedWorktree`: creation completion has a retained start owner while the hub bind waits, then either a live tab owner or a cleanup owner. Source: `start_inner` retains the created value across the identity-checked hub bind; the two branches following it transfer that ownership.

## Correspondence

`settings`, `ask`, `create`, `bind` and `owned` correspond to the awaits in `Lifecycle::start_inner`. `Close` is `released`'s locked state update. `QuitPrepare` is the stop/refresh interval; `QuitTake` is its later identity-checked locked take. These must remain separate. `CreateReply` retains the created worktree in the start task. `BindReply` is the later locked bind-or-exit publication after the native hub's identity check, not the stock git mutation. The initial model sketch combined those steps; they were split before checking it, and `NoLostCreatedWorktree` now explicitly includes the retained start owner during that await. `OmpExited` is the exact exit future supplied at pool release. `Approve` abstracts clean automatic selection and an accepted risk prompt. `Edit` changes the fingerprint after selection. `Remove` abstracts the second snapshot and existing guarded git removal; its git operations are not claimed atomic against another process editing the checkout.

No fairness is asserted. This model checks safety, not whether a user answers or stock ever completes. A hung omp is kept by the runtime's timeout and is not modeled as eventually exiting.

## Checks

Local: `tlc.ts WorktreeLifecycle.tla --sany-only --config MC.cfg` parses and level-checks only. Hosted: run the matrix and mutation file through the repository formal workflow after Base registers this directory in the global manifest. No matrix or mutation result is claimed by a local parse.
