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
        /\ releaseFault = FALSE /\ exitFault = FALSE /\ storageFault = FALSE
        /\ stored = FALSE /\ tombstone = FALSE /\ notified = FALSE

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:138-139 Coordinator::delete begins Base's guard before capture
Begin == /\ phase = "idle"
         /\ phase' = "captured" /\ guard' = TRUE
         /\ UNCHANGED <<attached, alive, receipts, confirmed, releaseFault, exitFault,
                        storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:140-142 Coordinator::delete preflight
Preflight == /\ phase = "captured"
             /\ phase' = IF RefuseBusy /\ InitiallyBusy THEN "failed" ELSE "closing"
             /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                            exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:146-148 Host::release returns exact captured exit receipts
Release(r) == /\ phase = "closing" /\ r \in attached
              /\ attached' = attached \ {r} /\ receipts' = receipts \cup {r}
              /\ UNCHANGED <<phase, guard, alive, confirmed, releaseFault, exitFault,
                             storageFault, stored, tombstone, notified>>

\* Environment: the released runtime's actual child exits, independent of when its waiter is polled.
Exit(r) == /\ r \in receipts /\ r \in alive
           /\ alive' = alive \ {r}
           /\ UNCHANGED <<phase, guard, attached, receipts, confirmed, releaseFault,
                          exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:160-163 Coordinator::delete joins every release receipt
Confirm(r) == /\ r \in receipts /\ r \notin alive /\ r \notin confirmed
              /\ confirmed' = confirmed \cup {r}
              /\ UNCHANGED <<phase, guard, attached, alive, receipts, releaseFault,
                             exitFault, storageFault, stored, tombstone, notified>>

\* Environment: a release fails after earlier holders closed. Their receipts remain owed.
ReleaseFailed == /\ phase = "closing" /\ attached # {}
                 /\ releaseFault' = TRUE /\ phase' = "joining"
                 /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, exitFault,
                                storageFault, stored, tombstone, notified>>

\* Environment: a captured receipt rejects instead of proving process exit.
ReceiptFailed == /\ phase \in {"closing", "joining"} /\ receipts # {}
                 /\ exitFault' = TRUE /\ phase' = "failed"
                 /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                                storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:145-159 Coordinator::delete finishes all release operations
ReleasedAll == /\ phase = "closing" /\ attached = {}
               /\ phase' = "joining"
               /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                              exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:160-167 Coordinator::delete propagates a release fault after joining
JoinFailed == /\ phase = "joining" /\ releaseFault /\ confirmed = receipts
              /\ phase' = "failed"
              /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                             exitFault, storageFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:171 Coordinator::delete storage effect follows successful exact exits
Store == /\ phase = "joining" /\ ~releaseFault /\ ~exitFault
         /\ (~RequireExit \/ confirmed = Runtimes)
         /\ phase' = "stored" /\ stored' = TRUE
         /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                        exitFault, storageFault, tombstone, notified>>

StorageFailed == /\ phase = "joining" /\ ~releaseFault /\ ~exitFault /\ confirmed = Runtimes
                 /\ phase' = "failed" /\ storageFault' = TRUE
                 /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                                exitFault, stored, tombstone, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:172 Coordinator::delete commits tombstone memory, not disk acknowledgment
Commit == /\ (phase = "stored" \/ (~CommitAfterStorage /\ phase = "joining"))
          /\ tombstone' = TRUE /\ phase' = "committed"
          /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                         exitFault, storageFault, stored, notified>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:175-178 Coordinator::delete notifies only after storage and canonical commit
Notify == /\ phase = "committed"
          /\ notified' = TRUE /\ phase' = "notified"
          /\ UNCHANGED <<guard, attached, alive, receipts, confirmed, releaseFault,
                         exitFault, storageFault, stored, tombstone>>

\* @code native/ompdesk/crates/core/src/session_ops/mod.rs:137-179 Deletion guard remains alive through notification or failed cleanup
Finish == /\ phase \in {"notified", "failed"}
          /\ phase' = "done" /\ guard' = FALSE
          /\ UNCHANGED <<attached, alive, receipts, confirmed, releaseFault, exitFault,
                         storageFault, stored, tombstone, notified>>

Next == Begin \/ Preflight \/ ReleasedAll \/ JoinFailed \/ Store \/ StorageFailed
        \/ ReleaseFailed \/ ReceiptFailed \/ Commit \/ Notify \/ Finish
        \/ (\E r \in Runtimes : Release(r) \/ Exit(r) \/ Confirm(r))
Spec == Init /\ [][Next]_vars

\* FROZEN PROPERTIES
DeleteAfterConfirmedExit == stored => confirmed = Runtimes
NoFalseDeletion == tombstone => stored
NoPrematureNotice == notified => stored /\ tombstone
BusyKeepsHolders == InitiallyBusy => attached = Runtimes
GuardCoversEffects == phase \notin {"idle", "done"} => guard
NoStorageAfterExitFailure == exitFault => ~stored
\* END FROZEN PROPERTIES
=============================================================================
