# Scope: update-job-gate

## The promise and the harm

The automatic update never quits the app while a background job runs in any omp: main's last look (`composer.freeze_jobs`) and its quit are one step, because the look also closes a gate on every new tool call, and every job starts from a tool call.
A job (a `task` subagent, a `bash` gone to the background) started in the second between a plain look and the install was cut by the restart and lost its work (2 Nov 2026). Tests rarely reach it: it needs a tool call to pass the gate after main's look and before the quit, across two processes, and the window is milliseconds long.

## Modeled (in scope)

Full map: `CORRESPONDENCE.md`.

- The omp's gate: `enter` (a call passes, or waits while closed), `leave`/`agentEnded`, `freeze` (closes only when no job runs and no call is under way, one synchronous step with the job-tree read), `thaw`, the lease expiring (`resources/gui-bridge/job-gate.ts:54-91`, `resources/gui-bridge/composer.ts:435-450,655-666`).
- A tool call under way registering a job (stock: `bash` to the background, `task`) and a job ending.
- Main's round: the freeze request to every omp, each answer arriving at its own step (in order per omp), a per-request timeout, the decision once every member answered or timed out, the thaw of every omp asked when the answers do not all show a freeze with no work, the hold at the tick, the install and the quit (`src/main/background-work.ts:262-300,332-374`, `src/main/app-auto-update.ts:215-241,291-304`, `src/main/updater.ts:845-873,939-940`).
- Bug variants as constants (`Legacy`, `RequireFrozen`, `CountStarting`, `LeaseOutlastsRound`).

## Abstracted

- Each omp's steps are atomic and single-threaded (one JS event loop each); an `await` between two statements is a step boundary, so `composer.freeze_jobs`'s tree read and the gate's decision are one step, and the thaw-wakeup of a held call is its own step (more interleavings than the microtask chain allows: a superset).
- Main's tick after the freeze answer lands (`.then(() => autoInstall?.tick())`) is one step with the decision: microtasks of one macrotask, no message or timer in between.
- Messages between main and an omp are reliable and in order (one RPC channel); a request may time out on main's side while the omp still handles it.
- The lease is a nondeterministic environment step with no clock; the model's assumption is that it does not fire between the first freeze of a round and the quit (`LeaseOutlastsRound`, see variant C).
- Jobs are a count; a job's own subagent tool calls are tool calls of the same gate and need no separate model, since nothing runs when the gate closes.

## Out of scope (a PASS says nothing about)

- Members that appear after main asked (a tab or hosted tab that becomes ready during the 3 s window): their omp has no gate closed and no answer; `members()` is read once per freeze (`background-work.ts:323`). A new omp that starts work during the window is not stopped. The window and the install are one tick away, and a new omp has no running job at birth; not modeled.
- `#safeToInstall`'s other holds (card, compaction, `resumes` off), the user's "나중에", `idle()` and the pref going off: all end in a thaw or a plain wait; only "main holds and thaws" is modeled (`DecideHold`).
- The relaunch continuing the cut turn, the installer itself, the quit guard.
- The remote host's own omps asked by the host's main over Tailscale: one main per computer; the model has one main.
- Message loss: a thaw request that never arrives leaves the gate to the lease (assumed 20 s, the bridge caps it at 25 s); not modeled, so `FrozenEventuallyThawed` is checked without fairness on the lease.
- Real time: the 20 s lease against the 3 s request timeout and the installer start (seconds on Windows) is an assumption, not a check.

## Properties

The frozen set is in `Properties.md`.

| Name | Kind | Source |
|---|---|---|
| `NoJobCutByQuit` | invariant | `resources/gui-bridge/job-gate.ts:1-9`, `src/main/app-auto-update.ts:9-15` |
| `FrozenEventuallyThawed` | liveness | `src/main/background-work.ts:279-283`, `job-gate.ts:6-8` |
| `HeldEventuallyRuns` | liveness | `resources/gui-bridge/job-gate.ts:6-8` |
| `NoRunningJobCutByQuit` | invariant (weaker, for the traces) | as `NoJobCutByQuit` |

## Bounds

| Run | Bounds | States, depth, time |
|---|---|---|
| fast (`MC.cfg`) | 2 omps, 1 tool call each, 1 job at a time each, 2 rounds | 149,573 distinct, depth 27, 11 s |
| liveness (`MC_live.cfg`) | same, weak fairness on the handlers and `Enter` | 149,573 distinct, depth 27, 108 s |
| deep, 2 calls | 2 omps, 2 calls each | 5,781,189 distinct, depth 31, about 240 s |
| deep, 3 omps | 3 omps, 1 call each, 1 round | 811,851 distinct, depth 24, 37 s |

The bugs show at 2 omps and 1 call each (traces of 9 to 11 steps); the larger runs check that the fixed protocol does not rely on the small bound.

## Tools and files

- Tool: TLA+ with TLC (interleavings of two processes and a lease; liveness for the thaw). Not Lean: no unbounded data.
- Files: `tla/UpdateJobGate.tla`, `tla/MC*.cfg`, `tla/matrix.json`, `tla/mutations.json`, `Properties.md`, `CORRESPONDENCE.md`, `evidence/`.
- Manifest id: `update-job-gate` in `formal/manifest.json`.
