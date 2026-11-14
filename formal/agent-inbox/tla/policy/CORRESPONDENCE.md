# Native wake-policy correspondence

This is an additive safety projection of Main d36/d37. It does not replace or change InboxHop's eleven properties, actions, constants or matrix. No TLC, negative, mutation or stamp result exists.

## Actual code and observed boundary

`c40943d64ef90e540d7fa36a4b33fa615b4c9090` holds the native policy candidate. `b17f0c807415ae621b7001b01b19891780e4f6ca` changes only the handed-off report-once assertion block on exact `a51e170b262bdc87179a9e2c989cdcf0e2704ceb`; it permits retries without equating one transport attempt with one logical delivery. Neither fix has a native GREEN result yet.

The original a51 run `43606753491`, native Linux `132482970071`, reached the real native source/receiving stores. Strict clippy passed. Native tests reported 1128 pass, 7 fail, 2 ignored. The guard/durable-reopen/serde cases passed; the seven remaining failures exposed missing summaries, missing wait notification, card intent/receipt policy and an incidental transfer-count assertion. This is not authenticated TS host transport or real provider-context consumption proof.

| Action | Source boundary | Abstraction |
| --- | --- | --- |
| Introduce | `service/messages.rs::AgentControl::hand_send`; `inbox.rs::InboxLogicalMessage::validate` | Requested intent belongs to logical identity. The first derived intent may conservatively defer Immediate to FollowUp, never reverse an explicit FollowUp. The old nonchild/reported-turn promotion is not restored. |
| Begin | `runtime/inbox_delivery.rs::Runtime::accept_inbox` | Guarded current bridge status and the already authenticated route/receiver tuple precede import and keep. Authentication itself stays outside this policy model. |
| Validate/Reject | `journal/inbox_ledger.rs::InboxLedger::reconcile` | Every receipt's path, nonempty request/instance and native key are validated before any consumption. Only a current-incarnation proof can reconcile its existing logical key. A malformed list aborts without partially consuming an earlier item. |
| Historical branch | `resources/gui-bridge/agent-inbox-engine.ts:459-481` | The actual `#receipts` reader returns valid journal entries with their original `value.instance`; it does not rewrite them into a fresh observation. Different nonempty generations are expected history, ignored only after required validation. They neither become current proof nor block a fresh batch. |
| Keep | `journal/inbox_ledger.rs::InboxLedger::keep/known`; `runtime/inbox_delivery.rs::Runtime::accept_inbox` | The existing first effective intent is carried in internal `Ownership::Pending { intent }`. A proposed retry does not replace the first payload, dN or intent. Disk is separate from Memory/failure. |
| Wake | `runtime/inbox_delivery.rs::Runtime::accept_inbox`; `service/mod.rs::AgentControl::arrive` | The actual receiving control, not only the sender's process, notifies a blocking wait after Disk, current-ask and first-intent checks. The event is not provider consumption. ContextObserved retries do not notify. |
| Context observation | `resources/gui-bridge/agent-inbox-context.ts:48-84` | A fresh observer records context membership plus the first real assistant/tool event under its current instance. This model assumes a valid current proof comes from that boundary; it does not synthesize or prove the observer. |

## Actors, bounds and explicit limits

The environment independently introduces requested intents, opens/closes a current ask, changes the bridge incarnation, chooses status/proof inputs and chooses completed Disk versus Memory/failed persistence. Each modeled status validation and keep/notification action corresponds to a synchronous source section between awaits. A single record variable with `EXCEPT` updates preserves every unmodified successor field explicitly; this is not a second runtime queue.

The baseline is 2 logical IDs, 2 admission attempts and 1 incarnation change. The second positive case is 2 IDs, 3 attempts and 2 changes. All seven properties are frozen in Properties.md. Ten unsafe modes, ten targeted negative cases and ten mutations are only kill hypotheses until the one coordinated hosted gate runs. There is no fairness, symmetry or liveness claim.

The projection assumes authenticated route/receiver checks and genuine current proof production. It abstracts the complete receipt list into all-items shape/envelope validity plus one representative referenced key. It does not prove Rust serialization, atomic filesystem durability, permission/connection projection, stream cancellation, stock queue/companion ownership, arbitrary external-tool exactly-once effects, real model understanding or the current remote transport. The original native model and actual native/stock regressions retain those separate concerns; neither model is a composition proof of the other. Upstream public APIs, actual release/floor/capabilities, hosted execution and live-queue migration remain separate gates. The twelve ambiguous live messages remain untouched.
