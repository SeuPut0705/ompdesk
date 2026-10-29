# Correspondence: turn-resume

Sync commit: `0fe993fc83` (the commit at which this map was confirmed against the code; the same value as `syncCommit` of `turn-resume` in `formal/manifest.json`).

The `@code path:lines` tags in `tla/TurnResume.tla` are the machine-checked half of this map (`verify-all.ts` fails on a tag that does not resolve). This table records what each tag abstracts and the assumptions the model relies on.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `Launch(t)` | `turn-resume.ts:1012-1044` `launch()` finds the marker's tab; `:1046-1057` offline `#hold` with the tab's session file and `touched` | action (once, before any run of this process) | the marker's continuation (restore or retry) is outcome id `LaunchO` = 0; only the offline case: an online launch's `#run` is out of scope | the launch marker stays in the file while held (A9); Autopilot waits for `goalSettled` from then on (`apWait`) |
| `UserPrompt(t)` | `src/main/ipc.ts:778-783` `personsPrompt` then `SidecarPool.notePrompted` (a device's hosted tab and its view of a window tab: `host-services.ts:1957-1964`); `src/main/sidecar-run-state.ts:156-160` agent_start | action (pool event) | any new run, user's or not, is told apart only by the ghost `userRun`; the count `ResumeFact.prompted` is the flags `pk` (a continuation waiting for its omp or a move has seen it move) and `rk` (the launch's restore in flight has) | a prompt needs a ready omp (A5); enabled while a continuation is on its way (A11 closed) |
| `EndRun(t,k)` | `sidecar-run-state.ts:165-166` agent_end sets `lastRun` | action | outcome = kind in {dns, net, transient, fatal}; the run may keep running (background work) | `last[t]` = outcome id; waits for a continuation on its way (A13) |
| `Settle(t)` | `sidecar-run-state.ts:156-172` | action | the run stops running | |
| `UserStop(t)` | `src/main/sidecar-pool.ts:2241-2246` noteStopped | action | idempotent | enabled while a run runs or a probe row shows |
| `MoveSend(t,k)` | `turn-resume.ts:227-244` `trackMove` marks a `TOUCH_COMMANDS` command in flight (`MovesInFlight.begin`); its senders: `ipc.ts:968-979` (a window's tab), `host-services.ts:1956-1991` (a device's hosted tab; through a view the window tab's pool entry) | action (pool event, no `sync()`) | `k` = "moves": the answer will count (it worked and was not cancelled, or it timed out: `movesTabUnknown`); "stays": cancelled or failed | the command's send does not change `touched`; only `mv[t]` (A12) |
| `MoveReply(t)` | `sidecar-pool.ts:2261-2266` `noteTouched` (counted at the answer) then `sync()`; `trackMove`'s `end()` after it | action | a "moves" reply bumps `sg` and runs the `sync()` chain; either reply clears `mv[t]` and hands the continuation that waited for it (`runWait` with a ready omp) to `rg` | covers `switch_session`, fork, branch, `switch_leaf`, `new_session`; never `fork_from`, which leaves the tab on its session, so the model has no "touched, same session" step (A10) |
| `RunGo(t)` | `turn-resume.ts:830-861` `#run` after `whenReady` and `movesSettled`: the continuation looks again (`stale()` = `holdEnd("continuing")`) and sends its first command, or ends | action (microtask) | enabled only for a tab in `rg`, which nothing else interleaves with (A4); `go` = not called off (`cancels[t] = runWait[t]`), the tab did not move since the continuation's own `since` (`runSg`) and the person sent no prompt since it started (`~pk[t]`, `personTookOver`) | an aborted launch continuation tells Autopilot (`apWait`); a prompt ends only this continuation (no `#dropWait`), so `cancels` stays |
| `RestoreDone(t,c)` | `turn-resume.ts:896` `send("retry")` after `restore_interrupted` answered (also `:904`, `:915`); `:942-946` the run ends: `goalSettled` | action (promise continuation) | `c` = the restore went on with the turn: no second command; else the second command (modeled as stock `retry`) goes out only when `cancels[t]` and the tab's session are unchanged and no prompt of the person's came since the restore was sent (`restGen`, `rsg`, `~rk[t]`) | waits for a move in flight like every command (`~Moving(t)`) |
| `FileMoved(t)` | `sidecar-pool.ts:2064-2072` `#registerSessionFile`; `host-services.ts:1698-1703` the hosted `session` handler | environment | the tab's session moves and no `sync()` follows | the code now syncs on such a move while a wait holds; the model leaves that out so the continuations' own re-check is what it checks (A1) |
| `Cancel(t)` | `turn-resume.ts:968-990` cancelWait / `#dropWait` | action | whole `#dropWait` in one step, then `sync()`; a held launch continuation (`waiting`, `waitFor = LaunchO`) tells Autopilot `cancelled` (`apWait`); a restore in flight is called off by the generation (`cancels`) | `pending`, `takenOverRuns` not modeled; `#run`'s own call-off reports at its end, never twice |
| `RetryTaken(t)` | `turn-resume.ts:864-869` the `retry` reply; `:766-769` | action | stock either starts a retried run (agent_start) or has nothing to retry | |
| `Unready`, `Boot` | `turn-resume.ts:474-494` `whenReady` | environment + continuation | `Boot` hands every waiting `#run` that is not blocked by a move in flight to `rg`; `RunGo` runs it in the same macrotask, re-checking it (`:852-861`) | A4 |
| `S_Watch` | `turn-resume.ts:738-744` `#watchScheduledRetry` = `holdEnd("armed")` | micro-step of `sync()` | `Ends_armed(t, armO[t], armSg[t])`; `newUser` = `End_personsRun` (the chain's own reset) | `ownRetries` = `own[t]` |
| `S_NewRun` | `turn-resume.ts:601-606` = `holdEnd("wait")`, `holdEnd("probe")`; `turn-resume-ends.ts` `movedSince` | micro-step of `sync()` | `fact.retry` and `#takenOverRuns` absent; `End_moved(t, wsg[t])` = `sg[t] > wsg[t]` (touched or the held session file changed; `sg` only grows) | `#dropWait` = `turn-resume.ts:979-990` |
| `S_Judge` | `turn-resume.ts:611-634` (`#judge`'s outcome), `642-647` (`#verifyNetwork`), `702-717` (`#planRetry`), `810-814` (`#hold`) | micro-step of `sync()` | one of: wait already holds / not retryable / hold (offline) / probe (dns, online) / plan retry | `shouldWait()` = `!online`; the hold records `wsg` |
| `S_Marker` | `turn-resume.ts:572-577` `deriveMarkers` | micro-step of `sync()` | marker per tab: `network`, `running` or `none` | a held launch marker counts as `network` (A9) |
| `VerifyThen(t,o,r)` | `turn-resume.ts:647-663`; `holds` = `holdEnd("probeAnswer") === null` | action (promise continuation) | one pending continuation per `(tab, outcome)` | probe identity = outcome id; the hold records the probe's `psg` |
| `PlanResume(t,o,gen,used)` | `turn-resume.ts:711-716`; `#arm` `:719-736` | action (continuation after `await #stockRetryOn`) | `retry.enabled` always true | `armId` is the identity of the armed object |
| `FireStart(t)`, `FireResume(t)` | `turn-resume.ts:747-770` `#fire` (`stillHolds` = `holdEnd("firing") === null`), the `await #stockRetryOn` between them; `#fire` first waits for a move in flight (`await movesSettled`) | actions | the timer may fire at any time after arming; `FireStart` needs `~Moving(t)` | the offline hold records `armSg` and runs `sync()` (F1's fix); online, `#run` carries the armed session (`runSg` = `armSg`) and waits like any continuation if a move is in flight or the omp is not up |
| `FlushStep` | `turn-resume.ts:817-828` `flush()`, `:830-861` `#run` | micro-step of `flush()` | all held tabs at once; a moved wait is dropped (`#run`'s first `holdEnd("continuing")`), else with a ready omp and no move in flight the first command goes out in the same macrotask (a launch's is `restore_interrupted`: `restoring`), else the continuation waits (`runWait`, its `since` kept in `runSg`; `Boot` or `MoveReply` resumes it) | A3 |
| `MProbeDone` | `connectivity.ts:127-146` `#check`, `#reachable` | action | one probe per host; result = `vLink0 AND (defOK OR hostOK)` | the two asks of `Promise.all` are sampled at one instant |
| `TimerFire`, `AttemptDone` | `connectivity.ts:159-176` `#attempt` | actions | the 2 s timer = `timer` flag | `report(true)` while recovering also starts `#attempt` (`ReportOnline`) |
| `ReportOnline`, `LinkDown` | `connectivity.ts:74-82`, `148-152` | actions | `report()` and `poll()` merged | |
| `DefDown/Up`, `HostDown/Up` | `connectivity.ts:140-146` (the probes) | environment | no code | |
| `pc`, `ct`, `rp` | (none) | control | a synchronous region as ordered micro-steps | see Granularity |
| `run, last, stopped, sg, awaiting, ready` | `ResumeFact` `turn-resume.ts:56-96` | variables | | `last[t]` is an outcome id, not the object |
| `waiting, waitFor, wsg, probing, armO/armSg/armAtt, planning, cancels, attempts, own, judged, runWait` | `#waiting` (`HeldWait`: action and `since`), `#probing`, `#scheduled`, `#cancels`, `#attempts`, `#ownRetries`, `#judged`, `#run` generation and `since` (`turn-resume.ts:497-539`, `:840`) | variables | `wsg` = the `since` of the tab's held wait or of its continuation on its way (session file and touched) as one counter | `#attempts` bounded at 2 |
| `mv, rg, restoring, restGen, rsg, runSg, pk, rk, apWait` | `MovesInFlight` (`turn-resume.ts:192-213`), the continuations resuming in this macrotask, the launch's `restore_interrupted` in flight (`#run`'s generation and `since`), Autopilot's `#awaitingResume` (`autopilot.ts:1099-1100`, `resumeSettled`) | variables | `runSg` = the `since` a continuation on its way captured (session file and `touched`) as one counter; `pk`, `rk` = the person sent a prompt since the continuation / the restore started (`ResumeFact.prompted` against `#run`'s baseline); `apWait` = Autopilot waits for `goalSettled` | `bad7` is the ghost of `NoSendWhileMoveInFlight`, `bad8` of `NoSendAfterPersonsPrompt` |
| `launched` | `TurnResume.#launched` | variable | Launch happens at most once | kept with the history variables |
| `online, recovering, probingM, timer, vN, vW, vRes` | `ConnectivityMonitor` fields `connectivity.ts:46-55` | variables | | `vN` counts in-flight probes |
| `store` | the marker file (`InterruptedTurnStore`) | variable | one marker per tab | |

## End conditions

`src/main/turn-resume-ends.ts` holds every rule that ends a hold: `HOLD_ENDS` has one row per end condition and the places it is checked (`checks`); `HOLD_CHECKS` names, for each place the code looks, the model action that looks. `TurnResume` calls `holdEnd(check, since, fact)` at each of them and decides there only what the end does. The model mirrors it by name: row `x` is the operator `End_x`, check `y` is `Ends_y`, a disjunction of exactly the `End_` rows the table lists for `y`, and the action that looks at `y` uses `Ends_y` (`S_NewRun` uses `Ends_wait` and `Ends_probe`; `MayRetry` = `~Ends_armed` at the tab's own session). `turn-resume-ends.test.ts` compares the two sets exactly; the rows the model keeps constant are its fixed list `OUT_OF_MODEL` (`gone`, `frozen`, `fileWritten`), which may have no `End_` operator.

| Check (`HOLD_CHECKS`) | Code | Model action | Rows |
|---|---|---|---|
| `wait` | `#judge`, a held wait | `S_NewRun` (`Ends_wait`) | `personsRun`, `moved` |
| `probe` | `#judge`, a probe still out | `S_NewRun` (`Ends_probe`) | `personsRun`, `stopped` |
| `probeAnswer` | `#verifyNetwork`'s answer | `VerifyThen` (`Ends_probeAnswer`) | `gone`, `frozen`, `stopped`, `moved`, `fileWritten`, `otherOutcome` |
| `armed` | `#watchScheduledRetry`; may one be armed (`#mayRetry`: `S_Judge`, `PlanResume`) | `S_Watch` (`Ends_armed`; `MayRetry`) | `gone`, `frozen`, `personsRun`, `stopped`, `moved`, `otherOutcome`, `notRetryable` |
| `firing` | `#fire`'s `stillHolds` | `FireStart`, `FireResume` (`Ends_firing`) | the `armed` rows but `personsRun`, plus `busy` |
| `continuing` | `#run`'s `stale()` | `RunGo`, `RestoreDone`, `FlushStep` (`Ends_continuing`) | `moved` (ends every hold: `#dropWait`), `personsPrompt` (ends this continuation: `pk`, `rk`) |

Rows the model keeps constant, each a place a bug could hide: `gone` (tab close, SCOPE.md), `frozen` (the quit freeze, SCOPE.md), `fileWritten` (one file per session in the model; only the probe's answer counts a first file written after it), and the `peer`/`device`/no-file parts of `notRetryable`.

Known differences between checks, kept as the code had them and visible in the table: a move ends a held wait and a scheduled retry when `sync()` sees it, a probe only when it answers (`probe` lacks `moved`, `probeAnswer` has it); a first file written after a hold ends a probe at its answer and no held wait (`fileWritten`); Stop ends a probe and a scheduled retry and no held wait (a held wait's tab runs only stock's taken-over retry saga, out of scope).

## Assumptions

Each is a place a bug could hide.

- A1: every pool event that changes a fact (`agent_start`/`agent_end`, `noteStopped`, `noteTouched`, a held tab's session file moving) is followed by `TurnResume.sync()` before the next macrotask (`onRunningChange` in index.ts). `setAwaitingConnection` itself does not call `sync()`. The one exception the model keeps on purpose is `FileMoved`: a move with no `sync()` (a path that forgets to tell the rules), which the continuations' re-check has to catch.
- A2: `sync()` and `flush()` run in one macrotask: no IPC message, timer or event interleaves with them. Promise continuations whose awaited promise is already resolved are folded into the step that starts them.
- A3: with a ready sidecar `whenReady` resolves in a microtask, so `flush()`'s `#run` sends `retry` in the same macrotask as the flush. The RPC itself (`await command`) takes time and is not modeled.
- A4: `whenReady`'s listener resolves its promise in the status event handler, and `trackMove`'s `end()` resolves the movesSettled waiters, so their continuations run before the next macrotask: `Boot` and `MoveReply` hand them to `rg`, which only `RunGo` can leave and nothing interleaves with (`Idle` = no `pc` region and `rg = {}`). A `MoveReply` runs its `sync()` chain first, then the continuation, as the code does.
- A5: a run cannot be live on an omp that is not up: a prompt needs a ready omp and the omp does not go away while a run is live (`Unready` needs every tab idle).
- A6: one tab; `Tabs = {t1}` in every config. The monitor's probe sharing is checked with consecutive asks of the same tab, not two tabs.
- A7 (assumption, not code): the network eventually comes back (`ReportOnline`, `DefUp`, `HostUp` are strongly fair); each component's queued work eventually runs (strong fairness per component).
- A8: the host `retry.enabled` setting is on; an online launch's own start (`Launch` is offline-only: the online one is the same continuation `RunGo` runs after a flush, with the same `since`), the takeover and the wake window are absent (SCOPE.md).
- A9: a held launch marker is `store = "network"` in the model: the code keeps the launch marker itself (`#pending`, its reason unchanged, `sync()` writes it before the live ones), so a crash during the launch's wait continues it the same way; what `MarkerNetwork` asks ("a crash during the wait still continues") holds for it. A first launch is a fresh process: no run has started (`nStarts = 0`).
- A10: `touched` moves only with the tab's session or branch (`movesTab`: the command worked, was not cancelled, and is no `fork_from`), so `sg` growing is always a real change; a command that bumps `touched` but leaves the tab where it is would end a wait wrongly and has no model step.

- A11 (closed 29 Oct 2026): a prompt of the person's own while the launch's `restore_interrupted` runs (`restoring`) or a continuation waits for a move's answer or its omp (`runWait`) starts a run the continuation cannot tell from its own (`#judge` drops only a held wait or a probe). `SidecarPool.notePrompted` counts such prompts (`personsPrompt`; ipc.ts, a device's hosted tab and its view in host-services.ts); `#run` takes the count when it starts and, at every `stale()`, ends `cancelled` once it moved. `UserPrompt` is enabled in these windows; `NoSendAfterPersonsPrompt` checks it. The baseline is `#run`'s own start, not the hold's: a prompt during a held wait is `#judge`'s (the mutation `keep-held-wait-on-new-user-run` removes that).
- A12: a move command's send leaves `touched` (`sg`) alone; only its answer counts (`trackMove`), a timed-out command as a move (outcome unknown). Every continuation that looks at `touched` first waits for the moves in flight (`movesSettled`): `FireStart`, `FireResume`, `FlushStep`, `Boot`/`RunGo`, `RestoreDone` are disabled or deferred while `Moving(t)`.
- A13 (assumption, not code, unchecked): no second `#run` of a tab starts while one waits for its omp or a move, or its restore runs: `EndRun` needs `runWait[t] < 0` and `~restoring[t]`, so the person's run, whose failure would arm a scheduled retry, ends after the continuation. The code runs both; SCOPE.md.

## Granularity

One model action = one macrotask, or one promise continuation that waited on I/O or a timer. `sync()` and `flush()` are regions the code runs without yielding: the model runs them as a fixed chain of micro-steps behind `pc`, which merges nothing the code performs separately.

Places where the model merges steps the code performs separately:

- `#judge`, `#watchScheduledRetry` and `deriveMarkers` run per fact in a `for` loop over all tabs; the model runs the chain for the one tab that changed. A fact for another tab does not change in the same `sync()`.
- `flush()` runs `#run` for every held tab in one `Promise.all`; the model handles all held tabs in one step.
- `Promise.all([ask(), ask(host)])` of `#reachable`: the model samples both answers at one instant.
- `#attempt`'s `isOnline()` check and the probe are sampled as `link at start` and `defOK/hostOK at end`.
- `#fire` between `FireStart` and `FireResume`: `await #stockRetryOn` is one step (the RPC's own duration is not split further).
- `RunGo` and `FlushStep` handle all of one tab's continuation in one step: the code's several `await stale()` between its commands are microtask hops while no move is in flight, and a move in flight defers the whole continuation.
- `RestoreDone` stands for everything the launch sends after its restore (stock `retry`, the unwritten prompt, the goal resume): one second command, checked like `#run`'s `send`.
