---
name: stock-lane-verify
description: "Checks when a stock helper lane in the core ends its worker (hung, changed omp, idle, stop) and that no request is stranded and no worker forgotten. Use when changing native/ompdesk/crates/core/src/stock/mod.rs, the stock.request/stock.launch/stock.stop wire in src/main/stock-helper.ts, or when asked whether a terminal's shells can die for a hung scan or an omp update, or whether a stock worker can outlive a stop."
---

# Stock helper lane verification

## The promise and the harm

A lane ends its worker only for a reason that holds at that moment: the terminals worker never but at a stop; a stock worker as hung only while a timed-out request it was sent is unanswered; any worker for a changed omp or idleness only with nothing in flight. No request waits on a lane with neither its worker nor a start asked for, no worker runs that the lane forgot, and a start asked before a stop starts nothing after it. Broken, every open terminal dies for a slow session scan, a session is cut in the middle of a move, a list read hangs for 30 s, or a worker keeps omp's old files open under an update.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `stock-lane` | TLC 1.8.0 | `native/ompdesk/crates/core/src/stock/mod.rs` (`Lane`, the `stock.request` handler) | `formal/stock-lane/tla/StockLane.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `stock-lane` in `formal/manifest.json` (the manifest wins).

## Bounds and assumptions

- 2 requests, 3 workers, 3 starts, one lane of each kind; 3 requests with 2 workers and 2 starts on the stock lane; 11 mutations (state counts and times: `formal/stock-lane/SCOPE.md`). Any order of requests, main's answers to starts, timeouts, answers, exits, grace and idle timers, omp changes and stops.
- Assumptions: the lane takes one message at a time; start numbers never repeat in the process; a fresh lane after a stop equals the emptied lane. Full table: `formal/stock-lane/CORRESPONDENCE.md`.
- Not covered: the worker's own queue and withdrawal (`dispatch.ts`), time (how long a grace or idle exit is, the idle epoch), the lane table's lock, the wait for exits at a stop, the workers ending with the core, liveness. `formal/stock-lane/SCOPE.md`.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only stock-lane
```

`PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT:`: covered code changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against `stock/mod.rs` with each row's `@code` location. A step the lane cannot take (two messages handled at once, a late message from a worker the lane no longer has acting on its state) is a model error: fix the model and say so. Every step possible is a bug: tell it in the code's words and pin it first with a failing case in `src/main/stock-helper.test.ts`, whose worker script has gated and hanging methods and whose `launch` seam can answer late or never. Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (one action per message the lane takes; a new `await` inside the lane's loop splits an action), change a property only when the promise changed on purpose (old wording, new wording, evidence in `Properties.md`), add a mutation for each new guard, run `bun formal/stock-lane/retag.ts` (a Rust location is a line range, which every edit of the file moves), rerun, then move the sync commit with `verify-all.ts formal --only stock-lane --stamp` after committing.
