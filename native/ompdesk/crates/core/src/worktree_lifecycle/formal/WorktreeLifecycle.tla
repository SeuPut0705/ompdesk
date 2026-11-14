--------------------------- MODULE WorktreeLifecycle ---------------------------
EXTENDS Naturals, TLC
CONSTANTS BugDoubleExit, BugEarlyRemove, BugLateBind, BugSkipFingerprint
VARIABLES phase, closed, quit, created, owned, cleanup, exitCount, ompAlive,
          approved, changed, removed, boundAfterClose, settingsReady, accepted,
          waiterGone
vars == <<phase, closed, quit, created, owned, cleanup, exitCount, ompAlive,
          approved, changed, removed, boundAfterClose, settingsReady, accepted,
          waiterGone>>

Init == /\ phase = "settings" /\ ~closed /\ ~quit /\ ~created /\ ~owned
        /\ cleanup = "none" /\ exitCount = 0 /\ ompAlive /\ ~approved
        /\ ~changed /\ ~removed /\ ~boundAfterClose /\ ~settingsReady
        /\ ~accepted /\ ~waiterGone

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs settings
SettingsReply == /\ phase = "settings" /\ ~settingsReady
                 /\ settingsReady' = TRUE /\ phase' = IF closed THEN "done" ELSE "ask"
                 /\ UNCHANGED <<closed, quit, created, owned, cleanup, exitCount,
                     ompAlive, approved, changed, removed, boundAfterClose, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs ask/answer
Answer == /\ phase = "ask" /\ ~closed
          /\ accepted' \in BOOLEAN /\ phase' = IF accepted' THEN "create" ELSE "done"
          /\ UNCHANGED <<closed, quit, created, owned, cleanup, exitCount, ompAlive,
              approved, changed, removed, boundAfterClose, settingsReady, waiterGone>>

\* Environment: the start gate waiter can disappear without stopping stock's effect.
DropWaiter == /\ ~waiterGone /\ waiterGone' = TRUE
              /\ UNCHANGED <<phase, closed, quit, created, owned, cleanup, exitCount,
                  ompAlive, approved, changed, removed, boundAfterClose, settingsReady, accepted>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs start_inner create completion
CreateReply == /\ phase = "create" /\ ~created
               /\ created' = TRUE /\ cleanup' = "start" /\ phase' = "bind"
               /\ UNCHANGED <<closed, quit, owned, exitCount, ompAlive, approved,
                   changed, removed, boundAfterClose, settingsReady, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs start_inner hub bind await and publication
BindReply == /\ phase = "bind"
             /\ owned' = (~closed /\ ~quit) \/ BugLateBind
             /\ boundAfterClose' = closed /\ BugLateBind
             /\ cleanup' = IF closed THEN "close" ELSE IF quit THEN "quit" ELSE "none"
             /\ exitCount' = IF closed \/ quit THEN exitCount + 1 ELSE exitCount
             /\ phase' = "owned"
             /\ UNCHANGED <<closed, quit, created, ompAlive, approved, changed,
                 removed, settingsReady, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs released
Close == /\ ~closed /\ closed' = TRUE
         /\ phase' = IF phase \in {"settings", "ask"} THEN "done" ELSE phase
         /\ cleanup' = IF owned THEN "close" ELSE cleanup
         /\ exitCount' = IF owned THEN exitCount + 1 ELSE exitCount
         /\ owned' = FALSE
         /\ UNCHANGED <<quit, created, ompAlive, approved, changed, removed,
             boundAfterClose, settingsReady, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs finalize
QuitPrepare == /\ ~quit /\ quit' = TRUE
               /\ UNCHANGED <<phase, closed, created, owned, cleanup, exitCount,
                   ompAlive, approved, changed, removed, boundAfterClose,
                   settingsReady, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs finalize identity take
QuitTake == /\ quit /\ created /\ (owned \/ BugDoubleExit /\ cleanup = "close")
            /\ cleanup' = "quit" /\ owned' = FALSE /\ exitCount' = exitCount + 1
            /\ UNCHANGED <<phase, closed, quit, created, ompAlive, approved, changed,
                removed, boundAfterClose, settingsReady, accepted, waiterGone>>

\* Environment: the exact disposed omp exits, not a later lookup of a tab's replacement.
OmpExited == /\ ompAlive /\ ompAlive' = FALSE
             /\ UNCHANGED <<phase, closed, quit, created, owned, cleanup, exitCount,
                 approved, changed, removed, boundAfterClose, settingsReady, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs plan
Approve == /\ cleanup \in {"close", "quit"} /\ ~approved /\ ~removed
           /\ approved' = TRUE
           /\ UNCHANGED <<phase, closed, quit, created, owned, cleanup, exitCount,
               ompAlive, changed, removed, boundAfterClose, settingsReady, accepted, waiterGone>>

\* Environment: a user or another process changes files/refs after the approved snapshot.
Edit == /\ approved /\ ~changed /\ ~removed /\ changed' = TRUE
        /\ UNCHANGED <<phase, closed, quit, created, owned, cleanup, exitCount,
            ompAlive, approved, removed, boundAfterClose, settingsReady, accepted, waiterGone>>

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs exit
Remove == /\ cleanup \in {"close", "quit"} /\ approved /\ ~removed
          /\ (~ompAlive \/ BugEarlyRemove) /\ (~changed \/ BugSkipFingerprint)
          /\ removed' = TRUE
          /\ UNCHANGED <<phase, closed, quit, created, owned, cleanup, exitCount,
              ompAlive, approved, changed, boundAfterClose, settingsReady, accepted, waiterGone>>

Next == SettingsReply \/ Answer \/ DropWaiter \/ CreateReply \/ Close \/ QuitPrepare
        \/ BindReply \/ QuitTake \/ OmpExited \/ Approve \/ Edit \/ Remove
Spec == Init /\ [][Next]_vars

\* Frozen properties, derived from TS WorktreeLifecycle.startGate/released/finalize/#remove.
SingleCleanupOwner == exitCount <= 1
NoBindAfterClose == ~boundAfterClose
NoRemoveWhileOmpAlive == removed => ~ompAlive
OnlyApprovedFingerprint == removed => approved /\ ~changed
NoLostCreatedWorktree == created => owned \/ cleanup \in {"close", "quit"}
                                  \/ (phase = "bind" /\ cleanup = "start")
=============================================================================
