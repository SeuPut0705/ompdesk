# Correspondence to SessionDeleteFences

This document states the obligations for a forward safety simulation. They have not been mechanically proved or model checked. The reference is `../session-delete-fences/tla/SessionDeleteFences.tla`, including its five frozen properties. The projections do not change that file or its reachability scenarios.

## State map

For each original state `x`, each projection copies `file`, `tombstone`, `dpc`, `fence`, and `acknowledged` directly. The open projection sets `detail` to the record with fields `op`, `published`, and `badOpen` copied from `x`. The restore projection copies `restored` and `restoredRow` into `detail`. The list projection copies `feed`, `snapshot`, `generation`, `readPc`, `readGen`, `readConn`, `readRow`, `connection`, `online`, `rebuilt`, and `rebuiltRow` into same-named `detail` fields. Its `detail.shared` copies original `shared.gen`, `copyGen`, `copyRow`, `reading`, `sampleGen`, `sampleRow`, `bumped`, and `wants` into same-named fields. No other fields exist in these records.

For each fixed mode and the same constants, the initial state maps to `Init`. In particular all copied values are the original initial values. `Mode` is constant, not a state variable. The map erases fields outside that mode.

## Action obligations

For every original step with the same action parameters, the following table states the required projected step. A dash means stutter of every projected variable. The original action guard must imply the indicated projected guard and the copied successor values must match. Conversely, this argument does not require every projected step to lift to an original step.

| Original action | Open | List | Restore | Guard and successor correspondence |
| --- | --- | --- | --- | --- |
| `DeleteStart(d)` | same | same | same | `dpc[d] = "unused"`; copies the host transition and count increment. Only open copies the reset of `published`. |
| `DeleteHostClosed(d)` | same | same | same | `dpc[d] = "host"`; copies the transition to local. |
| `DeleteLocalClosed(d)` | same | same | same | `dpc[d] = "local"`; copies the transition to store. |
| `StorageRemove(d)` | same | same | same | `dpc[d] = "store"`; copies removal and the transition to removed. |
| `DeleteNotify(d)` | same | same | same | `dpc[d] = "removed"`; copies the transition to notified. List also copies the increment of `shared.gen`. |
| `DeleteCommit(d)` | same | same | same | `dpc[d] = "notified"`; copies tombstone, done, and the individual count decrement. |
| `DeleteFail(d)` | same | same | same | `dpc[d]` is host, local, or store; copies failed and the individual count decrement without setting tombstone. |
| `DeleteAcknowledged(d)` | same | same | same | `dpc[d] = "done"`; copies acked and `acknowledged`. List also copies both feed and snapshot resets, each generation update, and the rebuilt reset. |
| `ReadStart(s,r)` | - | same | - | `online` and unused slot are copied; waiting, captured generation, connection, and wanted shared generation match. |
| `ShareStale` | - | same | - | The copied `bumped` guard and the gen increment and bump match. |
| `ShareReadStart` | - | same | - | The copied reading and generation guard, and the generation and file samples, match. |
| `ShareReadFinish` | - | same | - | The copied reading guard and sampled copy publication match. |
| `ReadAnswer(s,r)` | - | same | - | The copied waiting and wanted-generation guard and the ready and row assignments match. The erased late observer has no retained effect. |
| `ReadFinish(s,r)` | - | same | - | The copied ready guard and connection and generation comparisons match. Both branches copy the same PC, feed, rebuilt, and rebuiltRow results. The erased observer assignments have no retained effect. |
| `SaveSnapshot(s)` | - | same | - | The action has no guard; it copies the current feed to the same snapshot. |
| `Reconnect` | - | same | - | The copied connection-zero guard and connection, online, and snapshot-to-feed assignments match. |
| `Restore` | - | - | same | The copied not-restored and tombstone guard and both restore assignments match. |
| `OpenView(o)` | same | - | - | The copied unused and `OpenAllowed` guard and publication assignments match. |
| `OpenStart(o)` | same | - | - | The copied unused and `OpenAllowed` guard and kind assignment match. |
| `OpenKind(o)` | same | - | - | The copied kind guard and conditional next PC match. |
| `OpenCwd(o)` | same | - | - | The copied cwd guard and conditional next PC match. |
| `OpenPublish(o)` | same | - | - | The copied directory guard, `RecheckOpen`, `OpenAllowed`, and pre-state publication set give the same PC, publication set, and parenthesized `badOpen` expression. |

Original stuttering steps map to stuttering steps. In each dash cell the original action changes no copied field, even when its erased guard is true. Each same cell retains every guard dependency and retained successor dependency; it does not merge neighboring awaits. The delete actions keep `fence` as an independent variable rather than derive it from `dpc`.

## Source correspondence

