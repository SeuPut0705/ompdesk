# Correspondence

| Action | Implementation | Boundary |
|---|---|---|
| Prepare / PersistSource | `checks/hub.rs` `finish_with`, `publish_unconfirmed`, `save_journal` | Memory mutation and synchronous `write_kept` success are separate. A failed save does not authorize publication. |
| Send | Native result notifications and `checks/mod.rs` replay on hub open/pass | Source retains the identical journal-scoped phase ID until ACK. A sent or received event is not durable receiver acceptance. |
| AcceptDisk / AcceptMemory / SaveError | Inbox owner's `agentRuntime.enqueueMail` Persistence contract | Disk transfers responsibility. Memory and save errors do not. This is an explicit external contract, not an atomic model-read abstraction. |
| ReplyDisk / Ack | `checks/result-delivery.ts` `connectChecksResults`, `CoreChecksHub.ackResult`, native `acknowledge` | Receipt must identify the same delivery and say Disk before ACK. Native ACK removal is persisted before success. |
| SourceCrash / ReceiverCrash | Environment | Volatile preparation, in-flight state and replies may disappear. Source and receiver durable ownership survive; replay keeps its key. |

The receiver's stable journal key absorbs duplicate enqueue attempts, including a lost response after Disk acceptance or a lost source ACK response. Tests of the consumer use a real temporary journal but do not substitute for the receiver owner's native persistence tests or final wired runner proof.
