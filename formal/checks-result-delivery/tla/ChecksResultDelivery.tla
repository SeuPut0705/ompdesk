------------------------ MODULE ChecksResultDelivery ------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Keys
VARIABLE s
vars == <<s>>

Init == s = [ prepared |-> {}, published |-> {}, source |-> {}, sent |-> {},
              receiver |-> {}, memory |-> {}, adds |-> [k \in Keys |-> 0],
              receipt |-> [k \in Keys |-> "none"], acked |-> {}, badSend |-> FALSE ]

TypeOK ==
  /\ s.prepared \subseteq Keys /\ s.published \subseteq Keys /\ s.source \subseteq Keys
  /\ s.sent \subseteq Keys /\ s.receiver \subseteq Keys /\ s.memory \subseteq Keys
  /\ s.adds \in [Keys -> 0..2] /\ s.acked \subseteq Keys
  /\ s.receipt \in [Keys -> {"none", "disk", "memory", "error"}] /\ s.badSend \in BOOLEAN

\* Preparing a terminal or unconfirmed phase changes memory, not durable ownership.
Prepare(k) ==
  /\ k \notin s.published /\ k \notin s.prepared
  /\ s' = [s EXCEPT !.prepared = @ \cup {k}]

\* @code native/ompdesk/crates/core/src/checks/hub.rs:947-1014 write_kept accepts the source notification journal
PersistSource(k) ==
  /\ k \in s.prepared /\ k \notin s.published
  /\ s' = [s EXCEPT !.source = @ \cup {k}, !.published = @ \cup {k}]

\* @code native/ompdesk/crates/core/src/checks/hub.rs:1063-1118 sends only after the notification journal was saved
Send(k) ==
  /\ k \in s.source \* persisted-before-send
  /\ k \notin s.sent
  /\ s' = [s EXCEPT !.sent = @ \cup {k}, !.badSend = @ \/ (k \notin s.source)]

\* Receiver persistence is a separate owner contract, not the model consuming a prompt.
AcceptDisk(k) ==
  /\ k \in s.sent /\ s.adds[k] < 2
  /\ s' = [s EXCEPT !.receiver = @ \cup {k},
             !.adds[k] = IF k \in s.receiver THEN @ ELSE @ + 1, \* stable-receiver-id
             !.memory = @ \ {k}]

AcceptMemory(k) ==
  /\ k \in s.sent
  /\ s' = [s EXCEPT !.memory = @ \cup {k}, !.receipt[k] = "memory"]

SaveError(k) ==
  /\ k \in s.sent
  /\ s' = [s EXCEPT !.receipt[k] = "error"]

\* A persisted receiver can lose its response. Only its eventual Disk receipt transfers responsibility.
ReplyDisk(k) ==
  /\ k \in s.sent /\ k \in s.receiver
  /\ s' = [s EXCEPT !.receipt[k] = "disk"]

\* @code src/main/checks/result-delivery.ts:32-43 only a matching Disk receipt authorizes the source ACK
Ack(k) ==
  /\ k \in s.source /\ s.receipt[k] = "disk" \* disk-only-ack
  /\ s' = [s EXCEPT !.source = @ \ {k}, !.acked = @ \cup {k}, !.sent = @ \ {k}]

\* A lost reply or source crash clears only volatile state; the source can replay its unchanged key.
SourceCrash ==
  s' = [s EXCEPT !.prepared = {}, !.sent = {}, !.receipt = [k \in Keys |-> "none"]]

ReceiverCrash ==
  s' = [s EXCEPT !.memory = {}] \* durable-receiver-survives

\* Frozen responsibility-transfer properties. No model-read or eventual-delivery promise.
NoLossAfterPublication == s.published \subseteq s.source \cup s.receiver
DiskBeforeAck == s.acked \subseteq s.receiver
NoDuplicateReceiverAcceptance == \A k \in Keys : s.adds[k] <= 1
NoSendBeforePersistence == ~s.badSend
\* End frozen properties.

Next == SourceCrash \/ ReceiverCrash \/
  (\E k \in Keys : Prepare(k) \/ PersistSource(k) \/ Send(k) \/ AcceptDisk(k) \/
    AcceptMemory(k) \/ SaveError(k) \/ ReplyDisk(k) \/ Ack(k))
Spec == Init /\ [][Next]_vars
=============================================================================
