# Properties (frozen)

Definitions live between the banners in `tla/StockLane.tla`.

| Property | Statement | Source |
|---|---|---|
| `NothingInFlightIsCut` | A worker is let go for a changed omp or for idleness only while no request it was sent is unanswered. | `.omp/rules/machine-setup-updates.md` › omp updates itself: "never while a request is on its way to it"; AGENTS.md › Stock helper workers: the extensions worker "ends 60 s after its last answer"; `stock-helper.test.ts` "keeps an idle-exit worker up while a request it was sent still runs, even one whose caller timed out" |
| `TerminalsWorkerIsNeverEnded` | The lane of the terminals worker ends it only when it is stopped: never for a hung request, a changed omp or idleness. | AGENTS.md › Stock helper workers: "A hung stock call can never take a shell or a running upgrade with it"; machine-setup-updates: "never the terminals worker, whose shells would go with it" |
| `OnlyTheStockWorkerIsRecycled` | Only the stock worker is ever ended as hung. | AGENTS.md › Stock helper workers: "The terminals and extensions workers are never replaced for a slow request" |
| `OnlyAStuckWorkerIsRecycled` | A worker is ended as hung only for a request it was sent, whose caller timed out, and that it has not answered (neither a late result nor the withdrawal). | AGENTS.md › Stock helper workers: "If a timed-out request still has no answer 30 s later, the lane is stuck"; `stock-helper.test.ts` "its acknowledged withdrawal keeps the worker" |
| `NoRequestStranded` | A request the lane still owes an answer waits for a worker start that was asked for, or is unanswered on the lane's own worker. | Commit 1c71982f's rule (a fresh worker is started for the asking request); `stock-helper.test.ts` "recycles … and starts afresh lazily": what waits fails with the restart instead of waiting out its timeout |
| `NoWorkerIsForgotten` | Every worker that runs with its stdin open is the lane's worker: none is left running that nothing will end. | AGENTS.md › Dev rules: "Child processes the app spawns must not outlive it"; machine-setup-updates: workers are "stopped before the installer" |
| `AStartAskedBeforeAStopStartsNothing` | An answer to a worker start asked for before a stop starts no worker. | `stop()` of the TypeScript host ("an omp update must not replace files a live worker still reads"; a start that finished after it ended the child at once) |

Sanity (must be violated): `NeverRecycles`, `NeverRetires`, `NeverIdleExits`, `NeverAnswersLate`.
