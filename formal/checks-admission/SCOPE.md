# Scope: checks-admission

## The promise and the harm

The hub's admission (`ChecksHub.start` and the pump behind it) never runs more jobs than a pool holds, admits each job once, gives a free place to the release job before a lower lane and to the earlier job within a lane, cancels only a run a newer run of the same repo, ref and workflow superseded, answers `reused` only from a green run of the same input digest, starts nothing while the owner paused it, and drops a held entry whose lease lapsed so it never blocks the line.

Broken, the account's 5 macOS runners queue 71 jobs again and main's release waits hours (design §1), a job runs twice, a person's or a release run is cancelled, or an agent is told green for inputs nothing tested. Tests rarely reach it: every one of these is an order of starts, pump runs, ends, lease lapses and outside jobs, and a unit test picks a few orders where the model checks all of them within its bounds.

## Modeled (in scope)

The model describes the approved contract against the evolving implementation. The action table in `CORRESPONDENCE.md` separates implemented steps from contract-only steps.

- `start`: refused while paused, `reused` from a finally judged green run of the same digest, else `held`; a held start supersedes older governed runs of its key that are neither release nor land runs.
- The pump reserves the first live entry with room. The intent is durable before the external dispatch.
- An exact accepted receipt binds the run. A definite refusal frees the place. An ambiguous answer or recovery of an in-flight durable intent leaves `Unconfirmed` occupying the place.
- A saved authoritative exact receipt can reconcile an unconfirmed intent on recovery. Without one, no modeled action reconciles it. No retry, elapsed time, or foreign run guess frees it.
- Raw completion frees capacity. Only a final Green answer on fresh matching facts without a release block enables reuse. Final Unknown and nonterminal Unconfirmed are distinct.
- A superseded run's place is free only once its exact bound run ends.
- Leases: a held entry's lease lapses (environment); the sweep removes it; a late heartbeat does not renew it.
- The owner's pause and resume.
- Jobs the hub does not govern (a person's run, another repo's on the same account, another program's heavy command) take places whenever one is free and are never touched.

## Abstracted

- **Pools**: one macOS pool and one other hosted pool under the account's one limit, and one computer's heavy pool. Several computers are several heavy pools that share nothing, so one stands for each.
- **Jobs, not runs**: a run of several jobs is several jobs with one key and one digest. Gate grouping is not modeled.
- **Keys and digests**: one group of jobs with one repo, ref and workflow (`SameKey`) and one group with one input digest (`SameDigest`); every other job has a key and a digest of its own.
- **Time**: no clock. A lease lapses at any moment while its entry waits; the sweep runs at some later moment.
- **The poller's view is exact for the hub's own jobs** (its ledger), and an outside job's place counts from the moment it starts. In the code the poller lags; see Assumption A3 in `CORRESPONDENCE.md`.
- **Each hub step is atomic** (A1, A2 in `CORRESPONDENCE.md`).
- **Recovery before the intent save** is not modeled. No external write can occur before that save; restoring the prior journal is a separate persistence concern.
- **Judgment facts** are abstract choices of fresh matching, stale, wrong SHA, or release blocked. The model checks which choices can become reusable, not the fact-fetching code.

## Out of scope

- The admission ticket and the workflow's `admit` job (§7 criterion 1): who may start, not when.
- `wait`, the full `Answer`, result delivery, flaky state, and the merge queue's batching and bisection (P3, P4).
- Placement (local or runner, §5 row 5) and disk care: the model takes a job's pool as given.
- GitHub's own `concurrency` groups (P0) and GitHub's 24 h queue limit.
- Poller outages and stale fact propagation. A stale final judgment is represented, but the poller's scheduling and recovery are not.
- Several hubs (two OMPdesk processes on one computer): one hub per account is assumed.

## Properties

The frozen set is `Properties.md`.

| Name | Kind | Source |
|---|---|---|
| `WithinPoolLimits` | invariant | brief; design §1, §4, §11 |
| `AdmittedOnce` | invariant | brief; design §10 |
| `HigherLaneFirst` | action | brief; design §5 |
| `FifoWithinLane` | action | brief; design §5 |
| `CancelsOnlySuperseded` | action | brief; design §5, §9.1 |
| `ReusesOnlyGreen` | action | brief; design §5, §11 |
| `PausedStartsNothing` | action | brief; design §8, §9.4 |
| `LapsedLeaseIsFinal` | action | brief; design §5 |
| `FirstInLineCanStart` | invariant | brief; design §5 |
| `ReleaseEventuallyAdmitted` | liveness | brief |
| `LapsedLeaves` | liveness | brief |
| `ReleaseKeepsItsAccountPlace` | invariant | Main's F1 decision (d6) |
| `UnconfirmedOccupies`, `RecoveryKeepsReservation` | invariant, action | Main's approved ambiguous-write contract |
| `GreenIsFinallyJudged` | invariant | Main's approved final-judge contract |

## Bounds

| Run | Bounds |
|---|---|
| `MC.cfg` | one heavy pool of 1 slot; a release job, two branch jobs, one outside job; pause and lapses on |
| `MC.cfg` + `DeviceLimit = 2` | the same with 2 slots |
| `MC_account.cfg` | macOS limit 1, account limit 2; a release macOS job, a land and a local Linux job, an outside macOS job and an outside Linux job; lapses on |
| `MC_account3.cfg` | account limit 3; release macOS, land Linux, an outside macOS job and two outside Linux jobs |
| `MC_account_two_release.cfg` | account limit 2; a release Linux job and a release macOS job, an outside macOS job and an outside Linux job |
| `MC_supersede.cfg` | hosted pool of 2; release, land, two branch jobs and an outside job, all one repo, ref and workflow; pause on |
| `MC_reuse.cfg` | hosted pool of 2; three branch jobs, two of one digest and two of one key |
| `MC_live.cfg`, `MC_live_account.cfg` | as `MC.cfg` (no pause) and `MC_account.cfg`, under `Fairness` and `NoForeverUnconfirmed`: the two liveness properties |
| `MC_live_supersede.cfg` | one heavy slot; release and two same-key branch jobs, under the same assumptions: P10 after a definite refusal following supersession |
| `MC_failure.cfg` | one slot; release and two same-key, same-digest branch entries; dispatch refusal, ambiguity, recovery, exact reconciliation, and final judgment |
| `MC_sanity_unconfirmed.cfg`, `MC_sanity_recovery.cfg` | one job; unconfirmed reservation and durable-intent recovery are each reachable |
| `MC_live_unconfirmed.cfg` | one slot; branch then release. Without `NoForeverUnconfirmed`, P10 must fail when the branch reservation is never observed |
| deep | one heavy pool of 2 slots, two release jobs, two branch jobs, one outside job |

The real limits (5 and 40) are larger. The properties compare counts with limits and order entries by lane and arrival. Prior evidence applies to the earlier model only. Updated-model run 43562545178 did not produce a passing matrix: `MC_supersede.cfg` and `MC_live.cfg` timed out at 600 seconds, and `MC_live_account.cfg` at 1,800 seconds. Mutation baselines that timed out establish no coverage. The next run raises those three matrix budgets and the mutation checker budget to 3,600 seconds. Actors, limits, properties and existing fairness assumptions are unchanged. No symmetry is used for these temporal checks; timeout remains not checked, never a pass.

## Finding F1 (design question, decided 14 Nov 2026): a release macOS job and the account's last places

**Corrected statement.** The first report of F1 (run 43494679727) said a release macOS job, waiting on macOS while lower-lane Linux jobs filled the account, "still cannot start when a macOS runner frees". That was wrong: every macOS job also counts in the account, so the run that ends frees a macOS place and an account place together, and the pump gives that place to the release job before anything behind it. What the old rule allowed is narrower: a lower-lane job takes the account's last place while the release job waits (the removed `KeepsLastAccountPlace` run showed only that), and then **a job the hub does not govern** (another repo's on the account, a person's) can take the place the ending macOS run frees before the hub's dispatch arrives. One outside job racing for that place is enough to block the release job.

**Owner's decision (Main, dispatch d6):** count a waiting release job against the account limit. A release entry whose own pool is full holds one account place; jobs behind it may not take it (`Holds`, `HeldAhead`, `Room`). With it, two outside jobs started after the release job arrived are needed to block it (one per place), and P12 says so. The old rule is the `no-account-hold` mutation, which P12 must catch on `MC_account.cfg` (one outside Linux racer). P9 is amended so a place a release entry ahead holds is not "free" for a job behind it (`Properties.md`). Strict head-of-line stays rejected (`strict-head-of-line` still breaks P9).

What no rule of the hub can do: keep outside jobs out. GitHub gives a freed place to whatever it has queued, and the account's other repos are shown and counted, never governed (design §9.1). The hold buys one place of slack per waiting release entry against them.

## Tools and files

- Tool: TLA+ with TLC: interleavings of starts, pump runs, ends, leases and outside jobs, plus liveness under stated fairness.
- Files: `tla/ChecksAdmission.tla`, `tla/MC*.cfg`, `tla/matrix.json`, `tla/mutations.json`, `Properties.md`, `CORRESPONDENCE.md`, `evidence/`.
- Manifest id: `checks-admission` in `formal/manifest.json`. Root owns the manifest and final source tag retarget.
