# Scope: when a stock helper lane ends its worker, and what becomes of the requests on it

## The promise

A lane of the stock helper's host (the core's `stock/mod.rs`) ends its worker only for a reason that holds at that moment: the terminals worker never but at a stop; a stock worker as hung only when a timed-out request it was sent is still unanswered; any worker for a changed omp or for idleness only with nothing in flight on it. No request waits on a lane that has neither its worker nor a start asked for, no worker runs that the lane forgot, and nothing asked for before a stop starts a worker after it.

## The harm

The terminals worker holds every open shell: ended wrongly, every terminal of every tab dies with what ran in it. A stock worker ended in the middle of `sessions.move` or `sessions.delete` leaves a session half moved. A request stranded on a dead lane holds a session list or a tab's start for its whole 30 s. A worker the lane forgot keeps omp's files open under an update (the "Export named … not found" failures of 12 Nov 2026) and stays until the app quits.

## Why tests miss it

The lane hears everything late and in any order: main's answer to a start, a caller's timeout, a worker's answer and its exit, the grace and idle timers of a worker that may already be gone. `stock-helper.test.ts` drives the orders someone wrote down, each against real processes with real timers; the model takes every order of those messages within the bounds. The port made the orders new: in the TypeScript the state lived on main's one thread and a late callback compared `this.#child`; here each late message carries the worker it was armed for.

## Bounds

2 requests, 3 workers, 3 starts, one lane of each kind (`MC.cfg` stock: 89,630 distinct states, depth 21; `MC_terminals.cfg`: 35,318, depth 20; `MC_extensions.cfg`: 101,328, depth 22; about 6 s each). 3 requests with 2 workers and 2 starts on the stock lane (`MC_three_requests.cfg`): 4,459,158 distinct states, depth 26, about 100 s. 3 requests with 3 workers and 3 starts did not finish in 10 minutes (28 million states, no violation up to depth 23): not checked. 11 mutations, each detected. Log: `evidence/2026-11-12-verify.txt`.

## In the model

`Lane::request` with the retire for a changed omp, the start asked of main and its late or missing answer, `launched` (spawn, or fail what waited), the request's timer in its handler and `gave_up`, `line`, `overdue` (the recycle), `idle`, `exited`, `stop`, a worker that answers in any order, never answers, or exits at any moment, and omp being replaced at any moment.

## Not in the model

- The worker's own queue and withdrawal (`resources/gui-bridge/stock-helper/dispatch.ts`): that a withdrawn request never runs is pinned by `stock-helper.test.ts` "createDispatcher" and "never runs a queued mutation whose caller already timed out".
- Time: how long a grace or an idle exit is, and that an idle timer armed before a newer request does nothing (`idle_epoch`). See `CORRESPONDENCE.md`.
- The table of lanes and its lock (`LANES`, `end_lanes`): one lane only. That a request never lands behind a stop in a lane's inbox is by the lock both hold.
- That a stop waits for the workers' exits (`STOP_WAIT`), and the workers ending with the core (the job object on Windows, the process group and the stdin pipe elsewhere): pinned on real processes by `stock-helper.test.ts` "ends its workers with the core, however the core ends" and "rejects pending requests on stop()".
- Liveness: every request ends by its own timer, armed in its handler before anything else; not checked here.
- Main's side of `stock.launch` (`src/main/stock-helper.ts`): the model lets main answer any start late, with a start or a failure, or never.
