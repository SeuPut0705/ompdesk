---
name: turn-resume-verify
description: "Checks that a turn which failed on the network still waits, probes and retries correctly (no retry into the user's run, Cancel or Stop or a session change ends a probe and a held wait, a wait always ends, the marker says network while a wait holds, one probe per host). Use when changing src/main/turn-resume.ts (sync, #judge, #verifyNetwork, #hold, #movedSince, flush, #run, #planRetry, #arm, #fire, cancelWait, #dropWait), src/main/connectivity.ts (verify, #check, #attempt, report), or when asked whether the connection wait or the scheduled retry can race."
---

# Connection wait verification

## The promise and the harm

A turn that ended in a network failure continues by itself once connectivity is back, and never on top of what the user did meanwhile: no `retry` is sent into a run the user started, Cancel, Stop, a new prompt or a session or branch change during the probe or while the wait holds never leads to a later retry, a held wait always ends, the marker file says `network` while a wait holds, a tab has at most one of wait, probe and scheduled retry, and one probe answers every concurrent ask for a host.

If it breaks, a retry runs in the middle of a turn the user started or after they gave up on it, a "waiting for the connection" row stays on screen forever, or a crash during the wait loses the turn that was supposed to continue.

## Coverage

| Check id | Tool | Covers (files and functions) | Model and tags |
|---|---|---|---|
| `turn-resume` | TLC 1.8.0 | `src/main/turn-resume.ts`: `TurnResume.sync`, `#judge`, `#watchScheduledRetry`, `#verifyNetwork`, `#hold`, `#ends`, `flush`, `#run` (its `stale()`: moves in flight, then `holdEnd("continuing")` and the generation), `#planRetry`, `#arm`, `#fire`, `#dropScheduled`, `#releaseScheduled`, `cancelWait`, `#dropWait`, `deriveMarkers`, `launch` (its offline wait), `movesTab`, `personsPrompt`; `src/main/turn-resume-ends.ts`: `HOLD_ENDS`, `HOLD_CHECKS`, `holdEnd`, `movedSince`, `personsRun` (every rule that ends a hold; the model's `End_*` and `Ends_*` operators); `src/main/connectivity.ts`: `ConnectivityMonitor.verify`, `#check`, `#reachable`, `#answers`, `#attempt`, `#armReprobe`, `#reprobe`, `report`, `#set`; `src/main/sidecar-run-state.ts`: `trackRunEvent`; `src/main/sidecar-pool.ts`: `noteStopped`, `noteTouched`, `notePrompted`, `setAwaitingConnection`, `#registerSessionFile`, `#unregisterSessionFile`; `src/main/remote/host-services.ts`: `#command` (a device's moves and prompts), the hosted `session` handler, `resumeFacts`; `src/main/ipc.ts`: the `touched` bump after a command, the `notePrompted` call | `formal/turn-resume/tla/TurnResume.tla`; tags `@code` on `Launch`, `UserPrompt`, `EndRun`, `Settle`, `UserStop`, `MoveSend`, `MoveReply`, `FileMoved`, `Cancel`, `RetryTaken`, `Boot`, `RunGo`, `RestoreDone`, `S_Watch`, `S_NewRun`, `S_Judge`, `S_Marker`, `VerifyThen`, `PlanResume`, `FireStart`, `FireResume`, `FlushStep`, `MProbeDone`, `TimerFire`, `AttemptDone`, `Reprobe`, `ReportOnline`, `LinkDown` |

Sync commit: `4206a49869` (plus the uncommitted covered edits it was stamped with, `syncDiff` in the manifest: a covered file another change has since committed shows as drift, which is the cue to look at the model again). This is the commit at which the verification was last confirmed to describe the covered code. It mirrors `syncCommit` of `turn-resume` in `formal/manifest.json`; if they differ, the manifest wins and this line is stale.

## Bounds and assumptions

- Bounds: 1 tab, 2 runs started, scheduled-retry attempts counted to 3 and kept there (the code has no limit), 1 network flap (the link may come back with or without its `online` event), 1 session change (through a synced command or a file move no sync sees), 1 Cancel, at most one relaunch; 8.8M states, depth 78 (fast tier, about 3.5 min for the main run). The deep run uses 2 flaps (56M states, about 17 min). Liveness: 1 run started, 1 attempt, 1 flap, no session change, no Cancel (strong fairness per component and the network eventually coming back as an assumption). A larger liveness run (2 runs, 158504 states, 308 s, before the F1/F4 fixes) is saved in `formal/turn-resume/evidence/TurnResume-MC_live_deep.log`.
- Assumptions (each is a place a bug could hide): every pool event that changes a fact is followed by `sync()`; `sync()` and `flush()` run in one macrotask; a ready sidecar resolves `whenReady` in a microtask; a run cannot be live on an omp that is not up; one tab; stock `retry.enabled` is on. The full table is `formal/turn-resume/CORRESPONDENCE.md`.
- Not covered: an online launch's continuation and the rest of the relaunch path past its offline wait, two continuations (`#run`s) of one tab at once (A13: the model ends the person's run after the continuation on its way), stock's auto-retry takeover, the wake window, hosted tabs, the quit freeze, tab close, the duration of the `retry` RPC, two tabs at once. `formal/turn-resume/SCOPE.md` lists them.

## Run it

