> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# TLA+ pattern catalog

Seven small, runnable specs live in `assets/patterns/<Name>/`. Each folder holds:

| File | Role |
|---|---|
| `<Name>.tla` | the spec, with a fix toggle and `\* @code path:lines note` tags (the paths are made-up examples: replace them) |
| `MC.cfg` | fix on: must pass |
| `MC_bug.cfg` | fix off: must fail on the named property |
| `MC_sanity.cfg` | a sanity invariant that must fail on purpose (the interesting states are reachable) |
| `matrix.json` | the three runs above as one command, with the expected outcome of each |
| `mutations.json` | one mutation per property (`TypeOK` waived with a reason), checked by `mutate.ts` (`mutations.md`) |

Run a whole pattern (`<skill-dir>` is the folder that holds `SKILL.md`):

```
bun <skill-dir>/scripts/tlc.ts <skill-dir>/assets/patterns/LostUpdate/LostUpdate.tla --matrix <skill-dir>/assets/patterns/LostUpdate/matrix.json
```

and the mutations of a pattern:

```
bun <skill-dir>/scripts/mutate.ts <skill-dir>/assets/patterns/LostUpdate/LostUpdate.tla <skill-dir>/assets/patterns/LostUpdate/mutations.json
```

The samples' `@code` paths do not exist, so `tlc.ts` prints one `WARN @code ...` line per tag. That is expected here;
in your model it means a tag points at a file or line range that is gone.

For the matrix, exit 0 means every run met its expectation, including the runs that must fail. Output and flags: `tlc-cli.md`.
CacheAside also has `TraceCacheAside.tla`, `Trace.cfg` and two logs for trace validation (`trace-validation.md`).

To use one: copy the folder into `formal/<concern>/tla/`, rename the module (file name = module name),
replace the `@code` tags with real code locations, and adapt it. Keep the three-config structure and the matrix.
It is what proves the final model can still fail. Real use goes through the workflows in `workflows.md`.

| Code shape | Pattern |
|---|---|
| read-modify-write, counters, check-then-act, locks | `LostUpdate` |
| async/await, cache-aside, fill vs. invalidate | `CacheAside` (+ trace validation harness) |
| retries, webhooks, at-least-once delivery, dedup tables | `IdempotentRetry` |
| leases, job claiming, leader leases, GC pauses, fencing tokens | `JobLease` (worked example: `examples/job-lease/`) |
| streams, queues, batching, backpressure, end-of-stream | `BatchPipeline` |
| DAG executors, build systems, workflow engines, graph invariants | `DagScheduler` |
| persisted status fields, order/payment/ticket lifecycles | `OrderStateMachine` |

What each pattern's configs check (the bug property is the one that must be reported violated in
`MC_bug.cfg`; `kind` is what `matrix.json` expects):

| Pattern | Bug property (`MC_bug.cfg`) | kind | Sanity (`MC_sanity.cfg`) |
|---|---|---|---|
| LostUpdate | `NoLostUpdate` | invariant | `NeverAllDone` |
| CacheAside | `NoStaleAtRest` | invariant | `NeverFilledAfterWrite` |
| IdempotentRetry | `AtMostOnce` | invariant | `NobodySkips` |
| JobLease | `SingleCommit` | invariant | `NoReclaim` |
| BatchPipeline | `AllDelivered` | temporal (liveness only) | `NeverCloses` |
| DagScheduler | `DepsRespected` | invariant | `NeverRunsDependent` |
| OrderStateMachine | `ValidTransitions` | action property | `NeverCancelled` |

---

## LostUpdate — read-modify-write and check-then-act

**Finds:** increments that are lost, "check balance then debit", "if not exists then insert",
and any code that reads shared state, computes, then writes it back.
**Shape:** per-thread `pc` with `start → read → write → done`, and a thread-local `tmp`.
**Fix toggle:** `UseLock`. The same skeleton covers:
- **CAS loops:** a `Write` guard `counter = tmp[t]`, plus a retry path back to `read`.
- **DB isolation:** model each SQL statement as an action. Under READ COMMITTED, a
  `SELECT` followed by an `UPDATE` is two actions.