`src/main/session-mutations.ts:46-73` increments the delete count before hosted and local closes, awaits storage deletion, adds the tombstone, and releases the count in `finally`. `src/main/remote/host-services.ts:2839-2855` closes hosted tabs and awaits their exits. The model keeps these waits and the failure releases as separate delete steps.

`src/main/session-index.ts:329-338,441-444` deletes storage before notifying the shared list. `src/main/session-list-share.ts:46-60` increments the shared generation on invalidation. Its `34-43,77-89` ranges capture a wanted generation, await a shared read, and publish the sample. The model keeps the sample, wanted generation, and notification distinct.

`src/renderer/stores/session-list.ts:107-127` seeds the feed and defines its snapshot save and generation state. `171-183,202-204` captures and checks a read generation; `236-251` invalidates pending reads when the last holder releases the feed. The model's `connection` and `readConn` comparison abstracts release and rebuild invalidation. It is not a literal renderer connection-number comparison and does not prove all in-place reconnects. Feed removal maps to `259-268`, and acknowledgement removes both scopes' snapshots at `271-285`. Delta application, announced-version handling, retries, and rename behavior outside these boundaries are not covered.

`src/main/remote/host-services.ts:1878-1885` checks the tombstone and in-flight delete count before opening. The existing-view path checks and publishes at `1929-1951,2127-2160`. The lookup and final check are at `1967-2004`, with sidecar creation and publication at `2127-2160`.

`src/main/tab-layout.ts:80-108` bridges the native layout's deleted query to `deletedSessions().has`. `native/ompdesk/crates/core/src/pool/layout.rs:156-158,270-277` asks that query and filters the deleted session. The restore projection abstracts that cross-language query and filtering as one step; it does not model its awaits or persistence.

## Erased observers

The list map omits `shared.late`, `shared.lateDropped`, and `shared.freshAfterLate`. Initially their values do not affect any copied field. By induction on the action table, no original guard reads any of these fields and no retained successor expression reads them. `ReadAnswer` writes `late` and `ReadFinish` writes the other two only as observer effects. Therefore states equal under the list map remain equal under the same enabled original action, regardless of these observer values. `shared.wants` is retained because `ReadAnswer` reads it. The original `NeverLateReplyAndFreshRead` scenario remains in the original model and cannot be evaluated in this projection.

## Property mapping and trace claim

Under the state map, the original predicates equal these projected predicates, with all other operators and quantifiers unchanged:

| Original frozen predicate | Projection | Exact field substitution |
| --- | --- | --- |
| `NoFeedReinsert` | list | `feed` to `detail.feed`, `snapshot` to `detail.snapshot`; `acknowledged` unchanged. |
| `NoOpenDuringDelete` | open | `badOpen` to `detail.badOpen`. |
| `FenceCount` | all | `fence`, `dpc`, and `Active` unchanged. |
| `ReconnectReadAbsent` | list | `rebuilt` to `detail.rebuilt`, `rebuiltRow` to `detail.rebuiltRow`; `acknowledged` unchanged. |
| `RestoredDeletedAbsent` | restore | `restored` to `detail.restored`, `restoredRow` to `detail.restoredRow`; `tombstone` unchanged. |

Induction over one original trace uses the same initial state and the same original action at each position for all three maps. Each delete event has the same parameter, order, `dpc`, file, tombstone, count, and acknowledgement in all three projected traces. Stutters preserve positions for erased events. Arbitrarily combining separately generated projection histories does not establish this relationship. If the stated initial, step, and predicate obligations hold and each corresponding projection satisfies its assigned invariant, an original violating finite prefix would project to a violating prefix. This implication is conditional on those obligations and on completed safety checks. It is not a liveness or implementation proof.

## Conditional replacement obligations

Completed safety of all three baselines, together with the stated forward state/action/stutter map and predicate equalities, could discharge the five-property bounded safety obligation attempted by the original matrix baseline. It would not turn that timed-out execution into a PASS. Promotion requires an explicit review of the completed evidence; no old gate is retired here.

A projected mutation counterexample is not automatically an original-model mutation counterexample. Replacing the original seven mutation obligations additionally requires exact mutated correspondence and a way to lift the counterexample into an original trace. Original-to-projection forward simulation alone is insufficient for that claim. Direct mutation counterparts are feed generation, final count and tombstone checks, successful count reset, joint connection/generation checks, wanted source generation, and restore filtering. Their old failed gate remains open until this extra argument and actual detection evidence are accepted.

All original reachability and late-reply diagnostic scenarios remain unchanged. New sanity negatives establish only their named projection observations. They do not replace the removed late observers or silently broaden reconnect ordering, filesystem durability, stock storage behavior, exit confirmation, authorization receipts, liveness, or native SessionOps composition. The same original delete-spine history must underlie all projected traces; arbitrary independent histories are never combined.

