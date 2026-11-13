# Check control

Design for the owner's review, 13 Nov 2026. Nothing here is built. P0 is already in flight as the workflow enforcement of agent `CiQueueStructure`; this page is everything after it. Pictures use fake data (made-up repos, `example.com`, the real theme tokens and shared components), English labels, both themes.

**One sentence.** Agents start, wait for, judge, retry and quarantine checks through one tool that sees every computer and GitHub runner as one pool. The person only watches, and is asked only when a decision is theirs.

## 1. Problem, in today's numbers

| Fact | Number | Source |
| --- | --- | --- |
| Concurrent macOS jobs this account may run | 5 (Free, Pro and Team alike; 50 on Enterprise), shared by standard and larger runners; Pro also caps all jobs at 40 | [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits) |
| macOS jobs queued by branch batch runs | 71, so main's own runs and the release waited hours. 71 ÷ 5 is at least 15 waves | commit `09175b6a6` message |
| One project's release check | 142 min (Playwright 115 min, 1 144 tests, one worker), from scratch three times | control-tools rule › Heavy slots, 13 Nov 2026 |
| Session polling of CI | polled ×508 and ×636 in two sessions | owner's session list |
| Cancelling overlapping runs | by hand | owner's report |

Three machines, each with its own heavy slots (`ompdesk heavy`), and a GitHub account with its own limits. Nothing connects them, and no session knows what another session already started.

## 2. Paid tools are the floor

What the paid tools show and do, what this does better and why only OMPdesk can, and what it skips. Competitor facts come from their own docs, linked in §12.

