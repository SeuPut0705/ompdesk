# Correspondence: native report coalescer

Sync status: SOURCE, source-read against `9f42f5ccb` and registered with `syncCommit: null`, not model-checked or stamped.
Main d113 owns acceptance of this mapping and the actual hosted result.
The original `77bc9fe81` remains the pre-fix reference; its memory-Queued behavior is not relabelled as a pass.

## Exact code evidence

All paths below are relative to `native/ompdesk/crates/core/src/agentctl/` in the immutable `9f42f5ccb` tree.
Source order: `77bc9fe81`, test-first `53327f34c`, test-first `6b1d2771c`, then `21a94251e`, `03cecb5de`, `9f42f5ccb`.
This document imports no production code.

- `rules/mail.rs:400-418`: existing Waiting, monotone attempted, pending map and exact-generation/Arc completion index.
  `439-472`: lazy first-outcome construction under the watch lock, waiting outside Tables.
  `476-509`: generation AND Arc equality on removal; Drop never overwrites an existing latch.
- `rules/mail.rs:593-688`: timer claim is separate from actual invocation.
  `621-645` checks generation/Arc and unfinished latch, marks attempted under Tables, then invokes Deliver without an intervening await.
  Error requeue retains the completion and attempted history, disarms the old guard, and allocates a fresh physical generation.
- `rules/mail.rs:763-875`: synchronous Tables region joins all native kinds before replacement, rejects canonical conflicts,
  removes the ephemeral plan before board cloning, replaces only the existing pair slot, and registers immediate native claims.
  `880-915` awaits the original completion after launching delivery.
  `930-954` forget fences unstarted claims but retains attempted handles.
- `service/messages.rs:746-772, 819-847` creates the original Arc plan and queries canonical refs, without native carry.
  `service/mod.rs:302-325` invokes late preparation inside the selected Deliver.
  `service/attach.rs:742-801` returns Existing before effects, or carries only after authoritative Missing.
  Its borrowed materialization seam is `667-708`.
- `runtime/inbox_source.rs:224-259` queries before and inside the source lane, persists the original source with Disk responsibility,
  then awaits the exact receiving receipt.
  `583-643` separates landing awaits from receiving Disk acceptance and checks the exact receiver/key set.

## Atomic regions and actions

| Model action | Exact code region in `9f42f5ccb` | Granularity / abstraction |
|---|---|---|
| `Admit` | `rules/mail.rs:763-875` | One Tables region. Carries original plan, settles replaced pending waiters, registers an unstarted claim. |
| `Join` | `rules/mail.rs:773-790` | Same Tables region; original completion shared by Progress, Done and Question. |
| `Conflict` | `rules/mail.rs:785-787, 514-540` | Canonical mismatch returns error, original retained. Reuses the existing ledger fingerprint. |
| `Claim` | `rules/mail.rs:596-616` | Exact pending-generation removal and in-flight registration under Tables. Claim is not invocation. Timer has no fairness. |
| `BeginDeliver` | `rules/mail.rs:621-645` | Checks exact generation AND Arc plus unfinished latch; commits attempted before invocation with no intervening await. |
| `FenceUnstarted` | `rules/mail.rs:628-641, 482-509, 946-953` | Forgotten task cannot invoke Deliver or remove a replacement handle. Cleanup touches only its own handle. |
| `LookupKnown` | `service/attach.rs:768-781`; `runtime/inbox_source.rs:224-238` | Awaited authoritative Existing answer; no materialization. Intermediate source-lane lookups are folded into this answer. |
| `LookupMissing` | `service/attach.rs:768-790`; `runtime/inbox_source.rs:233-244` | Missing and materialization are separate transitions; Missing is not eternal exclusivity. |
| `LookupConflict` | Same canonical lookup boundary | Error leaves receiving row unchanged; terminal selected-callback error is unconfirmed. |
| `Materialize` | `service/attach.rs:667-708, 790-800`; `runtime/inbox_source.rs:583-618` | Actual attachment effects for an attached report. Per-file awaits are collapsed; not per-file ExactlyOnce. |
| `PersistSource` | `runtime/inbox_source.rs:240-244` | Successful source journal Disk transaction; failure is `FailDeliver`, never ACK. |
| `Receive` | `runtime/inbox_source.rs:245-257, 620-643` | Abstract exact receiver Disk transaction, separate from reply; not stock/provider consumption. |
| `Return` | `rules/mail.rs:646-657, 482-509, 447-454` | Settles only its original latch; first result cannot be overwritten; exact cleanup retains replacements. |
| `FailDeliver` | `rules/mail.rs:659-688` | Error and bounded retry under Tables; may follow Receive. Same handle requeues with attempted history. Terminal failure is Unknown. |
| `Forget` | `rules/mail.rs:930-954` | One Tables region. Pristine queued/claimed work ends unadmitted; attempted work ends Unknown and keeps its task. |
| `AckQueued` | Pre-fix memory-Queued mode | Deliberately broken baseline under `EarlyAck = TRUE`, never an allowed implementation. |

`Spec` has no fairness. Environment scheduling may indefinitely delay any task. The model's stuttering closure is deliberate; `CHECK_DEADLOCK FALSE` means the matrix checks safety only, not scheduler progress or deadlock freedom. No state constraint, symmetry or depth cutoff is used.