- **Lock ordering / deadlock:** two locks and two threads that acquire them in opposite
  orders. Leave deadlock checking on; TLC reports a deadlock with the cycle.

## CacheAside — async/await interleaving

**Finds:**
- stale caches after concurrent fill and invalidate,
- read-your-writes violations,
- "delete then set" races, and
- double-checked initialization in async code.

**Shape:** each action is one await-free block. Readers: `RMiss` (read DB) then `RFill`
(write cache). Writer: `WWrite` (DB) then `WInval` (cache).
**Property:** `NoStaleAtRest`, guarded by `Quiescent`. Coherence may lapse mid-flight;
that alone is not the bug.
**Fix toggle:** `UseLease`, with memcache-style lease tokens (the invalidation bumps a
generation, and a stale fill is dropped). Other fixes to model the same way:
- a versioned value with compare-and-set on the fill,
- delayed double delete,
- write-through with a version check.

**Also here:** `TraceCacheAside.tla`, a trace-validation harness (see `trace-validation.md`).

## IdempotentRetry — at-least-once delivery

**Finds:** duplicate side effects from client retries, broker redelivery, webhook replays, or
two workers handling the same message. The core issue is "check the dedup table, do the side
effect, then write the dedup entry" across awaits.
**Shape:** `Deliveries` = copies of one logical request, handled concurrently.
**Fix toggle:** `ClaimFirst` claims the key atomically *before* the side effect
(`INSERT … ON CONFLICT DO NOTHING`, `SETNX`, a conditional put).
**Extend:** add a `Crash(d)` action between claim and apply to see the price of claim-first:
at-most-once, which becomes a lost request. Then model the real remedies:
- an outbox,
- a transactional claim plus effect, or
- a status column (`claimed → applied`) with recovery.

## JobLease — leases, expiry, fencing

**Finds:**
- double execution when a lease expires under a slow or paused holder,
- split-brain leaders, and
- stale writers after failover.

**Shape:** `Expire` is an environment action (time passes or the process pauses) that can
fire at any moment. `Claim` requires `owner = None \/ expired`.
**Fix toggle:** `UseFencing`. The commit is a compare-and-set on the claim token, and
stale holders abort.
**Liveness:** `(owner # None) ~> jobDone`, under weak fairness on `Commit` and `Abort` only
(never on `Expire`).
**Extend:** add lease renewal (`Renew(w)`), and more workers or claims (`MaxClaims`).
`examples/job-lease/` is a complete worked example built on this pattern, with a code correspondence and mutations.

## BatchPipeline — dataflow and streams

**Finds:**
- the last partial batch lost at end-of-stream,
- items lost or duplicated across stages,
- reordering,
- unbounded buffering (backpressure bugs), and
- stalls.

**Shape:** a producer feeds a bounded queue, a batcher reads it, and a sink receives
batches. `Flat` flattens the output.
**Properties:**
- `Backpressure` (queue ≤ Cap),
- `NoLossDupReorder` (everything seen so far is a prefix of the input), and
- `AllDelivered` (liveness).

**Lesson:** the end-of-stream bug (`FlushOnEos = FALSE`) violates *no* safety property. Only the liveness
property catches it, so `matrix.json` expects `temporal` there. Always pair "nothing bad" with "something
good eventually".
**Extend:**
- more stages,
- fan-out / fan-in (then check the output is a permutation of the input),
- a retrying sink (then check for duplicates), and
- cancellation.

## DagScheduler — graphs, checked across all small graphs

**Finds:**
- tasks dispatched before their dependencies finish,
- tasks run twice,
- a stuck scheduler when a worker fails, and
- cycle-detection bugs.