| Concern | Paid tools do | Better here, and why only OMPdesk can | Skipped |
| --- | --- | --- | --- |
| Capacity and queue | Buildkite queue page: agents in use, idle, paused, draining; jobs by state; wait p50, p95, p99; 15 s refresh; a 25-job sample per state | The same numbers, but one pool spans MacBook, Mac mini, Windows desktop and the GitHub macOS limit. Every job names the **session and goal** that started it, and the release gate it blocks. OMPdesk owns sessions, goals, heavy slots and the paired devices, so it knows what a runner dashboard cannot | Autoscaling agent fleets, agent tokens, p99 histograms (p50 and oldest wait first) |
| History and trends | CircleCI Insights: success rate, p50 and p95 duration, credits per workflow and job. Data may lag 24 h and is not billing-grade | The same series per **release gate and per goal** ("time to green for 0.9.2"), live, because our poller and check journals are the source | Org-wide dashboards, billing-grade accuracy (cost uses GitHub's billing report) |
| Flaky tests | Datadog: Active, Quarantined, Disabled, Fixed; policies by age, branch or failure rate; 20 retries to confirm a fix; AI root-cause categories; Jira items | `ompdesk check` already quarantines a test that passed and failed on the same input digest and clears it after 5 clean runs on other inputs. The agent that hits the failure is **told in the answer** whether it is known flaky, and which session quarantined it. No UI step | AI categories, code-owner routing, Jira, Slack mail |
| Merge queue | Trunk: predictive testing, batching (defaults 5 min wait, batch of 4), bisection with its own concurrency, parallel queues. GitHub merge queue runs checks on a `merge_group` event | Use GitHub's queue where the repo has one. We add what it lacks, the order. Release-bound branches first, batches grouped by goal, bisection that reuses results already known to fail. Agents enqueue and watch | Parallel queues from a build graph, optimistic merging |
| Test selection | Datadog Test Impact Analysis skips tests by coverage | Digest reuse by content, already shipped in `ompdesk check` (whole reuse, or rerun only what did not pass). Runner `--only-changed` flags stay untrusted | Coverage-based selection |
| Waiting | Webhooks, Slack, email, or poll the API | The session is **woken when the result arrives**, on the control socket's wait machinery. Zero polling. The person hears nothing unless a decision is theirs | Public API and webhooks (the tool and `ompdesk checks` are the API) |
| Cost | Credit and minute views | Runner minutes by OS next to **local placement** and **disk care**: a private repo runs on a free local Mac, a full disk blocks a start | SSO, RBAC, audit retention, SLA |

## 3. Data model

One deep module, `ChecksHub`, owns all of it. Its interface is three calls (`start`, `wait`, `status`) plus one read-only stream for screens (`watch`). Everything below is internal. Fact adapters sit at two real seams, GitHub (REST) and local (heavy slots and journals), each with a fake for tests.

```ts
type Os = "macos" | "windows" | "linux";
type Where = { kind: "device"; deviceId: DeviceId } | { kind: "github-hosted" } | { kind: "self-hosted"; runnerId: string };

/** Slot and capacity per OS and machine. One shape for a Mac's heavy slots and for GitHub's macOS limit. */
type Pool = { id: PoolId; os: Os; where: Where; limit: number; running: number; queued: number;
              oldestWaitMs: number; diskFreeGb?: number; asOf: Timestamp; state: "live" | "stale" | "offline" };

/** Who asked. Main-owned provenance, never read from text. */
type Origin = { kind: "session"; session: SavedSessionId; device: DeviceId; goal?: GoalId }
            | { kind: "person" } | { kind: "outside"; claimedName: string } | { kind: "foreign" };

type Lane = "release" | "land" | "branch" | "local";
type Run = { id: RunId; repo: RepoId; ref: string; sha: Sha; lane: Lane; trigger: "push" | "pull_request" | "merge_group" | "dispatch" | "local";
             origin: Origin; gate?: GateId; jobs: Job[]; verdict?: "green" | "red" | "cancelled";
             reusedFrom?: RunId; supersededBy?: RunId; digest: InputsDigest };
type Job = { id: JobId; os: Os; pool: PoolId; state: "held" | "queued" | "running" | "passed" | "failed" | "cancelled" | "reused";
             queuedAt: Timestamp; startedAt?: Timestamp; endedAt?: Timestamp; billedMin?: number };

/** A named set of jobs a release needs; progress is "6 of 10 gates green". */
type Gate = { id: GateId; release: ReleaseId; jobs: JobSelector; required: true };

type Policy = { id: string; scope: "global" | RepoId; when: Condition; action: "cancel-superseded" | "hold" | "reuse" | "place" | "batch" | "quarantine" | "rerun-failed";
                mode: "enforce" | "advise"; ownerOverride?: boolean };
type Decision = { policy: string; run: RunId; action: string; reason: string; at: Timestamp };   // the "Decided automatically" log

type QueueEntry = { id: string; repo: RepoId; base: string; pr: number; sha: Sha; lane: Lane; position: number;
                    batch?: BatchId; state: "waiting" | "testing" | "ready" | "landing" | "failed" | "removed" };

type TestResult = { test: TestId /* hash(repo, fqn) */; run: RunId; outcome: "pass" | "fail" | "skip"; durationMs: number; digest: InputsDigest; attempt: number };
type TestHistory = { test: TestId; p50Ms30d: number; state: "active" | "quarantined" | "cleared"; quarantinedBy?: Origin; cleanSince: number /* of 5 */ };

/** What an agent receives. Carries the judgment, so it never reads logs. */
type Answer = { verdict: "green" | "red" | "unknown"; asOf: Timestamp; counts: { passed: number; failed: number };
                failed: { test: string; firstError: string; knownFlaky: boolean; history: string }[];
                blocksRelease: { gate: GateId } | null; expectedWaitMin: number | null; reused?: { from: RunId; savedMin: number };
                next: "fix" | "rerun-failed" | "wait" | "land" | "ask-owner"; notes: string[] };
```

## 4. Where each fact comes from

| Fact | Source | How |
| --- | --- | --- |
| GitHub runs, jobs, queue depth | REST `actions/runs` and jobs, per repo | **One poller** (`GithubPoller`) in one place, the core process like the other new domains (native-rust ledger; open decision, §11). Conditional requests, back-off on `x-ratelimit-remaining`, spends at most about 2 000 of the 5 000 requests per hour ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). **Sessions never call GitHub for checks.** No webhooks, since a desktop app has no public address |
| GitHub limits (5 macOS, 40 total) | Plan documentation, cross-checked by the highest concurrency actually observed | The pool's `limit`. A repo variable can override it |
| Device slots and disk | `ompdesk heavy status --json` (`heavy.rs` pool and `Volumes`) on each computer, read over the paired link | One `Pool` per computer. A link loss shows `offline` and counts as zero capacity |
| Local runs, results, flaky state | `ompdesk check` journals in `<cache>/ompdesk/checks/runs/<id>/` and `flaky.rs` | Read by the hub, not re-run |
| Who started a run | AgentControl provenance (`openedBy`), Autopilot run and goal, the control-socket caller | Written into `Run.origin` at `start`. A run no session started is `person` or `foreign` and is shown, never governed |
| Release gates | The repo's release facts (AUTOPILOT.md) and the gate names in the workflow | `Gate` list per release |
| Runner minutes and cost | GitHub billing usage report ([REST](https://docs.github.com/en/rest/billing/usage)); [INFERENCE] the per-OS Actions SKU is there, to verify before P4 | Monthly, cached |

## 5. Policies

All are product behavior with no setting, like heavy slots. A policy only ever acts on what OMPdesk may govern (§9). Every action is written to the `Decision` log with its reason, and the answer to the affected agent says so.

| # | Owner's wish | Rule | Phase |
| --- | --- | --- | --- |
| 2 | Overlapping runs cancel themselves | One live run per repo, ref and workflow. A newer push to the same ref cancels the older one. Never a release, merge-group, other-ref or person-started run | P0 (workflow `concurrency`), P1 for runs outside workflows |
| 2 | Release-bound work first | Lane order is release, land, branch, local. A free macOS slot goes to the oldest release job, then the rest | P0 (repo variable), P2 in the hub |
| 2 | Wait when full | Admission is a queue **in OMPdesk**, per pool, FIFO within a lane. Jobs a pool cannot start stay `held` locally instead of queueing 71 at GitHub, so cancelling is free and no job hits GitHub's 24 h queue limit. Answers carry an expected start | P2 |
| 2 | Reuse a green result | Same commit, same workflow file hash, same inputs and tool digest as a green run starts nothing and returns `reused`. Reuse is never keyed on the sha alone | P0 (same-commit), P2 (digest) |
| 3 | Merge queue | Lane `land`. Release-bound branches batch (goal-grouped, target size from history), check in order and land when green. A red batch bisects, skipping combinations already known red. Where the repo has GitHub's merge queue, the batch is its `merge_group` run | P3 |
| 4 | Flaky tests | Quarantine a test that passed and failed on one digest. Rerun only failed jobs and tests. Clear after 5 clean runs on different inputs. Release gates still fail while a quarantined test failed in that run. Slowdown alert when a test runs over 1.3× its 30-day median in 3 runs in a row [proposal] | P4 |
| 5 | Local or runner | Private repo goes local first (free minutes), public goes to a runner. macOS-only work goes to a runner only when no local Mac has a slot. No start while a volume is under `min_free` (disk care owns cleanup). Spend past the runner budget the person set is escalated, §8 | P4 |

## 6. The agent tool

`ompdesk_checks`, with the CLI twin `ompdesk checks` for outside callers. Three operations replace every `gh run` poll.

| Operation | Input | Returns |
| --- | --- | --- |
| `start` | `purpose` (branch, release, land), `scope` (changed, full), optional `rerun: "failed"`, `repo`/`ref` default to the session's | `{ runId, decision: started \| reused \| held \| refused, placement, expectedStartMin, reason }` |
| `wait` | `runId`, `until` (result, any) | An `Answer`. The call ends when the result arrives. It is the control socket's server-side wait, not a loop, so it spends no turns |
| `status` | `scope` (mine, repo, all) | Pools and runs, cheap, so an agent can judge "is macOS full, should I start the release gate now" |

Rules the tool enforces so agents do not have to decide them. Placement and lane come from policy, never from the caller. A session can only cancel or rerun its own runs. `status` is served from the hub's cache and costs no GitHub request.

## 7. Acceptance: agents actually use it

A tool agents may ignore changes nothing. Five criteria, each with the part of the design that meets it, and the proof in 5.

| # | Criterion | How the design meets it |
| --- | --- | --- |
| 1 | **Only path.** Starting checks (`gh workflow run`, `gh run rerun`, a push that triggers them) goes through the tool. A run started outside it is refused by the workflow | The workflow's first job, `admit`, a 5-second Linux job, requires an admission ticket the tool supplies as a dispatch input or merge-group note. The ticket is an HMAC of repo, ref, sha and expiry. Its key is an Actions secret that is also in the OMPdesk keychain and never in a session's environment (agents cannot read secrets, control-tools rule). A hand-run macOS job fails at `admit` with "start it with ompdesk_checks". A plain push may still run cheap Linux jobs. Honest limit, §9. Until P2, P0's `-f mac=true` is the only gate |
| 2 | **Waiting by notification.** The session is woken when the result arrives. Zero polling | `wait` rides the control socket's server-side waits and lifecycle events (the machinery `ompdesk_session_result` already uses). The `check-runs` prompt section tells agents to call `wait` and never poll, and waste-guards' polling hint covers `gh run view` and `gh run watch` loops. The board row says "this session is woken when the result arrives" |
| 3 | **Answers that carry the judgment.** Green or red, failing test names with the first error line, known flaky or not, blocks a release gate or not, expected wait | The `Answer` type in §3. `knownFlaky` and `history` come from `TestHistory`, `blocksRelease` from `Gate`, `expectedWaitMin` from pool throughput. `verdict` is `unknown` when the poller is stale. It is never "green" from old data |
| 4 | **Policy decides** what runs where (local or runner, macOS or not) | `start` has no placement argument. Placement, lane and macOS use come from §5 and are reported back as `decision` and `reason`, so an agent follows the answer rather than arguing with it |
| 5 | **Proof.** Several sessions given the same task, before and after | Run one fixed task ("land these three branches and report green") in 4 sessions on `main` before P2 and again after. Compare per session and in total: runs started, peak macOS queue depth, polls (from the existing session pace counters), and **wrong green reports** (an agent said green while the gate was red or unknown, judged from the hub's journal). The page's "Are agents using it?" card keeps the live figures: runs started through the tool, refusals, polls, wrong greens |

## 8. What the person sees

Watching, not operating. Controls: **Pause admission** (new starts are refused with "paused by the owner"). Nothing else is a button.

| Surface | Content |
| --- | --- |
| Sidebar block (footer pin like Usage; draws nothing when no pool has work) | One slim gauge per pool that has work (GitHub macOS 5/5 with its queue, MacBook 2/3, Mac mini 1/1), one release-gate line. Built from `UsageGauges`, `Badge`, `ProgressBar`. A tap opens the page |
| Checks page (destination page, not one of the four side-panel views, since it has its own navigation) | Tabs **Now**, **Merge queue**, **Tests and cost**. Now shows pools by device, runner and OS; the release gates and what blocks them; runs by lane, each with **started by session and goal**; the last answer an agent received; the merge queue; the "Decided automatically" log. Tests and cost shows flaky tests and who quarantined them, slowdowns, queue depth, runner minutes, adoption figures |
| Work board | The existing check row becomes "Check · release gate · 18 min" with a note that the session wakes on the result. A tap opens the page on that run |
| Phone | The same block in the drawer, the same page in one column under phone density, tabs as a segmented control |
| Asking the person | Only when the decision is theirs, such as runner spend over budget, or two release-bound runs competing for one macOS slot. The hub sends it to the goal's session as mail and that agent asks through the normal ask card. No new attention kind |

Mockups (fake data, real tokens; the sidebar block is in every picture):

| View | Light | Dark |
| --- | --- | --- |
| Now (desktop) | [check-control-now-light.png](check-control-now-light.png) | [check-control-now-dark.png](check-control-now-dark.png) |
| Tests and cost (desktop) | [check-control-tests-light.png](check-control-tests-light.png) | [check-control-tests-dark.png](check-control-tests-dark.png) |
| Work board link | [check-control-board-light.png](check-control-board-light.png) | [check-control-board-dark.png](check-control-board-dark.png) |
| Phone, 390 px (drawer and page) | [check-control-phone-light.png](check-control-phone-light.png) | [check-control-phone-dark.png](check-control-phone-dark.png) |

![Checks, Now, light](check-control-now-light.png)

Parity at build time: `sidebar-checks` and `checks-page` surfaces for the parity sheet (ui-parity rule), one string key per label in `en` and `ko`.

## 9. What OMPdesk must never do

1. Cancel another repo's run, a run a person started, a release or merge-group run, or a run on another ref, except through a named policy, and then only a run that a newer run of the same repo, ref and workflow superseded. Foreign jobs that eat capacity (other repos, the same account) are shown and counted, never touched.
2. Spend GitHub API quota per session. One poller, a budget, stale-and-say-so when limited.
3. Report green from data older than the poll window. The answer says `unknown`.
4. Start heavy work onto a volume under `min_free`, or a macOS job while the owner paused admission.
5. Treat a quarantined failure as a pass for a release gate.
6. Auto-rerun without limit. Reruns cap per run, and the cap is in the answer.
7. Put the admission key in a session's environment or a log.

Honest limit of criterion 1. The ticket stops an honest bypass, not a person or program that can read the OMPdesk keychain.

## 10. Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| P0 | Workflow enforcement by `CiQueueStructure`. Concurrency groups, admission, release-first macOS through a repo variable, same-commit reuse. **Not part of this design's work, and it does not block release 1** | The 71-job queue cannot recur from branch runs |
| P1 | Read-only board. Poller, pools, runs, provenance, sidebar block, Checks page Now. No controls | The owner sees pools by device and runner, and who started each run |
| P2 | Agent tool. `start`, `wait`, `status`, `Answer`, admission ticket, wake on result, prompt section, Pause. A formal model of admission (FIFO, release first, no double admit, cancel only the superseded) comes first, per `ompdesk-formal-verify` | Acceptance 1 to 5 pass in the before and after trial |
| P3 | Merge queue. Lane `land`, batches, bisection, GitHub `merge_group` | A batch of release-bound branches lands in order with one run |
| P4 | Flaky and trends. Quarantine from GitHub runs, not only local checks, slowdowns, runner minutes, placement, disk-care link | Tests and cost tab matches the mockup |

## 11. Risks, and what a paid product has that we skip

- **Poller home.** The core process fits the native-rust direction, but `ompdesk checks` for a terminal with no OMPdesk running can only answer local pools. Decide before P1 [open].
- **Shared account limits.** The 5 macOS slots belong to the account. Other repos use them and we cannot govern them. The pool view must show them or its capacity is a lie.
- **API budget and secondary limits.** More repos raise the poll cost. Mitigation is conditional requests and per-repo cadence by activity [INFERENCE: confirm that a 304 is free of the primary limit before relying on it].
- **Reuse correctness.** A wrong key reports green for something never run. The key includes workflow file hash, inputs, tool digest and the base for a merge group.
- **Honest enforcement.** §9.
- **Merge queue availability.** GitHub's queue on private repos depends on plan [INFERENCE: verify]. Without it P3 batches through a branch OMPdesk owns.
- **Multi-machine truth.** A paired Mac mini that sleeps looks like zero capacity. It must read `offline`, not "empty".
- **Skipped from paid products.** SSO, RBAC, audit retention and SLA, org-wide and multi-tenant dashboards, autoscaling fleets, coverage-based test selection, AI root-cause categories, external webhooks, parallel merge queues from a build graph.

Rejected. Per-session `gh` polling with a shared cache (still N sessions on one quota, still turns spent). Webhooks (no public endpoint). A GitHub-only solution of concurrency groups (it cannot know goals, devices or disk). Packaging the whole thing as buttons for the person (the agents are the users).

## 12. References

Read this session. [Buildkite queue metrics](https://buildkite.com/docs/pipelines/insights/queue-metrics) and [changelog](https://buildkite.com/resources/changelog/432-see-whats-happening-across-your-agents-and-queues), [CircleCI Insights](https://circleci.com/docs/insights/), [Datadog flaky tests management](https://docs.datadoghq.com/tests/flaky_management) and [Test Health](https://docs.datadoghq.com/tests/test_health), [Trunk batching](https://docs.trunk.io/merge-queue/optimizations/batching), [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits), [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Seen as search results only. [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) (the `merge_group` event), [billing usage API](https://docs.github.com/en/rest/billing/usage). Vendor claims such as Trunk's "60 to 80 % less test time" are theirs and not used as numbers here.
