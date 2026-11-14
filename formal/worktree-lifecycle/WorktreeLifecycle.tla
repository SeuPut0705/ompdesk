--------------------------- MODULE WorktreeLifecycle ---------------------------
EXTENDS Naturals, TLC
CONSTANTS BugDoubleExit, BugEarlyRemove, BugLateBind, BugSkipFingerprint,
          BugUnauthorizedCreate, BugDeadWindowQuestion, BugSkipLateRefresh, BugLoseBindError
VARIABLE s
vars == <<s>>

Init == s = [phase |-> "settings", closed |-> FALSE, quit |-> FALSE,
    created |-> FALSE, owned |-> FALSE, cleanup |-> "none", exitCount |-> 0,
    ompAlive |-> TRUE, approved |-> FALSE, changed |-> FALSE, removed |-> FALSE,
    boundAfterClose |-> FALSE, ownerLive |-> TRUE, unauthorizedCreate |-> FALSE,
    windowLive |-> TRUE, selectedWindow |-> FALSE, question |-> FALSE,
    policy |-> "remove", lastPolicy |-> "remove", prepared |-> FALSE,
    lateOwned |-> FALSE, bindingFailed |-> FALSE, waiterGone |-> FALSE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs settings
SettingsReply == /\ s.phase = "settings"
                 /\ s' = [s EXCEPT !.phase = "select"]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs target
SelectWindow == /\ s.phase = "select"
                /\ s' = [s EXCEPT !.phase = "register", !.selectedWindow = TRUE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs ask locked registration
RegisterQuestion == /\ s.phase = "register" /\ s.selectedWindow
                    /\ s' = [s EXCEPT
                        !.phase = IF s.windowLive \/ BugDeadWindowQuestion THEN "ask" ELSE "done",
                        !.question = s.windowLive \/ BugDeadWindowQuestion]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs window_closed
CloseWindow == /\ s.windowLive
               /\ s' = [s EXCEPT !.windowLive = FALSE, !.ownerLive = FALSE,
                   !.question = FALSE, !.phase = IF s.phase = "ask" THEN "done" ELSE @]

\* Environment: Base revokes the captured owner or view incarnation while its source remains connected.
RevokeOwner == /\ s.ownerLive /\ s' = [s EXCEPT !.ownerLive = FALSE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs answer
Answer(accept) == /\ s.phase = "ask" /\ s.question /\ s.windowLive
                  /\ s' = [s EXCEPT !.phase = IF accept THEN "admit" ELSE "done", !.question = FALSE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/native.rs Hooks::create
\* Base must validate owner/window/source and enqueue the stock mutation in this one admitted native step.
AdmitCreate == /\ s.phase = "admit" /\ (s.ownerLive \/ BugUnauthorizedCreate)
               /\ s' = [s EXCEPT !.phase = "create", !.unauthorizedCreate = ~s.ownerLive]
RejectCreate == /\ s.phase = "admit" /\ ~s.ownerLive /\ ~BugUnauthorizedCreate
                /\ s' = [s EXCEPT !.phase = "done"]

\* Environment: dropping the start waiter never drops an admitted stock effect.
DropWaiter == /\ ~s.waiterGone /\ s' = [s EXCEPT !.waiterGone = TRUE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs start_inner create completion
CreateReply == /\ s.phase = "create"
               /\ s' = [s EXCEPT !.created = TRUE, !.cleanup = "start", !.phase = "bind"]

\* Environment: the hub refuses binding or reports an error while the canonical source can still exit later.
BindFails == /\ s.phase = "bind" /\ ~s.bindingFailed
             /\ s' = [s EXCEPT !.bindingFailed = TRUE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs start_inner Completion
BindReply == /\ s.phase = "bind"
             /\ s' = [s EXCEPT !.phase = "owned",
                 !.owned = ((~s.closed) \/ BugLateBind) /\ ~(BugLoseBindError /\ s.bindingFailed),
                 !.boundAfterClose = s.closed /\ BugLateBind,
                 !.cleanup = IF s.closed THEN "close" ELSE "none",
                 !.exitCount = IF s.closed THEN @ + 1 ELSE @,
                 !.lateOwned = s.quit]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs released
