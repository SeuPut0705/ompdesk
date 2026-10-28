# Correspondence: turn-resume

Sync commit: `1cc0239708a810cbdc1683f5be194b968caaea87` plus the `syncDiff` of the uncommitted F1/F4 fixes (the commit at which this map was confirmed against the code; the same value as `syncCommit` of `turn-resume` in `formal/manifest.json`).

The `@code path:lines` tags in `tla/TurnResume.tla` are the machine-checked half of this map (`verify-all.ts` fails on a tag that does not resolve). This table records what each tag abstracts and the assumptions the model relies on.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `Launch(t)` | `turn-resume.ts:971-986` `launch()` finds the marker's tab; `:992-1004` offline `#hold` with the tab's session file and `touched` | action (once, before any run of this process) | the marker's continuation (restore or retry) is outcome id `LaunchO` = 0; only the offline case: an online launch's `#run` is out of scope | the launch marker stays in the file while held (A9) |
| `UserPrompt(t)` | `src/main/sidecar-run-state.ts:156-160` agent_start | action (pool event) | any new run, user's or not, is told apart only by the ghost `userRun` | a prompt needs a ready omp (A5) |
| `EndRun(t,k)` | `sidecar-run-state.ts:165-166` agent_end sets `lastRun` | action | outcome = kind in {dns, net, transient, fatal}; the run may keep running (background work) | `last[t]` = outcome id |
| `Settle(t)` | `sidecar-run-state.ts:156-172` | action | the run stops running | |
| `UserStop(t)` | `src/main/sidecar-pool.ts:2236-2241` noteStopped | action | idempotent | enabled while a run runs or a probe row shows |
| `SessionChange(t)` | `sidecar-pool.ts:2256-2261` noteTouched (ipc.ts and host-services.ts call it only for a move that worked: `movesTab`) | action | `sg` counts "session file or touched changed" | covers `switch_session`, fork, branch, `switch_leaf`, `new_session`; never `fork_from`, which leaves the tab on its session, so the model has no "touched, same session" step (A10) |
| `FileMoved(t)` | `sidecar-pool.ts:2060-2068` `#registerSessionFile`; `host-services.ts:1678-1683` the hosted `session` handler | environment | the tab's session moves and no `sync()` follows | the code now syncs on such a move while a wait holds; the model leaves that out so the continuations' own re-check is what it checks (A1) |
| `Cancel(t)` | `turn-resume.ts:922-936` cancelWait / `#dropWait` | action | whole `#dropWait` in one step, then `sync()` | `pending`, `takenOverRuns` not modeled |
| `RetryTaken(t)` | `turn-resume.ts:818-823` the `retry` reply; `:721-724` | action | stock either starts a retried run (agent_start) or has nothing to retry | |
| `Unready`, `Boot` | `turn-resume.ts:378-398` `whenReady` | environment + continuation | `Boot` also runs every waiting `#run` continuation, re-checking it with `Moved` (`:806-815`) | A4 |
| `S_Watch` | `turn-resume.ts:680-690` `#watchScheduledRetry` | micro-step of `sync()` | | `ownRetries` = `own[t]` |
| `S_NewRun` | `turn-resume.ts:523-538`; `#movedSince` `:776-779` | micro-step of `sync()` | `fact.retry` and `#takenOverRuns` absent; `Moved(t)` = `sg[t] > wsg[t]` (touched or the held session file changed; `sg` only grows) | `#dropWait` = `:927-936` |
| `S_Judge` | `turn-resume.ts:543-566`, `574-583`, `643-658`, `765-769` | micro-step of `sync()` | one of: wait already holds / not retryable / hold (offline) / probe (dns, online) / plan retry | `shouldWait()` = `!online`; the hold records `wsg` |
| `S_Marker` | `turn-resume.ts:491-497` `deriveMarkers` | micro-step of `sync()` | marker per tab: `network`, `running` or `none` | a held launch marker counts as `network` (A9) |
| `VerifyThen(t,o,r)` | `turn-resume.ts:583-606` | action (promise continuation) | one pending continuation per `(tab, outcome)` | probe identity = outcome id; the hold records the probe's `psg` |
| `PlanResume(t,o,gen,used)` | `turn-resume.ts:652-657`; `#arm` `:660-677` | action (continuation after `await #stockRetryOn`) | `retry.enabled` always true | `armId` is the identity of the armed object |
| `FireStart(t)`, `FireResume(t)` | `turn-resume.ts:701-725` `#fire`, `:707` the `await #stockRetryOn` between them | actions | the timer may fire at any time after arming | the offline hold records `armSg` and runs `sync()` (`:714-718`, F1's fix); online, `#run` carries the armed session (`wsg` = `armSg`, `:721`) |
| `FlushStep` | `turn-resume.ts:782-793`, `:795-805` | micro-step of `flush()` | all held tabs at once; a moved wait is dropped (`#run`'s first `#movedSince`), else a ready omp sends `retry` in the same macrotask (a launch's `restore` is the same send in the model) | A3 |
| `MProbeDone` | `connectivity.ts:127-146` `#check`, `#reachable` | action | one probe per host; result = `vLink0 AND (defOK OR hostOK)` | the two asks of `Promise.all` are sampled at one instant |
| `TimerFire`, `AttemptDone` | `connectivity.ts:159-176` `#attempt` | actions | the 2 s timer = `timer` flag | `report(true)` while recovering also starts `#attempt` (`ReportOnline`) |
| `ReportOnline`, `LinkDown` | `connectivity.ts:74-82`, `148-152` | actions | `report()` and `poll()` merged | |
| `DefDown/Up`, `HostDown/Up` | `connectivity.ts:140-146` (the probes) | environment | no code | |
| `pc`, `ct`, `rp` | (none) | control | a synchronous region as ordered micro-steps | see Granularity |
| `run, last, stopped, sg, awaiting, ready` | `ResumeFact` `turn-resume.ts:52-87` | variables | | `last[t]` is an outcome id, not the object |
| `waiting, waitFor, wsg, probing, armO/armSg/armAtt, planning, cancels, attempts, own, judged, runWait` | `#waiting` (`HeldWait`: action and `since`), `#probing`, `#scheduled`, `#cancels`, `#attempts`, `#ownRetries`, `#judged`, `#run` generation and `since` (`turn-resume.ts:400-448`, `:795`) | variables | `wsg` = the `since` of the tab's held wait or of its continuation on its way (session file and touched) as one counter | `#attempts` bounded at 2 |
| `launched` | `TurnResume.#launched` | variable | Launch happens at most once | kept with the history variables |
| `online, recovering, probingM, timer, vN, vW, vRes` | `ConnectivityMonitor` fields `connectivity.ts:46-55` | variables | | `vN` counts in-flight probes |
| `store` | the marker file (`InterruptedTurnStore`) | variable | one marker per tab | |

## Assumptions

Each is a place a bug could hide.

- A1: every pool event that changes a fact (`agent_start`/`agent_end`, `noteStopped`, `noteTouched`, a held tab's session file moving) is followed by `TurnResume.sync()` before the next macrotask (`onRunningChange` in index.ts). `setAwaitingConnection` itself does not call `sync()`. The one exception the model keeps on purpose is `FileMoved`: a move with no `sync()` (a path that forgets to tell the rules), which the continuations' re-check has to catch.
- A2: `sync()` and `flush()` run in one macrotask: no IPC message, timer or event interleaves with them. Promise continuations whose awaited promise is already resolved are folded into the step that starts them.
- A3: with a ready sidecar `whenReady` resolves in a microtask, so `flush()`'s `#run` sends `retry` in the same macrotask as the flush. The RPC itself (`await command`) takes time and is not modeled.
- A4: `whenReady`'s listener resolves its promise in the status event handler, so its continuation runs before the next macrotask: `Boot` is atomic with it.
- A5: a run cannot be live on an omp that is not up: a prompt needs a ready omp and the omp does not go away while a run is live (`Unready` needs every tab idle).
- A6: one tab; `Tabs = {t1}` in every config. The monitor's probe sharing is checked with consecutive asks of the same tab, not two tabs.
- A7 (assumption, not code): the network eventually comes back (`ReportOnline`, `DefUp`, `HostUp` are strongly fair); each component's queued work eventually runs (strong fairness per component).
- A8: the host `retry.enabled` setting is on; an online launch's continuation, the takeover and the wake window are absent (SCOPE.md).
- A9: a held launch marker is `store = "network"` in the model: the code keeps the launch marker itself (`#pending`, its reason unchanged, `sync()` writes it before the live ones), so a crash during the launch's wait continues it the same way; what `MarkerNetwork` asks ("a crash during the wait still continues") holds for it. A first launch is a fresh process: no run has started (`nStarts = 0`).
- A10: `touched` moves only with the tab's session or branch (`movesTab`: the command worked, was not cancelled, and is no `fork_from`), so `sg` growing is always a real change; a command that bumps `touched` but leaves the tab where it is would end a wait wrongly and has no model step.

## Granularity

One model action = one macrotask, or one promise continuation that waited on I/O or a timer. `sync()` and `flush()` are regions the code runs without yielding: the model runs them as a fixed chain of micro-steps behind `pc`, which merges nothing the code performs separately.

Places where the model merges steps the code performs separately:

- `#judge`, `#watchScheduledRetry` and `deriveMarkers` run per fact in a `for` loop over all tabs; the model runs the chain for the one tab that changed. A fact for another tab does not change in the same `sync()`.
- `flush()` runs `#run` for every held tab in one `Promise.all`; the model handles all held tabs in one step.
- `Promise.all([ask(), ask(host)])` of `#reachable`: the model samples both answers at one instant.
- `#attempt`'s `isOnline()` check and the probe are sampled as `link at start` and `defOK/hostOK at end`.
- `#fire` between `FireStart` and `FireResume`: `await #stockRetryOn` is one step (the RPC's own duration is not split further).
