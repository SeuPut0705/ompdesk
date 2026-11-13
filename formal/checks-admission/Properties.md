# Frozen properties: checks-admission

Frozen at: 14 Nov 2026, from Main's brief (dispatch d1) and `docs/design/check-control.md` §5, §8, §9 and §10, before the model was first checked. Any change to a definition between the `BEGIN FROZEN PROPERTIES` and `END FROZEN PROPERTIES` banners of `tla/ChecksAdmission.tla`, to a constraint, or to `Fairness` is a **model change**: report it with the old text, the new text and the evidence. Never make one to turn a failing check green.

All properties are protocol level: any implementation of the hub's admission must hold them.

| # | Property | Kind | Statement (plain) | Source | Config |
|---|---|---|---|---|---|
| P1 | `WithinPoolLimits` | invariant | No pool holds more jobs than its limit: macOS runners (5), the account's hosted jobs (40, macOS included), a computer's heavy slots. Jobs the hub does not govern count | Brief "never over a pool limit"; design §1 (limits), §4 (pool `limit`), §11 "Shared account limits" | `MC.cfg`, `MC_account.cfg`, `MC_supersede.cfg`, `MC_reuse.cfg` |
| P2 | `AdmittedOnce` | invariant | A job is admitted (takes a place and is dispatched) at most once | Brief "no double admit"; design §10 P2 | same |
| P3 | `HigherLaneFirst` | action property | A job is never admitted while a job of a higher lane (release, land, branch, local) waits for a place that is free for it | Brief "a release job is never behind a branch job for a free slot"; design §5 "Release-bound work first" | same |
| P4 | `FifoWithinLane` | action property | Within a lane, a job is never admitted while an earlier one waits for a place free for it | Brief "FIFO within a lane"; design §5 "Wait when full" | same |
| P5 | `CancelsOnlySuperseded` | action property | The hub cancels a run only when a newer run of the same repo, ref and workflow enters the queue in that step, and never a release run, a merge-queue (`land`) run or a run it does not govern (a person's, another repo's) | Brief; design §5 "Overlapping runs cancel themselves", §9.1 | same |
| P6 | `ReusesOnlyGreen` | action property | A start is answered `reused` only from a green run with the same input digest | Brief "reuse of a green digest"; design §5 "Reuse a green result", §11 "Reuse correctness" | same |
| P7 | `PausedStartsNothing` | action property | While the owner paused admission, a start is refused and no job is admitted | Brief "Pause admission"; design §8 "Pause admission", §9.4 | same |
| P8 | `LapsedLeaseIsFinal` | action property | A held entry whose lease lapsed is never admitted, and its lease never holds again | Brief "held entries with leases and heartbeat expiry", "a held entry whose lease expired frees its place"; design §5 (lease with heartbeat) | same |
| P9 | `FirstInLineCanStart` | invariant | The first live entry in line that has a free place can be admitted (unless paused): nothing ahead of it that cannot start itself (a lapsed entry, an entry whose own pool is full) keeps it waiting | Brief "a held entry whose lease expired frees its place"; design §5 "A free macOS slot goes to the oldest release job, then the rest" | same |
| P10 | `ReleaseEventuallyAdmitted` | liveness | Under `Fairness`, a release job that waits is admitted, unless its lease lapses first | Brief "liveness: a release job waiting is eventually admitted when a slot frees" | `MC_live.cfg` |
| P11 | `LapsedLeaves` | liveness | Under `Fairness`, a held entry whose lease lapsed leaves the queue | Brief "a held entry whose lease expired frees its place" | `MC_live.cfg` |

`Fairness` (what the liveness properties assume, and nothing more): the hub's pump admits when it can, its lease sweep removes a lapsed entry, a dispatch gets an answer (accepted, failed or timed out), every run ends (GitHub's job timeout; the heavy pool's OS file lock), and a cancelled run is eventually seen to end. Nothing is assumed of starts, lease lapses or the owner's pause.

Known limit (must be violated, not frozen as a requirement): `KeepsLastAccountPlace`, finding F1 in `SCOPE.md`.

Sanity (each must be violated, so the model reaches what the properties are about): `NeverAdmits`, `NeverWaitsForAPlace`, `NeverExpires`, `NeverRefuses`, `NeverReuses`, `NeverCancelsARunningJob`, `NeverFillsTheAccount`.