**Shape:** `Init` picks *any* acyclic edge set on `Nodes`, so one run checks every DAG on that node set
(25 on 3 nodes, 543 on 4). `Reach` and `Acyclic` are recursive operators you can reuse
for any graph property.
**Fix toggle:** `ReadyWhenDone`. The bug is readiness computed from "started" rather than
"finished".
**Extend:**
- task failure with retries,
- cancellation propagating downstream,
- dynamic edge insertion (check `Acyclic(E)` as an invariant to catch check-then-insert
  races on the graph itself), and
- a mark phase for GC/reachability (`marked \subseteq Reach(E, roots)` during the run, with
  equality at the end).

When the scheduling algorithm itself must hold for graphs of any size, prove it in Lean and keep this model for the
protocol around it (`choosing-tools.md`, "Combining them").

## OrderStateMachine — persisted lifecycles

**Finds:** illegal transitions (for example `paid → cancelled`) from handlers that read the
status, decide, then write.
**Shape:** a status enum, an `Allowed` edge set, and concurrent handlers.
**Property:** an action property, `[][status' # status => <<status, status'>> \in Allowed]_vars`.
TLC reports a violation of an action property as a temporal-property violation, and `matrix.json` expects `action`.
**Fix toggle:** `UseCAS` (`UPDATE … WHERE status = 'pending'`).
**Extend:** several entities (a function from ids to status), timers (auto-expire pending),
and outbound side effects per transition (email, refund) with at-least-once delivery. For UI or session
lifecycles, a statechart can generate the transition table (`statechart.md`).

---

## Measured state counts

Measured with `tlc.ts` (TLC 1.8.0) on the shipped configs, one worker. The `MC.cfg` runs are exhaustive for
the stated bounds and the counts are stable. The bug and sanity runs stop at their first counterexample, so
their counts are where TLC happened to stop and can differ by a few states from run to run (they are not listed).

| Pattern | Bounds in `MC.cfg` | Distinct states | Generated | Depth | Checked |
|---|---|---|---|---|---|
| LostUpdate | 2 threads, `UseLock` | 13 | 15 | 7 | `TypeOK`, `NoLostUpdate`, `MutEx`, `AllFinish` |
| CacheAside | 2 readers, `UseLease` | 85 | 127 | 7 | `TypeOK`, `NoStaleAtRest` |
| IdempotentRetry | 2 deliveries, `ClaimFirst` | 13 | 19 | 5 | `TypeOK`, `AtMostOnce`, `EventuallyApplied` |
| JobLease | 2 workers, `MaxClaims = 3`, `UseFencing` | 25 | 43 | 7 | `TypeOK`, `SingleCommit`, `ClaimedEventuallyDone` |
| BatchPipeline | `N = 5`, `Cap = 2`, `BatchSize = 2`, `FlushOnEos` | 25 | 35 | 15 | `Backpressure`, `NoLossDupReorder`, `AllDelivered` |
| DagScheduler | 3 nodes (25 DAGs), 2 workers, `ReadyWhenDone` | 266 | 386 | 7 | `TypeOK`, `DepsRespected`, `RunsOnce`, `AllComplete` |
| OrderStateMachine | `UseCAS` | 15 | 20 | 5 | `TypeOK`, `ValidTransitions` |

`DagScheduler` with 4 nodes (543 DAGs, set `"constants": {"Nodes": "{1, 2, 3, 4}"}` in a matrix run) explores 8,414
distinct states (12,734 generated, depth 9) in about a second. A passing run says only that no counterexample
exists within these bounds.

## Building a new model from scratch

1. List the actors and their per-actor program counters (one value per atomic region).
2. List the shared variables with small domains. Write `TypeOK` first.
3. Write one action per atomic region, with an `@code` tag and every variable either primed or `UNCHANGED`.
4. Write the environment actions: crash, timeout, drop, duplicate, reorder, pause (no `@code` tag).
5. Write the invariants and action properties, then liveness with justified fairness.
6. Write the sanity invariant and a bug toggle.
7. Write three configs and a `matrix.json` for them. Run `tlc.ts Spec.tla --sany-only`, then the matrix at the
   smallest bounds.
8. Write `mutations.json`, one mutation per property, and run `mutate.ts` (`mutations.md`).