## State and observations

| Model element | Code meaning / abstraction |
|---|---|
| `flights[g]` | One native completion allocation and original mail. `g` abstracts stable Arc identity, NOT every physical timer generation. Not a proposed production object. |
| `flights[g].key`, `.hash` | Actual native delivery key and canonical equality class. Two hash representatives distinguish same/conflicting bytes; cryptographic collisions are outside this model. |
| `.kind` | Progress uses the existing timer; Done and Question select immediate Deliver. No legacy kind policy is altered. |
| `.phase` | Program counter at lock/await boundaries. It is not inferred from public Queued wording. |
| `.ever` | Actual ever-attempted commitment at `BeginDeliver`, not claim. Remains true after requeue. |
| `.attempt` | Bounded callback ordinal. Retry's fresh physical generation plus stable Arc is abstracted by `(g, attempt)`, with no overlapping old retry callback. |
| `.sourceOwned` | Successful native source persistence. This flag does not prove receiver ownership. |
| `.outcome` | Single-assignment native completion latch. Unknown is not overwritten by the late actual Deliver result. |
| `.receipt` | Actual selected Deliver result awaiting mailbox cleanup; distinct from the already-resolved completion latch. |
| `pending` | One existing `from>to` progress Waiting slot. |
| `inFlight` | Exact completion handles, including claimed-but-not-started tasks. Not another mail queue. |
| `requests`, `counts` | Two caller tasks and finite per-task sequential calls; requests record waiters and consumer-visible outcomes. |
| `lastGen` | Bounded fresh completion allocation token. Additional physical retry generations are represented by `.attempt`. Reuse/wraparound is excluded. |
| `receiver`, `owned` | Canonical receiving ledger row and historical Disk ownership. Initial ownership may already exist; later ownership is monotone. No stock/provider state. |
| `effects` | History of actual attachment materialization per selected attempt. Not `carry_planned` invocation counts. |
| `known` | Attempt history whose authoritative lookup returned receiver-owned. |
| `received` | Receiver transactions recorded as `(generation, attempt, wasUnknownBeforeThisEvent)`. The third field makes the late-effect sanity probe order-sensitive. |
| `originalHash` | Observer snapshot of the first canonical hash per allocated generation. It does not participate in admission/dedup decisions. |
| `expectedJoin` | Observer for the identity present before each caller's admission. A mutant that wrongly admits another generation still records the expected original, so the join obligation is not vacuous. |
| `unknownActive` | Forgotten attempted handles until their callback return/error or unstarted-retry fence. |
| `unknownEnded` | Handles whose supersession/forget ended Unknown; later real receiving ownership is legal. Observer only, never an admission guard. |
| `scheduled` | Claimed tasks before the invocation fence, including forgotten tasks that may wake after a new same-key completion is registered. |

## Assumptions and non-equivalences

1. Authentication and current source/receiver identity are already established. The real source must still execute those guards; this model does not grant authority from a key/hash.
2. Each mailbox tables lock is atomic; the actual Deliver future runs outside that lock. Source-lane mutex and receiver transaction are separate from the mailbox lock.
3. Source/receiver Disk operations are represented by successful abstract transactions. Filesystem corruption, cross-process crashes and lost ownership after restart are not covered.
4. Canonical hash equality stands for the actual immutable logical message plus original attachment refs, including absent versus present-empty sets. Presentation text, landing paths/times and a newly derived dispatch cannot redefine identity.
5. Materialization may fail or partially take effect. `FailDeliver` may happen after any active boundary, including after receiver ownership. The model records at least one representative effect, not per-file counts or rollback.
6. Same-handle latch writes are first-wins.
   Actual watch lock and generation/Arc removals were read at `rules/mail.rs:447-509, 628-645, 930-954`.
   `FenceUnstarted` merges Drop's separate remove-active and latch steps.
   No intervening action can revive or redirect the old latch. This is an abstraction obligation, not a checked refinement proof.
7. Explicit retry source is confirmed: `service/mod.rs:1201-1203` obtains this port's Runtime and calls `redeliver_inbox`,
   then preserves awaited legacy redelivery. `runtime/inbox_delivery.rs:51-74` schedules that same runtime's receiver retry.
   This mailbox model does NOT prove convergence, registration, stock consumption or the TS consumer's execution.
8. Different keys may have active Deliver work concurrently.
   Per-receiver source-lane serialization is not modeled as a global mailbox lock to hide interleavings.
9. `Return` folds successful watch completion and exact active cleanup into one transition.
   No second callback for that old task remains after cleanup; forgotten completion still carries its own handle.
   Panics/process teardown and wire authentication are outside this model's claims.
10. Materialization may first occur before source persistence; later transfer uploads follow it.
    The shared effect event records occurrence, not file-stage ordering, cache eviction or the number of uploads.

## Mutation correspondence

Each mutation changes one concrete transition/guard, never a frozen property.
Thirteen proposed faults cover premature ACK, attempted-retry classification, unstarted invocation fencing,
duplicate admission, known retry materialization, late slot cleanup, replacement waiter completion,
missing supersede/forget settlement, conflict overwrite, active-handle removal, late latch overwrite,
and an old unstarted task deleting a new same-identity handle.
Unique application and SANY success are not mutation kills.
Main must observe each named violation on the coherent source.
