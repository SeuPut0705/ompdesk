------------------------------ MODULE InboxHop ------------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS MaxIds, MaxCrashes, AckMemory, SkipBlob, Overwrite, DuplicateQueue,
          Reorder, ReceiptEarly, ProviderEarly, StaleFence, EvictPending, ClaimLegacy, ReplaceDispatch
VARIABLES source, introduced, recvMem, recvDisk, terminalMem, terminalDisk,
          blobs, retained, queued, journal, durableInput, providerContext, output,
          acked, generation, capturedGeneration, available, crashes, payloadVersion,
          unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch
vars == <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk,
          blobs, retained, queued, journal, durableInput, providerContext, output,
          acked, generation, capturedGeneration, available, crashes, payloadVersion,
          unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
Kinds == {"prompt", "report"}
Ids == Kinds \X (1..MaxIds)
Elems(s) == {s[i] : i \in 1..Len(s)}
AppendMissing(s, items) == s \o SelectSeq(items, LAMBDA id : id \notin Elems(s))
Ordered == [i \in 1..(2 * MaxIds) |-> <<IF i % 2 = 1 THEN "prompt" ELSE "report", (i + 1) \div 2>>]
Pending == SelectSeq(Ordered, LAMBDA id : id \in source)
Fence == available /\ capturedGeneration = generation
Init == /\ source = {} /\ introduced = {} /\ recvMem = <<>> /\ recvDisk = <<>>
        /\ terminalMem = {} /\ terminalDisk = {} /\ blobs = {} /\ retained = {}
        /\ queued = <<>> /\ journal = <<>> /\ durableInput = {} /\ providerContext = {} /\ output = {}
        /\ acked = {} /\ generation = 0 /\ capturedGeneration = 0 /\ available = TRUE /\ crashes = 0
        /\ payloadVersion = [id \in Ids |-> 0] /\ unsafeUsed = FALSE /\ legacyOwned = FALSE
        /\ dispatch = [id \in Ids |-> 0] /\ diskDispatch = dispatch /\ ackDispatch = dispatch
        /\ offeredDispatch = 1

\* Environment: source producers introduce a unique pair, in their persisted inventory order.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_source.rs:211-270 Persist original authenticated logical-source admission.
Introduce == /\ Cardinality(introduced) < Cardinality(Ids)
             /\ LET id == Ordered[Cardinality(introduced) + 1]
                IN /\ source' = source \cup {id} /\ introduced' = introduced \cup {id}
             /\ UNCHANGED <<recvMem, recvDisk, terminalMem, terminalDisk, blobs, retained, queued, journal,
                            durableInput, providerContext, output, acked, generation, capturedGeneration,
                            available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>

\* Environment: authenticated status returns; a receiver can change during the following awaited import.
Status == /\ capturedGeneration' = generation
          /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs, retained,
                         queued, journal, durableInput, providerContext, output, acked, generation,
                         available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
ChangeReceiver == /\ generation < 2 /\ generation' = generation + 1
                  /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                                 retained, queued, journal, durableInput, providerContext, output, acked,
                                 capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
Disable == /\ available /\ available' = FALSE
           /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs, retained,
                          queued, journal, durableInput, providerContext, output, acked, generation,
                          capturedGeneration, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
Enable == /\ ~available /\ available' = TRUE
          /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs, retained,
                         queued, journal, durableInput, providerContext, output, acked, generation,
                         capturedGeneration, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>

\* Environment: existing authenticated upload and destination AttachmentStore save succeed or remain absent.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_attachments.rs:22-126 Import only authenticated hash-verified bytes through existing stores.
ImportBlobs == /\ Fence /\ blobs' = blobs \cup source
               /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, retained,
                              queued, journal, durableInput, providerContext, output, acked, generation,
                              capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
