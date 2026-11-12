# Properties (frozen)

Definitions live between the banners in `tla/RepoLockCore.tla`.

| Property | Statement | Source |
|---|---|---|
| `NoOverlapAfterStop` | The next holder never runs while a git of the stopped holder's request is alive. | `exec.ts` `execBin` ("a git still writing must not overlap the next holder"); `serial-chain.ts` header; `withRepoLock` doc |
| `NoSpawnAfterCancel` | Once the core read the cancel, the request starts no git. | `execBin` ("a call made in a chain step that was stopped never starts"); the unit 2c brief (a stopped write's sequence ends) |
| `AnswerAfterHandler` | A request answers only when its handler returned. | `server.rs` `answer` |
| `StopReleases` | A stopped holder hands the lock on: the next holder runs. | `SerialChain` doc ("the chain went on without it") |
| `CancelReachesCore` | A stopped holder's request still in flight is cancelled in the core once the core read what main sent. | the unit 2c brief (keep the TypeScript's kill of a stopped write's git) |
| `NoOverlapAfterCoreDeath` | After the core died, the next holder never runs while a git it started is alive (a step that timed out is the call timeout's own case, as `execBin`'s). | the unit 2c review (12 Nov 2026): main was the git's parent, so no next holder ran without main |
| `NoScratchAfterStop` | While the core lives, the next holder never runs while the stopped holder's request still has its scratch object store on disk. Added in unit 2f, a new promise (no earlier property weakened): the landing check under an orphan removal's lock made and removed that folder on main's fenced files (`branches.ts` `mergesAddNothing`, `mkdtemp`/`rm` in `finally`), and now the request makes and removes it. | `machine-setup-updates.md` "the whole `withRepoLock` callback is fenced … a call the OS already has is waited for"; the unit 2f brief (a scratch store is made and removed inside the request, also on cancel, timeout and failure) |
| `NoDiskAfterStop` | The next holder never runs while a file system call of the stopped holder's request is in flight. Added in unit 2g, a new promise (no earlier property weakened): disk care's save, archive and removal steps under a repository lock did their disk work on main's fenced files (`disk/saved-worktrees.ts`, `fenced-fs`: a call the OS already had was waited for before the next holder ran), and now the request does it. | `machine-setup-updates.md` "a call the OS already has is waited for"; the unit 2g brief (the fence tests' promise holds for the moved disk work) |
| `NoDiskAfterCancel` | Once the core read the cancel, the request starts no file system call. Added in unit 2g. | `machine-setup-updates.md` "an effect it has not started yet … is fenced" (`fencedCall` refused a call before it started); the unit 2g brief (a cancelled request reports nothing partial and makes nothing more) |

Sanity (must be violated): `NoSpawnAfterStop`.
