# Correspondence: update-job-gate

Sync commit: the `syncCommit` of `update-job-gate` in `formal/manifest.json` (the manifest wins if this file disagrees). The covered code was uncommitted when this model was written (stamped with `--allow-dirty`).

The `@code` tags in `tla/UpdateJobGate.tla` are the machine-checked half of this map.

## Map

| Model element | Code | Kind | Abstraction |
|---|---|---|---|
| `Enter(o, c)` | `job-gate.ts:54-57` `JobGate.enter`; `composer.ts:656-659` (`tool_call`) | action | the check `while (#closed)` and the `#underWay.set` are one step (no `await` between them once the gate is open) |
| `Block(o, c)` | `job-gate.ts:55` | action | a call that finds the gate closed waits; the wake-up is a later `Enter` (the model lets a freeze come in between, which the microtask chain would not: a superset) |
| `Register(o, c)` | stock's `bash` backgrounding, `task` spawn | action (no tag: not in this repo) | one job per step, at most `MaxJobs` per omp |
| `Leave(o, c)` | `job-gate.ts:60-67` `leave`, `agentEnded`; `composer.ts:660-665` | action | `agentEnded` (a failure skipped the end event) is the same transition: the call is no longer under way |
| `JobEnd(o)` | none | environment | a job finishes or is cancelled at any moment |
| `FreezeAt(o)` | `composer.ts:435-447` `composer.freeze_jobs`; `job-gate.ts:73-80` `JobGate.freeze`; `background-work.ts:354-369` `freezeMember` | action | tree read, `running`, `starting` and the gate decision are one step (`composer.ts:441` "No await from here on"); the reply carries `frozen`, `work` (a running job), `starting` (calls under way) |
| `ThawAt(o)` | `composer.ts:450`; `job-gate.ts:83-91` | action | the gate opens |
| `Expire(o)` | the lease timer, `job-gate.ts:78` | environment | no clock: it may fire whenever the gate is closed, except while main's round or the install is on (`LeaseOutlastsRound`) |
| `StartRound` | `app-auto-update.ts:302` `effects.verify`; `updater.ts:939`; `background-work.ts:262-275` `freeze()` | action | the members are fixed (all of `Omps`); one freeze round at a time |
| `Deliver(o)` | `background-work.ts:272-274` | action | answers of one omp arrive in order; an answer of an earlier round or after the timeout is dropped (its promise settled) |
| `Timeout(o)` | `background-work.ts:332-342` `requestInTime`, `366-368` | environment | the request's own timeout; the answer becomes unknown work (`Unknown`), not frozen; the omp may still freeze later |
| `AllClear` | `background-work.ts:278`; `app-auto-update.ts:301` | predicate | `stopped === asked.length && !hasBackgroundWork(work) && !work.starting`, with `RequireFrozen` the first conjunct |
| `DecideInstall` | `background-work.ts:285-287`; `app-auto-update.ts:215-241` | action | `#land` and the tick that `.then` calls are one step; `#safeToInstall` finds a fresh frozen answer and `effects.install()` runs |
| `DecidePartial` | `background-work.ts:279-283` | action | not all clear: every omp asked is thawed (the thaw requests are sent in the same step) |
| `DecideHold` | `app-auto-update.ts:294-299`; `background-work.ts:296-300` | action | all clear but the tick holds for another reason: `effects.thaw()` thaws every frozen omp |
| `Quit` | `updater.ts:845-873` `restartIntoUpdate` | action | the installer starts (seconds on Windows), then the app quits and every omp ends; modeled as a second step after `DecideInstall` so a step of an omp can come between |
| `gate`, `call`, `jobs` | `JobGate.#closed`, `#underWay`; the session's job tree | variables | `#underWay` as a state per call slot; the job tree as a count |
| `inbox`, `outbox` | the bridge's RPC channel | variables | in-order, reliable, each message handled once |
| `mstat`, `mans`, `rounds` | `freeze()`'s `asked`, `stopped`, `work`, `period` | variables | one round at a time; a stale answer of an earlier round is dropped |

## Assumptions (each a place a bug could hide)

- A1: an omp handles one request at a time, in order; `freeze_jobs`'s `await import` before the synchronous step does not let a later request overtake it (stock's RPC loop). If thaw and freeze could swap, a thaw of round 1 could open the gate round 2 closed; not checked.
- A2: **the lease outlasts the round and the install** (`LeaseOutlastsRound`): the lease (20 s, capped at 25 s) does not expire between an omp's freeze and the quit. The bound is the sum of main's request timeout (3 s, `BACKGROUND_WORK_REQUEST_TIMEOUT_MS`), the tick and the installer start (seconds on Windows). Variant C shows what happens when it does not; the model cannot check the numbers.
- A3: main's decision and the tick that follows it run with no other macrotask between (promise `.then` chain of `freeze()`); the `fresh` test of `#safeToInstall` (`app-auto-update.ts:293`) makes the decision use this round's answers, as the model's `rd` tag does.
- A4: the members are the omps alive when `freeze()` asked; none joins during the window (SCOPE.md).
- A5: a job starts only from a tool call that passed the gate (stock). A job started by another path (a timer, a hook) is not stopped by the gate.
- A6: a plain look reads the same job tree; `composer.jobs` (variant A) is `Legacy` with `RequireFrozen` off.

## Layered checks the model cannot tell apart

Main's `!hasBackgroundWork(work)` and `!work.starting` (`background-work.ts:278`) are second lines behind each omp's own decision (`job-gate.ts:75`): an omp answers `frozen` only when no job runs and no call is under way, so a mutation of main's work or starting test alone changes no behavior the properties see (the omp refuses first), and a mutation of the omp's test alone is caught only because the omp stops reporting `starting`, as in variant B. Main's `stopped === asked.length` is the one check that matters for an omp whose answer has no verdict (`Legacy`: an omp whose reply is rows only, `summarizeJobRows` reads a non-array as no work), which is `drop-the-all-frozen-check` in `mutations.json`. The first two are not listed as mutations for this reason: no property can fail on them.