\* @code native/ompdesk/crates/core/src/agentctl/journal/inbox_ledger.rs:238-326 Keep memory after failure but distinguish completed Disk responsibility.
AcceptMemory == /\ (Fence \/ StaleFence) /\ source # {}
                /\ (source \subseteq blobs \/ SkipBlob)
                /\ recvMem' = AppendMissing(recvMem, Pending)
                /\ dispatch' = [id \in Ids |-> IF id \in source /\ (dispatch[id] = 0 \/ ReplaceDispatch)
                                                  THEN offeredDispatch ELSE dispatch[id]]
                /\ unsafeUsed' = unsafeUsed \/ ~Fence
                /\ UNCHANGED <<source, introduced, recvDisk, terminalMem, terminalDisk, blobs, retained,
                               queued, journal, durableInput, providerContext, output, acked, generation,
                               capturedGeneration, available, crashes, payloadVersion, legacyOwned, diskDispatch, ackDispatch, offeredDispatch>>
\* A failed write leaves recvMem and source intact. Only this successful save updates disk responsibility.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_delivery.rs:178-267 Recheck the current receiver after awaited imports before native save/ACK.
SaveReceiver == /\ (Fence \/ StaleFence)
                /\ recvDisk' = recvMem /\ terminalDisk' = terminalMem /\ diskDispatch' = dispatch
                /\ unsafeUsed' = unsafeUsed \/ ~Fence
                /\ UNCHANGED <<source, introduced, recvMem, terminalMem, blobs, retained, queued, journal,
                               durableInput, providerContext, output, acked, generation, capturedGeneration,
                               available, crashes, payloadVersion, legacyOwned, dispatch, ackDispatch, offeredDispatch>>
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_source.rs:336-487 Retire producer originals only for exact receiving Disk keys.
Acknowledge == /\ LET taken == IF AckMemory THEN Elems(recvMem) ELSE Elems(recvDisk)
                 IN /\ source' = source \ taken /\ acked' = acked \cup taken
                    /\ ackDispatch' = [id \in Ids |-> IF id \in taken THEN diskDispatch[id] ELSE ackDispatch[id]]
              /\ UNCHANGED <<introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs, retained, queued,
                             journal, durableInput, providerContext, output, generation, capturedGeneration,
                             available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, offeredDispatch>>
\* Environment: the outer ACK is lost and the producer replays exactly the same stable logical identity.
Replay == /\ source' = source \cup (acked \cap introduced)
          /\ UNCHANGED <<introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs, retained, queued,
                         journal, durableInput, providerContext, output, acked, generation, capturedGeneration,
                         available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
Conflict(id) == /\ id \in Elems(recvMem)
                /\ payloadVersion' = IF Overwrite THEN [payloadVersion EXCEPT ![id] = 1] ELSE payloadVersion
                /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                               retained, queued, journal, durableInput, providerContext, output, acked,
                               generation, capturedGeneration, available, crashes, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>

\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_delivery.rs:269-400 Deliver only current receiving-ledger ordered inventory through the private bridge.
QueueBatch == /\ (Fence \/ StaleFence)
              /\ LET eligible == SelectSeq(recvDisk, LAMBDA id : id \notin terminalMem /\ id \notin Elems(journal)
                                     /\ (DuplicateQueue \/ id \notin Elems(queued)))
                     batch == IF Reorder THEN [i \in 1..Len(eligible) |-> eligible[Len(eligible) + 1 - i]] ELSE eligible
                 IN /\ eligible # <<>> /\ queued' = queued \o batch
              /\ unsafeUsed' = unsafeUsed \/ ~Fence
              /\ legacyOwned' = legacyOwned \/ ClaimLegacy
              /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                             retained, journal, durableInput, providerContext, output, acked, generation,
                             capturedGeneration, available, crashes, payloadVersion, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
StockCommit == /\ queued # <<>> /\ journal' = journal \o queued /\ queued' = <<>>
               /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                              retained, durableInput, providerContext, output, acked, generation,
                              capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
FlushStock == /\ durableInput' = Elems(journal)
              /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                             retained, queued, journal, providerContext, output, acked, generation,
                             capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
\* @code resources/gui-bridge/agent-inbox-engine.ts:500-514 Await stock persistence and flush, then recheck receiver/Stop before original provider.
CallProvider == /\ Fence /\ Elems(journal) # {} /\ (Elems(journal) \subseteq durableInput \/ ProviderEarly)
                /\ providerContext' = Elems(journal)
                /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                               retained, queued, journal, durableInput, output, acked, generation,
                               capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
