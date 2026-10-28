# Frozen properties: the connection wait

Protocol-level: any correct implementation of "a failed turn waits for the connection and continues, never on top of the user" must hold them. They are defined next to the model in `tla/TurnResume.tla` (a TLA+ property needs the model's variables; see the skill gaps in `formal/findings.json`). Do not weaken or drop one without the user's explicit OK; a change is reported as a model change.

| Name | Kind | Statement | Source |
|---|---|---|---|
| `NoRetryIntoUserRun` | invariant | Stock `retry` is never sent while the tab's live run is one the user started (it has no outcome yet). | `turn-resume.ts:499-509` ("nothing retries into the live run once online"); `turn-resume.test.ts` "a prompt sent during the wait replaces it: the waiting row goes and nothing retries into the new run"; the assignment. |
| `NoRetryAfterCallOff` | invariant | Cancel, Stop, a new prompt, or a session/branch change that happens while a failure is probed or while its scheduled retry is armed never leads to a retry of that failure. | `turn-resume.ts:556-569` ("Cancel, a new run or another failure since: whoever ended this probe also cleared its row"; "Stop, a closed tab, or another session or branch on the tab since the failure: nothing to continue"); `TOUCH_COMMANDS` doc `:139-142`; `turn-resume.test.ts` "%s while the lookup is probed ends it". |
| `WaitEnds` | liveness | Whenever the wait row shows (`awaitingConnection`), it eventually goes, under the assumption that the network eventually comes back (`SCOPE.md`). | `connectivity.ts:1-13` ("holds the state at offline until a probe confirms the way out"); `turn-resume.ts:1-4`; `turn-resume.test.ts` "waits instead of failing, and the stock retry runs once the network is back". |
| `ProbeEnds` | liveness | A probe row (`#probing`) always ends: it answers and the tab holds or plans a retry, or someone ends it. | `turn-resume.ts:544-547` ("the tab shows the wait while the probe runs"). |
| `MarkerNetwork` | invariant | While a wait holds (`awaitingConnection`), the marker file says `network`, so a crash during the wait still retries. | `turn-resume.ts:572` ("The marker says `network` now, so a crash during the wait still retries"); `deriveMarkers` doc `:89-94`; `turn-resume.test.ts` "keeps a turn waiting for the connection, so a crash during the wait still resumes it". |
| `OneOfWaitOrScheduled` | invariant | A tab has at most one of: a held wait, a probe, a scheduled retry. | `turn-resume.ts:400-406` (`ArmedRetry`), `#mayRetry` `!fact.awaitingConnection`, `turn-resume.ts:528-529` ("no second schedule"); `turn-resume.test.ts` "leaves a network failure the connection wait holds to that wait (no second schedule)". |
| `OneProbePerHost` | invariant | At most one probe is in flight for the host; concurrent asks share it. | `connectivity.ts:109-115` ("One probe per host answers every concurrent ask"). |
| `OfflineOnlyOnNoAnswer` | invariant | The monitor goes offline through a probe only when neither the failed host nor the default way out answered (and the link was up). | `connectivity.ts:109-112` ("Unreachable only when neither the default way out nor `host` answers (a mistyped provider URL alone is not a lost connection)"). |
| `TypeOK` | invariant | Shape of the model's variables. Waived in the mutation set. | model |

## Added by the verifier (not one of the stated properties; reported separately)

| Name | Statement | Why added |
|---|---|---|
| `NoRetryAfterSessionChangeWhileHeld` | A session or branch change while a wait HOLDS (after the probe) never leads to a retry of the failed turn. | The probe checks the session and branch (`turn-resume.ts:568-569`) and the scheduled retry checks them (`#holds`), but the held wait does not; the same call-off rule would be expected. It fails on the current code (finding F4); whether the behavior is intended is a design question. |

Sanity (must FAIL, in `matrix.json`): `NeverWaits`, `NeverRetries`, `NeverArmed`, `NeverProbing`: each interesting state is reachable, so the properties above are not vacuous.

Bug toggles in the model (constants, not properties): `FireSyncs` (FALSE = the code as written; TRUE mirrors a proposed fix for F1: `#fire` calls `sync()` after `#hold`; not applied).

Model changes made after a counterexample (reported, not silent):
- F2 (refuted): the first run found `NoRetryIntoUserRun` violated through a user prompt on an omp that is not ready. A run cannot be live on an omp that is not up, and `whenReady`'s resolution is a microtask. The model was refined so a prompt needs a ready omp, `Unready` needs every tab idle, and `Boot` continues every waiting `#run` in the same macrotask. The property was not changed. Trace: `evidence/F2-refuted-retry-into-user-run.log`.
