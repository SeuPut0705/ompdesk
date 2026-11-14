--------------------------- MODULE InboxWakePolicy ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS MaxIds, MaxAttempts, MaxEpochs, PromoteRequested, ReplaceFirst,
          IncomingRetryWake, WakeObserved, IgnoreCard, WakeMemory,
          ConsumeHistory, SkipMalformed, SuppressHistory, WakeHistory
VARIABLE s
vars == <<s>>
Ids == 1..MaxIds
Intents == {"immediate", "follow_up"}
Init == s = [introduced |-> {}, requested |-> [id \in Ids |-> "none"],
             stored |-> {}, disk |-> {}, observed |-> {},
             firstIntent |-> [id \in Ids |-> "none"], firstDispatch |-> [id \in Ids |-> 0],
             stableIntent |-> [id \in Ids |-> "none"], stableDispatch |-> [id \in Ids |-> 0],
             epoch |-> 0, card |-> FALSE, attempts |-> 0, phase |-> "idle",
             batch |-> 0, offered |-> "none", captured |-> 0,
             proofId |-> 0, proofEpoch |-> 0, proofGood |-> TRUE, envelopeGood |-> TRUE,
             wakes |-> <<>>, badHistorical |-> FALSE, badMalformed |-> FALSE,
             suppressed |-> FALSE]

\* @code native/ompdesk/crates/core/src/agentctl/service/messages.rs:291-309 Capture original requested intent in logical identity, once per key.
Introduce(id, intent) == /\ id \notin s.introduced
                         /\ s' = [s EXCEPT !.introduced = @ \cup {id},
                                           !.requested = [s.requested EXCEPT ![id] = intent]]
\* Environment: a current question card can open or close between actual awaited boundaries.
ChangeCard == s' = [s EXCEPT !.card = ~@]
\* Environment: a bridge incarnation changes; this module does not model peer authentication.
ChangeEpoch == /\ s.epoch < MaxEpochs
               /\ s' = [s EXCEPT !.epoch = @ + 1]

\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_delivery.rs:259-280 Await current guarded status before classifying a batch.
Begin(id, intent, proof, epoch, good, envelope) ==
    /\ s.phase = "idle" /\ s.attempts < MaxAttempts /\ id \in s.introduced
    /\ (proof = 0 => good)
    /\ s' = [s EXCEPT !.phase = "status", !.batch = id, !.offered = intent,
                      !.captured = s.epoch, !.proofId = proof, !.proofEpoch = epoch,
                      !.proofGood = good, !.envelopeGood = envelope, !.attempts = @ + 1]
History == s.proofId \in s.stored /\ s.proofEpoch # s.epoch
IntentAllowed == ~(s.requested[s.batch] = "follow_up" /\ s.offered = "immediate") \/ PromoteRequested
StatusAllowed == (s.proofGood /\ s.envelopeGood) \/ SkipMalformed

