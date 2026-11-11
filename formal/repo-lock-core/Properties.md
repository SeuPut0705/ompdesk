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

Sanity (must be violated): `NoSpawnAfterStop`.
