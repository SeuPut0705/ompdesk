# Native report coalescer

Status: SOURCE / unverified design-to-code candidate. Owner: Main dispatch d113. No manifest registration, stamp or hosted run is part of this source packet.

## Promise and harm

A native report's successful completion names real receiver Disk responsibility for the exact immutable identity. A duplicate must not become another active Deliver, and a superseded or forgotten generation must not strand a waiter or complete a replacement. Violating that promise tells the sender that a report was accepted when it was discarded, uploads attachments unnecessarily, or applies a late result to someone else's report. Concurrent callers, timers, I/O completions and forget can interleave at different await/lock boundaries, so sequential tests alone miss the schedules.

## Bounded world

One authenticated sender/receiver pair, two delivery keys, two canonical hash representatives (equal or conflicting),
two concurrent caller tasks and finite calls per caller.
There are three completion allocations in the fast candidate and four in the larger candidate, with at most one retry.
The coalescing window is an enabled timer action, not a clock or fairness assumption.

The state holds native completion allocations, the existing pair's pending slot, exact in-flight handles,
scheduled-but-unstarted tasks, immutable identities, a first-outcome latch, per-call waiters,
receiver ownership and per-attempt effects.
It models the existing mailbox, not a proposed production registry or second queue.

Progress waits in the existing pair slot; Done/Question bypass the timer but share native completion semantics.
A different report can supersede the slot.
Same-key/same-hash callers join the indexed completion; conflicts retain the original.
Forget fences a pristine claim before callback invocation.
An ever-attempted handle stays indexed until its own end; its waiters receive Unknown, not a no-later-effect promise.

## Attempted is not unadmitted

The final source `9f42f5ccb` distinguishes claim from actual invocation.
`BeginDeliver` commits `attempted=true` under the exact generation/Arc check, before calling Deliver.
A failed attempt may already have transferred receiver responsibility before its response was lost.
Requeue therefore retains ever-attempted permanently.
Replacing or forgetting such a retry returns Unknown, even if that retry's new callback has not started.
Pristine queued and claimed tasks rejected before the first attempt return unadmitted and must never produce effects.
This classifies the frozen obligations by actual invocation, not memory Queued or timer ownership.

## Atomicity

Admission/join/conflict/supersede, timer claim, exact invocation fence and forget correspond to separate Tables regions.
The actual callback future runs outside Tables.
Lookup, original-plan materialization, source persistence, receiver Disk transfer and response remain separate actions.
No await exists between the guarded attempted commitment and callback invocation.
The watch outcome is first-wins under its own lock.

`g` denotes one stable completion allocation.
Physical retry generations are abstracted by `(g, attempt)`; the original handle survives retry, with no overlapping old callback.
Exact source/await/lock correspondence is recorded against `9f42f5ccb`.
It is a source-read mapping, not a mechanically checked refinement or runtime verdict.

## Exclusions

- No process crash/restart, unbounded network, filesystem durability proof, timeout-based cancellation guarantee or external ExactlyOnce claim.
- No model-context or provider-read assertion. ReceiverOwned is not ContextObserved.
- No new public authority, authentication, route, lease or queue design. Existing guards are assumptions of this single-pair slice.
- No preservation proof of the legacy coalescing window, stale dispatch policy, progress merging, board text or serialized report formatting. Those remain production-owner obligations.
- No complete model of source retry/runtime receiver retry/redeliverSends or stock. The final source's convergence seam must be listed, not inferred from this mailbox model.
- Preparation (including obtaining an Arc plan and canonical hash) is not a physical effect. Materializing a selected attachment plan and transferring Disk responsibility are the explicit effects; their counters do not count function calls.

## Checks and delivery ownership

Only parse and mutation-applicability checks may run locally. No local TLC, matrix or mutation execution, no downloads, no native build, no new CI/session and no edits outside this directory. Main owns the single actual hosted TLC run, its full logs, mutation outcomes, registration/handoff and any eventual stamp. A parse or unique mutation match is not a safety verdict or a mutation kill.

All baseline, sanity and mutation execution expectations in the matrix are proposed until observed on Main's coherent source. No fairness or state constraint is introduced to hide a counterexample; finite generation/call/retry domains are explicit bounds and the spec allows terminal stuttering.
