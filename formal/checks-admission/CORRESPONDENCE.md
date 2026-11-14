# Correspondence: ChecksAdmission.tla ↔ the hub's admission

This is the approved admission contract against an integrated source tree that is still changing. The model does not assert that every row is implemented or verified. Source ranges in `tla/ChecksAdmission.tla` must be retargeted after the root-owned source changes settle.

## Actions

| Action | Kind | Correspondence and boundary |
|---|---|---|
| `Start(j)` | code | `Admission::start` holds a new entry, refuses it while paused, or reuses a final green digest. It supersedes matching governed held, dispatching, or running branch entries. An unconfirmed entry is not superseded. |
| `Admit(j)` | code | `Admission::admit` selects a live entry under its lock and reserves a place before the dispatch await. The lock is not held across the await. |
| `PersistIntent(j)` | code | `Core::dispatch` calls `durable` before any external write. The journal contains admission and pending state. A save and an external write are separate steps. |
| `PersistReceipt(j)`, `Dispatched(j)` | code | The external source returns an exact run ID. `Core::dispatch` saves its binding before it binds the poller and reports accepted. A superseded known run stays cancelling. A crash can occur between saving the receipt and advancing admission. |
| `DispatchFails(j)` | code | A definite refusal ends a dispatching or cancelling entry and returns its place. A pre-write refusal also takes this path. |
| `DispatchUnconfirmed(j)` | code | An ambiguous write keeps the reservation as `Unconfirmed`. It is not a final Unknown answer and is never requeued. |
| `RecoverIntent(j)` | code | `Hub::build` restores admission and bindings. `Admission::recovered` converts an in-flight dispatch, including a cancelling one without a saved exact binding, to `Unconfirmed`. A cancelling entry with a saved binding retains its cancellation state. |
| `ReconcileReceipt(j)` | code | A saved authoritative exact binding reconciles an unconfirmed intent to its own run. It never guesses ownership from a nearby run, a workflow, a ref, or a clock. |
| `RunEnds(j)` | code | `Core::settle` frees capacity on raw completion. The model's facts state records whether the subsequent judgment has fresh matching facts and a release block. |
| `Judge(j)` | code | `Core::finish_with` gives `Admission::judged` Green only for a final Green answer with no release block. Stale and wrong-SHA facts resolve to final Unknown in the model. |
| `CancelLands(j)` | code | `Admission::cancel_landed` frees a superseded run's place only after its exact bound run ends. |
| `Reap(j)`, `Renew(j)` | code, mutation | The lease sweep removes lapsed held entries. `Renew` exists only for the late-heartbeat mutation. |
| `Pause`, `Resume` | code | Admission reads the owner's pause. Pause persistence is modeled as part of the control, not as a disk protocol. |
| `OutsideStarts(j)`, `Lapse(j)` | environment | External load takes an available place. Time can expire a held lease. |
| `Terminated` | model | All jobs are over. |

`sent` records a saved intent, not proof that the write reached GitHub. `launched` records a saved exact receipt, not a guessed foreign run. `checked` is ghost evidence that the final judge accepted fresh, matching, unblocked facts. `judging`, `stale`, `wrongsha`, and `blocked` are model states, not Rust enum variants. A crash after `PersistReceipt` can take `RecoverIntent` and then `ReconcileReceipt`. Without a saved exact receipt, no modeled action reconciles an unconfirmed intent. Recovery of an unsaved reservation before any external write is outside the restart transition modeled here.

## Lifecycle correspondence

The current hub checks `stop.cancelled()` in its pump, before a branch dispatch, and before granting or issuing a rerun. `durable` also stops on cancellation. Those checks are implementation fences, not a model action that assumes shutdown waits for every external effect. A stop after a write may leave an ambiguous durable intent, represented by `RecoverIntent`. This model does not prove process shutdown or result-delivery durability.

## Assumptions and limits

- **A1. One admission at a time.** `Start`, `Admit`, `Reap`, and `Pause` read and update the ledger under its lock.
- **A2. Durable before write.** The reservation is in the journal before any external dispatch or rerun. A failed save must not lead to an external write.
- **A3. Exact outside load.** The model counts external jobs at once. The real poller lags, and GitHub or the heavy pool supplies the actual capacity fence.
- **A4. Conditional liveness.** Pump and sweep progress and eventual completion of known runs are assumed. `NoForeverUnconfirmed` is a separate assumption for P10, not a guarantee that a receipt or refusal exists.
- **A5. Fixed inputs.** Lane, pool, key, and digest are fixed at start. The digest includes the requested commit and workflow inputs.
- **A6. Final judgment.** The abstraction admits Green only after fresh facts for the requested SHA and a final answer without a release block. It does not model the internal judge or artifact fetches.