\* A proofGood status abstracts validation of EVERY receipt/key, including historical items, before any mutation.
\* A current proof is assumed backed by the separate provider-context/output observer, not by a status word.
\* @code native/ompdesk/crates/core/src/agentctl/journal/inbox_ledger.rs:345-397 Validate all receipt fields/keys, ignore history, then reconcile only current proof.
Validate == /\ s.phase = "status" /\ s.captured = s.epoch /\ StatusAllowed /\ IntentAllowed
            /\ LET applies == s.proofId \in s.stored /\ (s.proofEpoch = s.epoch \/ ConsumeHistory)
               IN s' = [s EXCEPT !.observed = IF applies THEN @ \cup {s.proofId} ELSE @,
                                 !.badHistorical = @ \/ (applies /\ History),
                                 !.badMalformed = @ \/ ~s.proofGood \/ ~s.envelopeGood,
                                 !.suppressed = @ \/ (SuppressHistory /\ History),
                                 !.phase = IF SuppressHistory /\ History THEN "idle" ELSE "keep"]
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_delivery.rs:259-306 Preserve pending input on route/status/persistence rejection; never fabricate an ACK.
Reject == /\ s.phase = "status" /\ (s.captured # s.epoch \/ ~StatusAllowed \/ ~IntentAllowed)
          /\ s' = [s EXCEPT !.phase = "idle"]
AbortStaleKeep == /\ s.phase = "keep" /\ s.captured # s.epoch
                  /\ s' = [s EXCEPT !.phase = "idle"]

\* The record EXCEPT update is one synchronous keep/wake boundary. Failed persistence is represented by toDisk=FALSE.
\* @code native/ompdesk/crates/core/src/agentctl/journal/inbox_ledger.rs:277-296 Preserve first accepted payload/dispatch on duplicate keep.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_delivery.rs:307-351 Notify the actual receiving control only after Disk, current-card and first-intent checks.
Keep(toDisk) ==
    /\ s.phase = "keep" /\ s.captured = s.epoch
    /\ LET id == s.batch
           exists == id \in s.stored
           first == IF exists THEN s.firstIntent[id] ELSE s.offered
           keptIntent == IF ReplaceFirst THEN s.offered ELSE first
           keptDispatch == IF ~exists \/ ReplaceFirst THEN s.attempts ELSE s.firstDispatch[id]
           wakeIntent == IF IncomingRetryWake THEN s.offered ELSE keptIntent
           ordinaryWake == (toDisk \/ WakeMemory) /\ (~s.card \/ IgnoreCard)
                           /\ (id \notin s.observed \/ WakeObserved) /\ wakeIntent = "immediate"
           historyWake == WakeHistory /\ History
           event == [id |-> id, disk |-> toDisk, card |-> s.card,
                     observed |-> id \in s.observed, first |-> first, history |-> historyWake]
       IN s' = [s EXCEPT !.stored = @ \cup {id},
                         !.disk = IF toDisk THEN @ \cup {id} ELSE @,
                         !.firstIntent = [s.firstIntent EXCEPT ![id] = keptIntent],
                         !.firstDispatch = [s.firstDispatch EXCEPT ![id] = keptDispatch],
                         !.stableIntent = IF exists THEN @ ELSE [s.stableIntent EXCEPT ![id] = first],
                         !.stableDispatch = IF exists THEN @ ELSE [s.stableDispatch EXCEPT ![id] = s.attempts],
                         !.wakes = IF ordinaryWake \/ historyWake THEN Append(@, event) ELSE @,
                         !.phase = "idle"]

Next == (\E id \in Ids, intent \in Intents : Introduce(id, intent))
        \/ ChangeCard \/ ChangeEpoch
        \/ (\E id \in Ids, intent \in Intents, proof \in Ids \cup {0},
               epoch \in 0..s.epoch, good \in BOOLEAN, envelope \in BOOLEAN :
               Begin(id, intent, proof, epoch, good, envelope))
        \/ Validate \/ Reject \/ AbortStaleKeep \/ (\E disk \in BOOLEAN : Keep(disk))

\* FROZEN POLICY PROPERTIES -- Main d36/d37, not replacements for InboxHop's eleven properties.
RequestedIntentPreserved == \A id \in s.stored : s.requested[id] = "follow_up" => s.firstIntent[id] = "follow_up"
FirstDeliveryStable == \A id \in s.stored : /\ s.firstIntent[id] = s.stableIntent[id]
                                             /\ s.firstDispatch[id] = s.stableDispatch[id]
HistoricalProofCannotConsume == ~s.badHistorical
MalformedProofCannotAffect == ~s.badMalformed
ObservedReplayDoesNotWake == \A i \in 1..Len(s.wakes) : ~s.wakes[i].observed
WakeRequiresDiskCardAndFirstImmediate == \A i \in 1..Len(s.wakes) : /\ s.wakes[i].disk
                                                                               /\ ~s.wakes[i].card
                                                                               /\ s.wakes[i].first = "immediate"
HistoryDoesNotSuppressOrNotify == ~s.suppressed /\ (\A i \in 1..Len(s.wakes) : ~s.wakes[i].history)
\* END FROZEN POLICY PROPERTIES
Spec == Init /\ [][Next]_vars
=============================================================================
