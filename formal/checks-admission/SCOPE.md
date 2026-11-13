# Scope: checks-admission

## The promise and the harm

The hub's admission (`ChecksHub.start` and the pump behind it) never runs more jobs than a pool holds, admits each job once, gives a free place to the release job before a lower lane and to the earlier job within a lane, cancels only a run a newer run of the same repo, ref and workflow superseded, answers `reused` only from a green run of the same input digest, starts nothing while the owner paused it, and drops a held entry whose lease lapsed so it never blocks the line.

Broken, the account's 5 macOS runners queue 71 jobs again and main's release waits hours (design §1), a job runs twice, a person's or a release run is cancelled, or an agent is told green for inputs nothing tested. Tests rarely reach it: every one of these is an order of starts, pump runs, ends, lease lapses and outside jobs, and a unit test picks a few orders where the model checks all of them within its bounds.

## Modeled (in scope)

Design model (workflow W3): the code is not written yet. The action table in `CORRESPONDENCE.md` names the hub step each action stands for, for `native/ompdesk/crates/core/src/checks/admission.rs` to tag.

- `start`: refused while paused, `reused` from a green run of the same digest, else `held`; a held start supersedes the older governed runs of its key that are neither release nor land runs.
- The pump: the first live entry in line (lane, then arrival) that has a place takes it, counted in the hub's own ledger before the dispatch is sent.
- The dispatch's answer: accepted, or failed and never retried in place.
- A run's end as the poller sees it; a superseded run's place is free only once GitHub shows it ended.
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

## Out of scope

- The admission ticket and the workflow's `admit` job (§7 criterion 1): who may start, not when.
- `wait` and the `Answer`, results, flaky state, the merge queue's batching and bisection (P3, P4).
- Placement (local or runner, §5 row 5) and disk care: the model takes a job's pool as given.
- GitHub's own `concurrency` groups (P0) and GitHub's 24 h queue limit.
- A poller that is stale or down: no `verdict` is modeled.
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

## Bounds

| Run | Bounds |
|---|---|
| `MC.cfg` | one heavy pool of 1 slot; a release job, two branch jobs, one outside job; pause and lapses on |
| `MC.cfg` + `DeviceLimit = 2` | the same with 2 slots |
| `MC_account.cfg` | macOS limit 1, account limit 2; a release macOS job, a land and a local Linux job, an outside macOS job; lapses on |
| `MC_supersede.cfg` | hosted pool of 2; release, land, two branch jobs and an outside job, all one repo, ref and workflow; pause on |
| `MC_reuse.cfg` | hosted pool of 2; three branch jobs, two of one digest and two of one key |
| `MC_live.cfg` | as `MC.cfg`, no pause, under `Fairness`: the two liveness properties |
| deep | one heavy pool of 2 slots, two release jobs, two branch jobs, one outside job |

The real limits (5 and 40) are larger. The properties compare counts with limits and order entries by lane and arrival; nothing in them depends on the limit's size beyond "full" and "not full", which a limit of 1 or 2 reaches. States, depth and times are in `evidence/` and in the report.

## Finding F1 (design question, not a code bug): a lower lane can take the account's last place

`KeepsLastAccountPlace` must fail, and does (`MC_limit_KeepsLastAccountPlace.cfg`). A release macOS job waits for a macOS runner. Meanwhile a land or branch Linux job, admitted after the release job arrived, takes the account's last hosted place (40 of 40). When a macOS runner frees, the release job still cannot start: the account is full of lower-lane jobs. The design's rule (§5: a free place goes to the first entry that can use it) cannot prevent this, because when the Linux job was admitted no rule was broken: the release job could not use any free place then.

Strict head-of-line (no job passes an earlier higher-lane job) would fix it and break P9: a release macOS job waiting for macOS would keep every Linux job out of 35 free places (`strict-head-of-line` mutation). Choices for the owner: (a) accept it (the account limit of 40 is far from today's use; the 5-macOS limit is what queued 71 jobs), (b) reserve the account's last N places for release jobs while one waits, (c) count a waiting release macOS job against the account. The model takes (a) and documents it; (b) or (c) is a frozen-property change to `HigherLaneFirst`/`FirstInLineCanStart`, with a new run.

## Tools and files

- Tool: TLA+ with TLC: interleavings of starts, pump runs, ends, leases and outside jobs, plus liveness under stated fairness.
- Files: `tla/ChecksAdmission.tla`, `tla/MC*.cfg`, `tla/matrix.json`, `tla/mutations.json`, `Properties.md`, `CORRESPONDENCE.md`, `evidence/`.
- Manifest id: `checks-admission` in `formal/manifest.json`; `covers` is empty until `admission.rs` lands, then it names that file and the `@code` tags go on each action.
