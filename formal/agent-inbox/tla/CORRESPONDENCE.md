# Native hop source correspondence

This is a safety model of responsibility and input identity, not a native transport or execution verdict. Source unit `14e7d0747561ee16bb5664ef935e5bb999164c44` and guard regression `382de060e` required Relay's separate Host/constructor and current-receiver projection. Their integrated descendant `a51e170b262bdc87179a9e2c989cdcf0e2704ceb` was compiled and executed in Main's run `43606753491`: strict clippy passed and native tests reported 1128 pass, 7 fail, 2 ignored. Guard/durable-reopen/serde cases passed; the seven actual policy/consumer failures are not a whole-suite GREEN. The subsequent native policy candidate `c40943d64ef90e540d7fa36a4b33fa615b4c9090` remains unverified on the native surface.

| Model action | Candidate source | Boundary |
| --- | --- | --- |
| Introduce | `runtime/inbox_source.rs:211-270`; `service/messages.rs` | Initial native admission binds the actual saved source and persistent execution-host identity, then keeps the existing source outbox. Only Disk authorizes source responsibility. Durable replay does not require the original caller to stay open. |
| Status/ChangeReceiver/Disable/Enable | `runtime/inbox_delivery.rs:115-176`; Relay's current `Host.fresh` projection | The actual current target, path, device, opaque RpcClient runtime nonce, bridge context nonce, enabled/hidden/deletion/tombstone fences are distinct. Native acceptance rechecks after awaited work, not just at TS preflight. |
| ImportBlobs | `runtime/inbox_attachments.rs:22-126`; `web/uploads.rs`; `journal/attachments.rs` | Existing authenticated upload namespace is validated before reading. Hash/size bytes enter the existing receiving AttachmentStore. Temporary and ledger pins protect import/save/ACK windows. |
| AcceptMemory/SaveReceiver | `journal/inbox_ledger.rs:238-326`; `runtime/inbox_delivery.rs:178-267` | Memory/failed save retain pending state but never return Disk ACK. The first logical fingerprint and first presentation/dispatch are immutable. Existing write_kept owns full-disk retry. |
| Acknowledge/Replay/Conflict/ChangePresentation | `runtime/inbox_source.rs:336-487`; `agentctl/inbox.rs:291-327` | Source originals retire only on exact receiver/key-set Disk receipt. ACK loss repeats the same logical producer/target/request tuple, not transcript markers or a new dN. Derived paths/title/runtime are excluded from the logical fingerprint. |
| QueueBatch/StockCommit | `runtime/inbox_delivery.rs:269-400`; `resources/gui-bridge/agent-inbox-engine.ts` | Native ordered inventory is passed through the private captured current bridge. Exact authorized roots are adopted rather than re-enqueued; ambiguous legacy remains unchanged. Actual stock companion/admission ownership is not reimplemented by this model. |
| FlushStock/CallProvider | `resources/gui-bridge/agent-inbox-engine.ts:500-514` | Public stock persistence settlement and SessionManager.flush finish before the original provider; actual signal, Stop generation and receiver incarnation are rechecked. |
| ProviderOutput/ContextReceipt | `journal/inbox_ledger.rs:328-377`; bridge provider observer | A real context identity and first actual assistant/tool event yield context-observed proof, not semantic understanding. Accepted/journaled alone cannot retire native pending. |
| Crash | existing atomic source/receiver journal readers | A native restart restores Disk responsibility and stable identity; failed context-receipt persistence remains retryable. The model does not prove the filesystem or serialization implementation. |
| ExpireNormalLifetime/BlobGc | `runtime/inbox.rs:48-59`; `service/attach.rs`; `journal/attachments.rs` | Pending receiver references pin bytes. Context observation retains the normal upload lifetime, so the next tool can still read the attachment. |

## Actors and atomicity

Producer admission/replay, authenticated receiving-host projection, upload/store persistence, receiver acceptance/delivery, stock queue/context persistence, provider/output observer, and restart/GC act independently. Each model action represents the synchronous native/stock boundary between actual awaits. Actual Port state updates, peer allowance and HostTab connection lifetime need the native/TS consumer regressions and independent correspondence review; this table does not turn them into proved facts.

## Limits

The native model does not prove caller authentication, schema parsing, upload symlink safety against a malicious same-user process, public API availability, native compilation, authenticated hosted transport, real model understanding, or arbitrary external-tool exactly-once effects. It abstracts bytes by content identity and admission ordering by the existing source ordinal. Explicit follow_up, approval cards, stock companions and claim/publication ownership retain separate actual stock regressions and upstream formal modules. The live twelve ambiguous user-attributed messages are untouched and not claimed migrated.

The baseline/deep bounds and eleven frozen properties are in MC.cfg, matrix.json and Properties.md. Every mutation is an unexecuted kill hypothesis. SANY parsing and unique search strings cannot establish a passing model, a negative counterexample, a killed mutation or a stamp. All such checks remain the one coordinated hosted gate after exact source integration.

## Additive native policy projection

`policy/InboxWakePolicy.tla` covers the d36/d37 requested-versus-first-effective intent, current/historical receipt validation, current-card/Disk wake and already-observed replay boundaries. It has its own frozen properties, configurations, negative cases and mutation hypotheses. It does not change this module's eleven properties, transitions, bounds, fairness or matrix. See `policy/CORRESPONDENCE.md` for source links, actual RED evidence and remaining assumptions.

The actual bridge history reader is `resources/gui-bridge/agent-inbox-engine.ts:459-481`: it returns stored receipts with their original instance. A well-formed historical receipt is not a fresh provider observation and must not block a new valid batch. Malformed receipt lists still fail before any reconciliation is applied. A fresh observation still needs actual provider context plus its first real output.

The original model's `Fence` abstracts availability and captured receiver generation; it is not an explicit model of every original peer/connection/rtab projection. The actual native withdrawal/replacement and post-Disk responsibility regressions passed on a51. Neither this abstract fence nor the additive policy module is a proof of the authenticated TS route or the full transport. Do not advance a stamp or claim composition from these source/correspondence changes.