ProviderOutput == /\ providerContext # {} /\ output' = output \cup providerContext
                  /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                                 retained, queued, journal, durableInput, providerContext, acked, generation,
                                 capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
\* @code native/ompdesk/crates/core/src/agentctl/journal/inbox_ledger.rs:328-377 Reconcile only actual context-ID plus provider-output proof.
ContextReceipt == /\ LET observed == IF ReceiptEarly THEN Elems(recvMem) ELSE output
                     IN /\ terminalMem' = terminalMem \cup observed /\ retained' = retained \cup observed
                  /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalDisk, blobs, queued, journal,
                                 durableInput, providerContext, output, acked, generation, capturedGeneration,
                                 available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
\* Environment: native restart loses only volatile state. Stock persistence and terminal identities survive.
Crash == /\ crashes < MaxCrashes /\ crashes' = crashes + 1
         /\ recvMem' = recvDisk /\ terminalMem' = terminalDisk /\ queued' = <<>> /\ dispatch' = diskDispatch
         /\ journal' = SelectSeq(journal, LAMBDA id : id \in durableInput)
         /\ providerContext' = {}
         /\ UNCHANGED <<source, introduced, recvDisk, terminalDisk, blobs, retained, durableInput, output,
                        acked, generation, capturedGeneration, available, payloadVersion, unsafeUsed, legacyOwned, diskDispatch, ackDispatch, offeredDispatch>>
ExpireNormalLifetime == /\ retained' = retained \ terminalDisk
                        /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, blobs,
                                       queued, journal, durableInput, providerContext, output, acked, generation,
                                       capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox.rs:48-59 Retain native receiver ledger hash references during normal existing-store GC.
BlobGc == /\ blobs' = IF EvictPending THEN {} ELSE blobs \ (terminalDisk \ retained)
          /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk, retained,
                         queued, journal, durableInput, providerContext, output, acked, generation,
                         capturedGeneration, available, crashes, payloadVersion, unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch, offeredDispatch>>

ChangePresentation == /\ offeredDispatch = 1 /\ offeredDispatch' = 2
                      /\ UNCHANGED <<source, introduced, recvMem, recvDisk, terminalMem, terminalDisk,
                                     blobs, retained, queued, journal, durableInput, providerContext, output,
                                     acked, generation, capturedGeneration, available, crashes, payloadVersion,
                                     unsafeUsed, legacyOwned, dispatch, diskDispatch, ackDispatch>>

Next == ChangePresentation \/ Introduce \/ Status \/ ChangeReceiver \/ Disable \/ Enable \/ ImportBlobs \/ AcceptMemory
        \/ SaveReceiver \/ Acknowledge \/ Replay \/ (\E id \in Ids : Conflict(id)) \/ QueueBatch
        \/ StockCommit \/ FlushStock \/ CallProvider \/ ProviderOutput \/ ContextReceipt \/ Crash
        \/ ExpireNormalLifetime \/ BlobGc

\* FROZEN PROPERTIES
NoAcceptedLoss == introduced = source \cup Elems(recvDisk)
DiskOnlyAck == acked \subseteq Elems(recvDisk)
ImmutableLogicalPayload == \A id \in Ids : payloadVersion[id] = 0
OneStockCommit == Len(journal) = Cardinality(Elems(journal))
NativeOrder == \A i,j \in 1..Len(journal) : i < j =>
               (CHOOSE a \in 1..Len(Ordered) : Ordered[a] = journal[i])
               < (CHOOSE b \in 1..Len(Ordered) : Ordered[b] = journal[j])
NoFalseContextReceipt == terminalMem \cup terminalDisk \subseteq output
ProviderRequiresDurableInput == providerContext \subseteq durableInput
CurrentReceiverFence == ~unsafeUsed
BlobCustody == ((acked \ terminalDisk) \cup retained) \subseteq blobs
ProtectedLegacy == ~legacyOwned
FirstDispatchStable == \A id \in acked : /\ ackDispatch[id] > 0 /\ ackDispatch[id] = diskDispatch[id]
\* END FROZEN PROPERTIES
Spec == Init /\ [][Next]_vars
=============================================================================
