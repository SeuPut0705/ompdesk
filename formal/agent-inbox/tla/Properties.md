# Frozen receiving-hop properties

Frozen before writing the receiving-hop model. Sources are Main d13, d14, and d15 and the inspected InboxLedger, native import, and provider-persistence candidate. Changing a property requires reporting the contract change. No TLC run or verification claim exists.

| Property | Observable contract | Source |
| --- | --- | --- |
| NoAcceptedLoss | Every introduced producer entry remains in its producer, receiving disk journal, or compact receiving terminal identity. | d13 source preservation and no TTL/count/idle trim |
| DiskOnlyAck | An outer acknowledgment names only identities whose receiving payload and required blobs are on disk. Memory and failures never acknowledge. | d13 and d14 |
| ImmutableLogicalPayload | Repeated identities cannot overwrite the first accepted logical body or hash references. Derived landing paths do not change logical equality. | d13 and d14 |
| OneStockCommit | Source replay, ACK loss, receiving restart, and bridge rebind cannot append the same native input to the stock conversation twice. | d13 and d15 |
| NativeOrder | Receiving stock input preserves native accepted inventory order within this receiver. | original user request and native ordered inventory contract |
| NoFalseContextReceipt | Native consumption requires the real provider context identity and its first real output. Accepted or journaled alone is insufficient. | d13 definition |
| ProviderRequiresDurableInput | The original provider cannot run with new native context identities until stock persistence settlement and flush succeed. | d15 |
| CurrentReceiverFence | Native acceptance and delivery cannot use stale runtime/bridge incarnation or disabled, hidden, deleted, or delete-in-flight receivers. | d13 and Relay's two-nonce contract |
| BlobCustody | An acknowledged file remains owned by the receiver across source deletion, upload expiry, and restart. Pending blob references never expire. Observed input retains the normal attachment lifetime. | d14 |
| ProtectedLegacy | Ambiguous legacy user-attributed/no-ID originals remain unchanged and do not gain native authority. | original user request and d9 |
| FirstDispatchStable | A lost ACK, changed presentation, source replay, or receiver restart returns the first durable dispatch instead of a newly proposed dN. | additive d16 logical-source/first-dispatch contract |

The model targets input identity and responsibility, not exactly-once arbitrary external tool effects. A process can die after an external tool acts but before its result persists. Stock's existing unknown-outcome recovery owns that case. Context membership plus first output does not establish semantic understanding or transactional tool effects.
