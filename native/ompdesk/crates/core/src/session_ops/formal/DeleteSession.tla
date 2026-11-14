---------------------------- MODULE DeleteSession ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Runtimes, InitiallyBusy, RequireExit, RefuseBusy, CommitAfterStorage
VARIABLES phase, guard, attached, alive, receipts, confirmed, releaseFault,
          exitFault, storageFault, stored, tombstone, notified
vars == <<phase, guard, attached, alive, receipts, confirmed, releaseFault,
          exitFault, storageFault, stored, tombstone, notified>>

Init == /\ phase = "idle" /\ guard = FALSE
        /\ attached = Runtimes /\ alive = Runtimes
        /\ receipts = {} /\ confirmed = {}
        /\ releaseFault = FALSE /\ exitFault = {} /\ storageFault = FALSE
        /\ stored = FALSE /\ tombstone = FALSE /\ notified = FALSE

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:163-169 Coordinator::delete awaits Base's scoped guard before capture
Begin == /\ phase = "idle"
         /\ phase' = "captured" /\ guard' = TRUE
         /\ UNCHANGED <<attached, alive, receipts, confirmed, releaseFault, exitFault,
                        storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:173-175 Coordinator::delete preflight
Preflight == /\ phase = "captured"
             /\ phase' = IF RefuseBusy /\ InitiallyBusy THEN "failed" ELSE "closing"
             /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                            exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:183-186 Host::release returns captured exit receipts or joins them internally
Release(r) == /\ phase = "closing" /\ r \in attached
              /\ attached' = attached \ {r} /\ receipts' = receipts \cup {r}
              /\ UNCHANGED <<phase, guard, alive, confirmed, releaseFault, exitFault,
                             storageFault, stored, tombstone, notified>>

\* Environment: the released runtime's actual child exits, independent of when its waiter is polled.
Exit(r) == /\ r \in receipts /\ r \in alive
           /\ alive' = alive \ {r}
           /\ UNCHANGED <<phase, guard, attached, receipts, confirmed, releaseFault,
                          exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:197-201 Coordinator::delete joins every release receipt
Confirm(r) == /\ phase = "joining" /\ r \in receipts /\ r \notin alive
              /\ r \notin confirmed /\ r \notin exitFault
              /\ confirmed' = confirmed \cup {r}
              /\ UNCHANGED <<phase, guard, attached, alive, receipts, releaseFault,
                             exitFault, storageFault, stored, tombstone, notified>>

\* Environment: a release fails after earlier holders closed. Their receipts remain owed.
ReleaseFailed == /\ phase = "closing" /\ attached # {}
                 /\ releaseFault' = TRUE /\ phase' = "joining"
                 /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, exitFault,
                                storageFault, stored, tombstone, notified>>

\* Environment: one captured receipt rejects. Other receipts remain owed, and a rejection never proves exit.
ReceiptFailed(r) == /\ phase = "joining" /\ r \in receipts
                    /\ r \notin confirmed /\ r \notin exitFault
                    /\ exitFault' = exitFault \cup {r}
                    /\ UNCHANGED <<phase, guard, attached, alive, receipts, confirmed, releaseFault,
                                   storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:178-196 Coordinator::delete finishes release operations
ReleasedAll == /\ phase = "closing" /\ attached = {}
               /\ phase' = "joining"
               /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                              exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:197-204 Coordinator::delete propagates faults only after every owed receipt settles
JoinFailed == /\ phase = "joining" /\ (releaseFault \/ exitFault # {})
              /\ confirmed \cup exitFault = receipts
              /\ phase' = "failed"
              /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                             exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:208 Coordinator::delete storage effect follows successful exact exits
Store == /\ phase = "joining" /\ ~releaseFault /\ exitFault = {}
         /\ (~RequireExit \/ confirmed = Runtimes)
         /\ phase' = "stored" /\ stored' = TRUE
         /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                        exitFault, storageFault, tombstone, notified>>

StorageFailed == /\ phase = "joining" /\ ~releaseFault /\ exitFault = {} /\ confirmed = Runtimes
                 /\ phase' = "failed" /\ storageFault' = TRUE
                 /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                                exitFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:209 Coordinator::delete commits tombstone memory, not disk acknowledgment
Commit == /\ (phase = "stored" \/ (~CommitAfterStorage /\ phase = "joining"))
          /\ tombstone' = TRUE /\ phase' = "committed"
          /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                         exitFault, storageFault, stored, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:217-220 Coordinator::delete invalidates and notifies after canonical commit
Notify == /\ phase = "committed"
          /\ notified' = TRUE /\ phase' = "notified"
          /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                         exitFault, storageFault, stored, tombstone>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:150-159 The owned domain task and exact Scope retain the guard through effects
Finish == /\ phase \in {"notified", "failed"}
          /\ phase' = "done" /\ guard' = FALSE
          /\ UNCHANGED <<attached, alive, receipts, confirmed, releaseFault, exitFault,
                         storageFault, stored, tombstone, notified>>

Next == Begin \/ Preflight \/ ReleasedAll \/ JoinFailed \/ Store \/ StorageFailed
        \/ ReleaseFailed \/ Commit \/ Notify \/ Finish
        \/ (\E r \in Runtimes : Release(r) \/ Exit(r) \/ Confirm(r) \/ ReceiptFailed(r))
Spec == Init /\ [][Next]_vars

\* FROZEN PROPERTIES
DeleteAfterConfirmedExit == stored => confirmed = Runtimes
NoFalseDeletion == tombstone => stored
NoPrematureNotice == notified => stored /\ tombstone
BusyKeepsHolders == InitiallyBusy => attached = Runtimes
GuardCoversEffects == phase \notin {"idle", "done"} => guard
NoStorageAfterExitFailure == exitFault # {} => ~stored
\* END FROZEN PROPERTIES
=============================================================================
