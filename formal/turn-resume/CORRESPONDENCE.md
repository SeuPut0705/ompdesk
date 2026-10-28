# Correspondence: turn-resume

Sync commit: `b7d45962525cd52ce08554f6fce5e75cd92c20be` (the commit at which this map was confirmed against the code; the same value as `syncCommit` of `turn-resume` in `formal/manifest.json`).

The `@code path:lines` tags in `tla/TurnResume.tla` are the machine-checked half of this map (`verify-all.ts` fails on a tag that does not resolve). This table records what each tag abstracts and the assumptions the model relies on.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `UserPrompt(t)` | `src/main/sidecar-run-state.ts:156-160` agent_start | action (pool event) | any new run, user's or not, is told apart only by the ghost `userRun` | a prompt needs a ready omp (A5) |
| `EndRun(t,k)` | `sidecar-run-state.ts:165-166` agent_end sets `lastRun` | action | outcome = kind in {dns, net, transient, fatal}; the run may keep running (background work) | `last[t]` = outcome id |
| `Settle(t)` | `sidecar-run-state.ts:156-172` | action | the run stops running | |
| `UserStop(t)` | `src/main/sidecar-pool.ts:2218-2223` noteStopped | action | idempotent | enabled while a run runs or a probe row shows |
| `SessionChange(t)` | `sidecar-pool.ts:2238-2243` noteTouched | action | `sg` counts "session file or touched changed" | covers `switch_session`, fork, branch, `switch_leaf`, `new_session` |
| `Cancel(t)` | `turn-resume.ts:872-887` cancelWait / `#dropWait` | action | whole `#dropWait` in one step, then `sync()` | `pending`, `takenOverRuns` not modeled |
| `RetryTaken(t)` | `turn-resume.ts:769-774` the `retry` reply; `:693-696` | action | stock either starts a retried run (agent_start) or has nothing to retry | |
| `Unready`, `Boot` | `turn-resume.ts:378-398` `whenReady` | environment + continuation | `Boot` also runs every waiting `#run` continuation (`:760-774`) | A4 |
| `S_Watch` | `turn-resume.ts:654-664` `#watchScheduledRetry` | micro-step of `sync()` | | `ownRetries` = `own[t]` |
| `S_NewRun` | `turn-resume.ts:502-512` | micro-step of `sync()` | `fact.retry` and `#takenOverRuns` absent | `#dropWait` = `:878-887` |
| `S_Judge` | `turn-resume.ts:517-540`, `548-557`, `617-632`, `736-740` | micro-step of `sync()` | one of: wait already holds / not retryable / hold (offline) / probe (dns, online) / plan retry | `shouldWait()` = `!online` |
| `S_Marker` | `turn-resume.ts:470-476` `deriveMarkers` | micro-step of `sync()` | marker per tab: `network`, `running` or `none` | `#pending` (launch) not modeled |
| `VerifyThen(t,o,r)` | `turn-resume.ts:557-580` | action (promise continuation) | one pending continuation per `(tab, outcome)` | probe identity = outcome id |
| `PlanResume(t,o,gen,used)` | `turn-resume.ts:626-631`; `#arm` `:634-651` | action (continuation after `await #stockRetryOn`) | `retry.enabled` always true | `armId` is the identity of the armed object |
| `FireStart(t)`, `FireResume(t)` | `turn-resume.ts:675-697` `#fire`, `:681` the `await #stockRetryOn` between them | actions | the timer may fire at any time after arming | FireResume does not call `sync()` (F1) |
| `FlushStep` | `turn-resume.ts:743-754`, `:756-766` | micro-step of `flush()` | all held tabs at once; a ready omp sends `retry` in the same macrotask | A3 |
| `MProbeDone` | `connectivity.ts:127-146` `#check`, `#reachable` | action | one probe per host; result = `vLink0 AND (defOK OR hostOK)` | the two asks of `Promise.all` are sampled at one instant |
| `TimerFire`, `AttemptDone` | `connectivity.ts:159-176` `#attempt` | actions | the 2 s timer = `timer` flag | `report(true)` while recovering also starts `#attempt` (`ReportOnline`) |
| `ReportOnline`, `LinkDown` | `connectivity.ts:74-82`, `148-152` | actions | `report()` and `poll()` merged | |
| `DefDown/Up`, `HostDown/Up` | `connectivity.ts:140-146` (the probes) | environment | no code | |
| `pc`, `ct`, `rp` | (none) | control | a synchronous region as ordered micro-steps | see Granularity |
| `run, last, stopped, sg, awaiting, ready` | `ResumeFact` `turn-resume.ts:52-87` | variables | | `last[t]` is an outcome id, not the object |
| `waiting, probing, armO/armSg/armAtt, planning, cancels, attempts, own, judged, runWait` | `#waiting`, `#probing`, `#scheduled`, `#cancels`, `#attempts`, `#ownRetries`, `#judged`, `#run` generation (`turn-resume.ts:408-436`) | variables | | `#attempts` bounded at 2 |
| `online, recovering, probingM, timer, vN, vW, vRes` | `ConnectivityMonitor` fields `connectivity.ts:46-55` | variables | | `vN` counts in-flight probes |
| `store` | the marker file (`InterruptedTurnStore`) | variable | one marker per tab | |

## Assumptions

Each is a place a bug could hide.

- A1: every pool event that changes a fact (`agent_start`/`agent_end`, `noteStopped`, `noteTouched`) is followed by `TurnResume.sync()` before the next macrotask (`onRunningChange` in index.ts:1675). `setAwaitingConnection` itself does not call `sync()`.
- A2: `sync()` and `flush()` run in one macrotask: no IPC message, timer or event interleaves with them. Promise continuations whose awaited promise is already resolved are folded into the step that starts them.
- A3: with a ready sidecar `whenReady` resolves in a microtask, so `flush()`'s `#run` sends `retry` in the same macrotask as the flush. The RPC itself (`await command`) takes time and is not modeled.
- A4: `whenReady`'s listener resolves its promise in the status event handler, so its continuation runs before the next macrotask: `Boot` is atomic with it.
- A5: a run cannot be live on an omp that is not up: a prompt needs a ready omp and the omp does not go away while a run is live (`Unready` needs every tab idle).
- A6: one tab; `Tabs = {t1}` in every config. The monitor's probe sharing is checked with consecutive asks of the same tab, not two tabs.
- A7 (assumption, not code): the network eventually comes back (`ReportOnline`, `DefUp`, `HostUp` are strongly fair); each component's queued work eventually runs (strong fairness per component).
- A8: the host `retry.enabled` setting is on; the frozen `launch()` path, takeover and wake window are absent (SCOPE.md).

## Granularity

One model action = one macrotask, or one promise continuation that waited on I/O or a timer. `sync()` and `flush()` are regions the code runs without yielding: the model runs them as a fixed chain of micro-steps behind `pc`, which merges nothing the code performs separately.

Places where the model merges steps the code performs separately:

- `#judge`, `#watchScheduledRetry` and `deriveMarkers` run per fact in a `for` loop over all tabs; the model runs the chain for the one tab that changed. A fact for another tab does not change in the same `sync()`.
- `flush()` runs `#run` for every held tab in one `Promise.all`; the model handles all held tabs in one step.
- `Promise.all([ask(), ask(host)])` of `#reachable`: the model samples both answers at one instant.
- `#attempt`'s `isOnline()` check and the probe are sampled as `link at start` and `defOK/hostOK at end`.
- `#fire` between `FireStart` and `FireResume`: `await #stockRetryOn` is one step (the RPC's own duration is not split further).