Close == /\ ~s.closed
         /\ s' = [s EXCEPT !.closed = TRUE, !.owned = FALSE, !.question = FALSE,
             !.phase = IF s.phase \in {"settings", "select", "register", "ask", "admit"} THEN "done" ELSE @,
             !.cleanup = IF s.owned THEN "close" ELSE @,
             !.exitCount = IF s.owned THEN @ + 1 ELSE @]

\* Environment: the live setting changes before quit's final policy read.
ChangePolicy == /\ ~s.closed /\ ~s.prepared /\ s.policy = "remove"
                /\ s' = [s EXCEPT !.policy = "keep"]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs finalize
QuitBegin == /\ ~s.quit
             /\ s' = [s EXCEPT !.quit = TRUE, !.question = FALSE,
                 !.phase = IF s.phase \in {"settings", "select", "register", "ask", "admit"} THEN "done" ELSE @]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs finalize_one and refresh_owned
RefreshQuit == /\ s.quit /\ s.created /\ s.owned /\ ~s.prepared
               /\ s' = [s EXCEPT !.prepared = TRUE,
                   !.lastPolicy = IF BugSkipLateRefresh /\ s.lateOwned THEN @ ELSE s.policy]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs finalize_one identity take
QuitTake == /\ s.quit /\ s.created
            /\ ((s.owned /\ s.prepared) \/ (BugDoubleExit /\ s.cleanup = "close"))
            /\ s' = [s EXCEPT !.cleanup = "quit", !.owned = FALSE, !.exitCount = @ + 1]

\* Environment: only the exact captured disposed omp's exit fulfills the receipt.
OmpExited == /\ s.ompAlive /\ s' = [s EXCEPT !.ompAlive = FALSE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs plan
Approve == /\ s.cleanup \in {"close", "quit"} /\ s.lastPolicy = "remove" /\ ~s.approved /\ ~s.removed
           /\ s' = [s EXCEPT !.approved = TRUE]

\* Environment: another process edits files or refs after the approved snapshot.
Edit == /\ s.approved /\ ~s.changed /\ ~s.removed
        /\ s' = [s EXCEPT !.changed = TRUE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/mod.rs exit
Remove == /\ s.cleanup \in {"close", "quit"} /\ s.approved /\ ~s.removed
          /\ (~s.ompAlive \/ BugEarlyRemove) /\ (~s.changed \/ BugSkipFingerprint)
          /\ s' = [s EXCEPT !.removed = TRUE]

Next == SettingsReply \/ SelectWindow \/ RegisterQuestion \/ CloseWindow \/ RevokeOwner
        \/ (\E accept \in BOOLEAN : Answer(accept)) \/ AdmitCreate \/ RejectCreate
        \/ DropWaiter \/ CreateReply \/ BindFails \/ BindReply \/ Close \/ ChangePolicy
        \/ QuitBegin \/ RefreshQuit \/ QuitTake \/ OmpExited \/ Approve \/ Edit \/ Remove
Spec == Init /\ [][Next]_vars

\* Frozen protocol properties. The additional properties correspond to Main's four independent review paths.
SingleCleanupOwner == s.exitCount <= 1
NoBindAfterClose == ~s.boundAfterClose
NoRemoveWhileOmpAlive == s.removed => ~s.ompAlive
OnlyApprovedFingerprint == s.removed => (s.approved /\ ~s.changed)
NoLostCreatedWorktree == s.created => (s.owned \/ s.cleanup \in {"close", "quit"}
                                     \/ (s.phase = "bind" /\ s.cleanup = "start"))
NoUnauthorizedCreate == ~s.unauthorizedCreate
NoUnanswerableQuestion == s.question => s.windowLive
QuitUsesFinalPolicy == (s.cleanup = "quit" /\ s.removed) => (s.prepared /\ s.lastPolicy = s.policy)
=============================================================================