`<tools-dir>` is the folder of the SKILL.md that you see when you read `skill://ompdesk-formal-verify`. In CI and on machines without OMPdesk, use a copy of that folder's `scripts/` and `assets/toolchain.json` (see `references/ci-and-drift.md` there).

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only turn-resume
```

It takes about 30 minutes with the deep run (matrix of 15 runs, 27 mutations, tag check, drift); `--tier fast` skips the deep ones. Read the result like this:
- `PASS`, exit 0: no counterexample within the bounds above. It does not mean the code is correct.
- `FAIL`, exit 1: a property was violated, a mutation was MISSED, or an `@code` tag no longer resolves. A violation prints a trace with one row per step: the action, its `@code` location and the variables that changed.
- `DRIFT:` note under the drift line: covered files differ from the sync commit, so the model needs another look (CI adds `--strict-drift` and fails on it). A sync commit that is not in this repository fails.
- `NOT CHECKED`, exit 3: the tool could not be prepared (for example offline). Report "not checked". Never report it as a pass.

## Does my change touch this?

It does when it changes `TurnResume` (`src/main/turn-resume.ts`), the end table (`src/main/turn-resume-ends.ts`: a new end condition is one row there and one `End_` operator in `TurnResume.tla`, used by the `Ends_` of each check it applies at; `turn-resume-ends.test.ts` fails on any difference), `ConnectivityMonitor` (`src/main/connectivity.ts`), what `ResumeFact` reads from the pool (`running`, `lastRun`, `stopped`, `touched`, `sessionFile`, `awaitingConnection` in `sidecar-pool.ts` `resumeFacts`, `noteStopped`, `noteTouched`, `setAwaitingConnection`; `sidecar-run-state.ts` `trackRunEvent`), or adds code that calls `setAwaitingConnection`, `network.verify`, `#hold`, `flush` or `cancelWait`. Search for them: `grep -rn "setAwaitingConnection\|network\.verify\|connectivityChanged\|cancelWait\|#hold(" src/main`. If it does, run the check; if the check or the covered code needs to change, go to "Updating the verification for an intended change".

## A failure: real bug or modeling error?

Replay the counterexample against the real code, step by step, using the `@code` location on each trace row. If a step cannot happen in the code, the verification is wrong: fix the verification and say what was wrong (F2 below is such a case). If every step can happen, it is a bug: tell the counterexample as steps in the code's own words, state the harm in one sentence, and report it; a failing test on the unchanged code is the proof (`src/main/turn-resume.test.ts`; F1 and F4 started as failing tests there and are now the block "TurnResume connection wait (formal/turn-resume)"). Never weaken the property or the model, add a state constraint or add fairness to make the check pass. If a change to the property is intended, say so as a model change and cite the evidence.

## Updating the verification for an intended change

1. Change the model from the code, before you rerun: each changed part must again point to code a reviewer can open (`@code` tags in `formal/turn-resume/tla/TurnResume.tla`, the table in `formal/turn-resume/CORRESPONDENCE.md`). One indivisible step in the code stays one step in the model; a new `await` splits a step.
2. Change a property only when the code's promise changed on purpose. Write down the old wording, the new wording and the evidence (doc comment, tests, changelog, commit message).
3. Keep the bounds unless the change makes them wrong. If you must reduce one, say so.
4. Update `formal/turn-resume/tla/mutations.json` so each new guard or step has a mutation that breaks it, and `matrix.json` when a finding is fixed (the run that expects the violation must flip to pass). Rerun. Then break the new code the way the property guards against and confirm the check catches it.

## Moving the sync commit

Move the sync commit forward only after you confirmed that the verification describes the code at the new commit. Commit the code and the verification change first, then run `bun <tools-dir>/scripts/verify-all.ts formal --only turn-resume --stamp`, and copy the new sha into the Coverage section above in the same change. Do not move it for a check that failed, was blocked or was UNAVAILABLE.

## Known findings

- F1 (fixed 28 Oct 2026): a scheduled retry that fired while offline handed over to the connection wait (`#fire` calls `#hold`) and never called `sync()`, so the marker file did not say `network` until some later event synced; a crash in that window dropped the retry. `#fire` now syncs after the hold. Property `MarkerNetwork`; test "a scheduled retry that fires while offline hands over to the connection wait, and the marker file says `network`"; the bug stays as the mutation `fire-hold-without-sync`. Introduced with the scheduled retry, commit 13d444d2d (16 Oct 2026).
- F4 (fixed 28 Oct 2026, the user's call: the same rule as the probe and the scheduled retry): a session or branch change while a wait held did not end the wait; once online, stock `retry` ran in the tab's new session. A held wait now records the session file and `touched` it holds for (`HeldWait.since`) and `#judge` ends it through `#movedSince`. Property `NoRetryAfterSessionChangeWhileHeld` (added by the verifier, now the rule); tests "%s while the connection wait holds ends the wait"; the bug stays as the mutation `held-wait-ignores-session-change`. The held wait (59ded67a7, 15 Oct 2026) never checked it. The relaunch's offline wait had the same gap (`launch()` recorded no session): fixed the same day, it holds with the tab's session file and `touched` (`Launch` in the model; test "a relaunch held offline for %s ends the wait"; mutation `launch-hold-records-no-session`).
- F2 (refuted, a model error): the first run reached `retry` into a user's run through a prompt on an omp that was not ready; the model allowed a run on an omp that is not up. Fixed in the model; see `formal/turn-resume/Properties.md`.
- A11 (closed 29 Oct 2026, left unchecked in v0.82.1): a person's prompt while a continuation waited for a move's answer or its omp, or while the launch's `restore_interrupted` ran, started a run `#run` could not tell from its own, and stock `retry` could land in it. `SidecarPool.notePrompted` counts the person's prompts (`ResumeFact.prompted`) and `#run` ends `cancelled` once the count moved since it started, without `#dropWait` (that would take the person's own run's wait). Property `NoSendAfterPersonsPrompt`; test "a person's prompt while a continuation is on its way"; the bug stays as the mutations `run-ignores-persons-prompt` and `restore-ignores-persons-prompt`.
