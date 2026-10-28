# Scope: the connection wait of a failed turn

Model: `tla/TurnResume.tla` (TLC). Properties: `Properties.md`. Code map and assumptions: `CORRESPONDENCE.md`.

## The promise and the harm

A turn that ended in a network failure continues by itself once connectivity is back, never on top of what the user did meanwhile: no retry is sent into a run the user started, Cancel / Stop / a new prompt / a session or branch change during the probe never leads to a later retry, a held wait always ends, and the marker file says `network` while a wait holds.

If it breaks, a retry runs in the middle of a turn the user started (or after they gave up on it), a wait row stays on screen forever, or a crash during the wait loses the turn that was supposed to continue.

Why tests miss it: each guard is tested alone (a prompt during the wait, Cancel during the probe); the failures are in the order of two guards and an async gap (`await #stockRetryOn`, `await whenReady`, the probe promise) that a test only reaches if it thinks of that exact order.

## In scope

- `TurnResume`: `sync()` and `#judge` (the run's outcome decides hold / probe / plan), `#verifyNetwork` and its `.then`, `#hold`, `flush`, `#run` (generation capture, `whenReady`, the `retry` send), `#planRetry` / `#arm` / `#fire` / `#watchScheduledRetry` / `#dropScheduled` / `#releaseScheduled`, `cancelWait` / `#dropWait`, `deriveMarkers` (the marker file).
- `ConnectivityMonitor`: `verify(host)` with one shared probe per host, `#check`, `#reachable`, the recovery loop (`#attempt` and its 2 s timer), `report()`, `#set()` and the `changed` callback that calls `TurnResume.connectivityChanged()`.
- The pool facts the rules read (`running`, `lastRun`, `stopped`, `touched`/session file, `awaitingConnection`), as environment actions that each end in a `sync()`.
- The relaunch's own wait: `launch()` while offline holds each marker's continuation with the session and branch its tab shows (`Launch`, once, before any run of this process); the held launch marker counts as the `network` marker (CORRESPONDENCE A9).

## Abstracted

- One tab (a second tab is a larger-bounds run, not modeled by default); one host name; one session path per tab and a single counter `sg` for "session file or `touched` changed".
- Outcomes are four kinds: `dns` (a network error naming a lookup), `net` (another network-class error), `transient` (server error, overload), `fatal` (not retryable, or the run did not end in error).
- The link: `net.isOnline()` (`link`), the default way out (`defOK`) and the failed host (`hostOK`) are separate booleans that flip; a probe answers `link at its start AND (defOK OR hostOK at its end)`.
- Time is order only: a timer may fire at any moment after it is armed; delays (30 s / 2 min / 10 min, 2 s, 2.5 s) are not modeled.
- `sync()` and `flush()` are synchronous regions: they run as a chain of micro-steps under a global program counter that nothing interleaves with (the code runs them in one macrotask).
- The `retry` RPC is one atomic send; stock then either starts a retried run or has nothing to retry.

## Out of scope (not checked)

- The rest of the launch path: an online launch's `#run` (`restore_interrupted`, the `retry` fallback), `#pending` bookkeeping past the wait, `resumeGoal`, `goalSettled`, `unsavedPrompt`, how a marker finds its tab.
- Stock's own auto-retry saga and its takeover (`fact.retry`, `#takeOverRetry`, `#takenOverRuns`).
- The wake window (`ConnectivityMonitor.suspend()`/`resume()`, `shouldWait()` after a wake); `shouldWait()` is `!online` here.
- Hosted tabs (`fact.device`, `fact.peer`), the quit freeze (`frozen()`), tab close (`#dropScheduled` on a missing tab), the `enabled()` setting.
- Stock `retry.enabled` toggling (`#stockRetryOn` is always true).
- The retry RPC's duration: a user prompt that arrives while the `retry` command is in flight is stock's to resolve.
- Attempt counting beyond a bound of 2 attempts (the code allows 3).
