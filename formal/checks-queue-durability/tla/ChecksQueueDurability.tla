-------------------- MODULE ChecksQueueDurability --------------------
EXTENDS Integers, FiniteSets

VARIABLES mem, disk, kept, memOut, diskOut, keptOut, stopped, ack, effects, active, draining,
          receipt, memRetire, diskRetire, keptRetire
vars == <<mem, disk, kept, memOut, diskOut, keptOut, stopped, ack, effects, active, draining,
          receipt, memRetire, diskRetire, keptRetire>>

Init ==
    /\ mem = 0 /\ disk = 0 /\ kept = -1
    /\ memOut = {} /\ diskOut = {} /\ keptOut = {}
    /\ stopped = FALSE /\ ack = FALSE /\ effects = {} /\ active = FALSE /\ draining = FALSE
    /\ receipt = FALSE /\ memRetire = FALSE /\ diskRetire = FALSE /\ keptRetire = FALSE

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:484-614 Lane::take applies one message
Enqueue ==
    /\ ~stopped /\ mem = 0 /\ disk = 0
    /\ mem' = 1 /\ memOut' = {1}
    /\ UNCHANGED <<disk, kept, diskOut, keptOut, stopped, ack, effects, active, draining,
                   receipt, memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:484-614 Lane::take records a completed trial
Complete ==
    /\ ~stopped /\ mem = 1 /\ disk = 1 /\ 1 \in effects
    /\ mem' = 2 /\ memOut' = (memOut \ {1}) \cup {2} /\ active' = FALSE
    /\ UNCHANGED <<disk, kept, diskOut, keptOut, stopped, ack, effects, draining,
                   receipt, memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:630-661 Lane::after waits for save success
Save ==
    /\ ~stopped /\ (mem # disk \/ memOut # diskOut \/ memRetire # diskRetire \/ kept # -1)
    /\ disk' = mem /\ diskOut' = memOut /\ diskRetire' = memRetire
    /\ kept' = -1 /\ keptOut' = {} /\ keptRetire' = FALSE
    /\ UNCHANGED <<mem, memOut, memRetire, stopped, ack, effects, active, draining, receipt>>

\* @code native/ompdesk/crates/core/src/disk/saves.rs:94-118 ENOSPC retains the failed write
SaveFull ==
    /\ ~stopped /\ (mem # disk \/ memOut # diskOut \/ memRetire # diskRetire)
    /\ kept' = mem /\ keptOut' = memOut /\ keptRetire' = memRetire
    /\ UNCHANGED <<mem, disk, memOut, diskOut, memRetire, diskRetire,
                   stopped, ack, effects, active, draining, receipt>>

\* @code native/ompdesk/crates/core/src/disk/saves.rs:121-148 deferred retained writes share the writer lock
DeferredSave ==
    /\ kept # -1
    /\ disk' = kept /\ diskOut' = keptOut /\ diskRetire' = keptRetire
    /\ kept' = -1 /\ keptOut' = {} /\ keptRetire' = FALSE
    /\ UNCHANGED <<mem, memOut, memRetire, stopped, ack, effects, active, draining, receipt>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:630-661 Lane::after starts effects and answers
Effect ==
    /\ ~stopped /\ mem > 0 /\ mem = disk /\ mem \in memOut /\ mem \in diskOut /\ mem \notin effects
    /\ effects' = effects \cup {mem} /\ active' = TRUE
    /\ receipt' = IF mem = 2 THEN TRUE ELSE receipt
    /\ UNCHANGED <<mem, disk, kept, memOut, diskOut, keptOut, stopped, ack, draining,
                   memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:484-614 Lane::take removes accepted effects
TellDone ==
    /\ ~stopped /\ mem = 2 /\ 2 \in memOut /\ 2 \in effects
    /\ memOut' = memOut \ {2} /\ memRetire' = TRUE /\ active' = FALSE
    /\ UNCHANGED <<mem, disk, kept, diskOut, keptOut, stopped, ack, effects, draining,
                   receipt, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:683-705 Lane::retire_answer
Retire ==
    /\ ~stopped /\ diskRetire /\ 2 \notin diskOut /\ receipt
    /\ receipt' = FALSE
    /\ UNCHANGED <<mem, disk, kept, memOut, diskOut, keptOut, stopped, ack, effects, active, draining,
                   memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:484-614 Lane::take removes a retired receipt
RetireDone ==
    /\ ~stopped /\ memRetire /\ diskRetire /\ ~receipt
    /\ memRetire' = FALSE
    /\ UNCHANGED <<mem, disk, kept, memOut, diskOut, keptOut, stopped, ack, effects, active, draining,
                   receipt, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:630-661 Lane::after answers an enqueue
Ack ==
    /\ ~stopped /\ mem > 0 /\ mem = disk /\ ~ack
    /\ ack' = TRUE
    /\ UNCHANGED <<mem, disk, kept, memOut, diskOut, keptOut, stopped, effects, active, draining,
                   receipt, memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:421-481 cancellation ends the lane
Stop ==
    /\ ~stopped
    /\ stopped' = TRUE /\ draining' = active
    /\ UNCHANGED <<mem, disk, kept, memOut, diskOut, keptOut, ack, effects, active,
                   receipt, memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:421-481 stopped lanes await candidate tasks
Drain ==
    /\ stopped /\ draining
    /\ active' = FALSE /\ draining' = FALSE
    /\ UNCHANGED <<mem, disk, kept, memOut, diskOut, keptOut, stopped, ack, effects,
                   receipt, memRetire, diskRetire, keptRetire>>

\* @code native/ompdesk/crates/core/src/checks/queue_run.rs:245-255 saved lanes start again
Reopen ==
    /\ stopped /\ ~draining
    /\ stopped' = FALSE /\ mem' = disk /\ memOut' = diskOut /\ memRetire' = diskRetire
    /\ UNCHANGED <<disk, kept, diskOut, keptOut, ack, effects, active, draining,
                   receipt, diskRetire, keptRetire>>

Next == Enqueue \/ Complete \/ Save \/ SaveFull \/ DeferredSave \/ Effect \/ TellDone \/ Retire \/
        RetireDone \/ Ack \/ Stop \/ Drain \/ Reopen
Spec == Init /\ [][Next]_vars

(* ---- BEGIN FROZEN PROPERTIES ---- *)
TypeOK == /\ mem \in 0..2 /\ disk \in 0..2 /\ kept \in {-1, 0, 1, 2}
          /\ stopped \in BOOLEAN /\ ack \in BOOLEAN /\ effects \subseteq 1..2
          /\ memOut \subseteq 1..2 /\ diskOut \subseteq 1..2 /\ keptOut \subseteq 1..2
          /\ active \in BOOLEAN /\ draining \in BOOLEAN
          /\ receipt \in BOOLEAN /\ memRetire \in BOOLEAN /\ diskRetire \in BOOLEAN /\ keptRetire \in BOOLEAN
AckDurable == ack => disk >= 1
EffectsDurable == \A v \in effects : v <= disk
NoLostTell == disk = 2 => 2 \in diskOut \/ 2 \in effects
NoOverlappingOwners == draining => stopped
ReceiptCoversReplay == (2 \in effects /\ 2 \in diskOut) => receipt
(* ---- END FROZEN PROPERTIES ---- *)

NeverEffect == effects = {}
NeverAck == ~ack
=============================================================================
