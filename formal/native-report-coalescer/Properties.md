# Native report coalescer safety obligations

Status: SOURCE / safety obligations, not a model-check result.
Main dispatch d113 is the protocol source; exact production correspondence was read at `9f42f5ccb`.
No property is evidence that a current consumer passes.

## Frozen obligations

| Property | Consumer promise | Basis |
|---|---|---|
| `NoAckBeforeReceiverOwned` | A successful native report completion implies actual receiving Disk responsibility for that exact key and canonical hash. Neither memory Queued nor provider-read inference substitutes. | d113; `DeliveryReceipt::{New,Existing}` and receiving lookup/transfer in 77bc `rules/mail.rs`, `runtime/inbox_source.rs` |
| `NoSupersededEffects` | A report terminally rejected before admission by queued supersession or queued forget produces no physical materialization or receiving effect. OutcomeUnknown is explicitly excluded from this classification. | d113 queued/active distinction |
| `NoConcurrentIdentityDeliver` | One identity cannot have two active Deliver attempts concurrently. A same-key, same-canonical-hash pending/active caller joins the first completion. | d113 same-identity completion join |
| `NoKnownRetryEffects` | Once lookup returned known receiver ownership, that attempt returns the existing responsibility without attachment materialization or another receiving transfer. | d113 lookup-before-effects; 77bc `post_report` known branch |
| `NoLateReplacementMutation` | Finishing an old generation neither removes a replacement nor resolves the replacement's waiters with the old outcome. | d113 generation fence |
| `NoUnadmittedWaiterOrphan` | Superseding/forgetting a queued generation completes all its waiters as unadmitted; no waiter remains waiting on that terminal generation. This is a safety check on the terminal transition, not eventual delivery. | d113 waiter completion requirement |
| `ConflictPreservesOriginal` | A same-key, different canonical hash returns conflict without replacing the original pending/active or receiver identity and without effects from the conflicting caller. | d113 immutable identity; 77bc `same_pending_native` canonical payload comparison |
| `UnknownRetainsResponsibility` | Forget of an active delivery ends its waiters with OutcomeUnknown but leaves the original active task and receiver responsibility intact until its own completion. A later physical effect remains legal. | d113 active forget contract |

These names and definitions are frozen before the transition model is written. `TypeOK` is a structural check, not a protocol promise. Sanity invariants are reachability probes, not extra safety requirements.

## Non-claims

- No crash-wide or cross-process ExactlyOnce guarantee. The model has one live sender/receiver pair, not an unbounded network or filesystem.
- No claim that a native Disk ACK means the provider read or even journaled a stock message. Provider consumption is not modeled.
- No liveness/fairness assumption. Scheduler stutter is permitted. Unadmitted terminal waiter settlement is checked at the state change that owns the waiters.
- No equivalence proof for legacy coalescing, its window, stale dispatch handling or public tools. Their policy is unchanged and outside this new native concern.
- Preparation function invocation is not a physical effect. Only the selected Deliver's materialization and receiver responsibility transition count.
- Bounds are explicit protocol exploration limits. They will not be used as state constraints to prune unsafe reachable states.
