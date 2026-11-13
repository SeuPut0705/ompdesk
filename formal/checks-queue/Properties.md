# Properties (frozen)

Frozen 14 Nov 2026, before the code was written. Definitions live between the banners in `tla/ChecksQueue.tla`. A change to one, to a `CONSTRAINT` or to the fairness of `FairSpec` is a model change: say so with the old and new text.

| Property | Statement | Source |
|---|---|---|
| `OnlyTestedLands` | Every commit the queue pushes to the base is one the check reported green as exactly that commit. | `docs/design/check-control.md` §5 policy 3: "build once on a temporary branch OMPdesk owns, and land in order when green"; §11 "Reuse correctness: a wrong key reports green for something never run … the key includes … the base of a batch" |
| `NeverForced` | Every change of the base keeps what was on it. | Main's brief for P3: "fast-forward/rebase onto main, never force main"; `.omp/rules/autopilot.md` "never `+`" |
| `NoBadOnMain` | With a truthful check, no entry that fails it is on the base. | The same policy: a red batch does not land |
| `LandsOnce` | Nothing is on the base twice. | A landing is a fast-forward to a tested commit, not a replay |
| `LandInOrder` | Entries of one goal are on the base in the order they arrived. | §5 policy 3 "land in order"; §10 P3 done-when "a batch of release-bound branches lands in order with one run" |
| `OnlyTestedRedFails` | An entry is failed only for a commit the check reported red: the tip it was failed on plus that entry alone. | §5 policy 3 "a red batch bisects": the culprit is found, not guessed; "skips combinations already known red" must not fail an entry on a tip it was never tested on |
| `WithdrawnNeverLands` | An entry that was withdrawn or failed, or still waits, is not on the base. | `QueueState` `removed`, `failed` (§3): terminal states |
| `LandedIsOnMain` | An entry the queue calls landed is on the base. | `Answer.next: land` and the page's queue are read as fact (§7 criterion 3: never green from old data) |
| `Drains` | Once the world stops interfering, the line and the flight empty. | The owner's rule that agent work is never held back (AGENTS.md › Code conventions) |

Sanity (must be violated): `NeverLands`, `NeverFails`, `NeverBisects`, `NeverLandsPart`, `NeverTestsStale`.
