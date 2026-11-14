--------------------------- MODULE ManualPolicy ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS BugSplitClaim, BugAllowOpen, BugEarlyRelease, BugDropPrior, BugClearPrior,
          BugSkipCommit, BugUnlockRetry, VersionCount
Versions == 1..VersionCount
VARIABLE s
vars == <<s>>

RECURSIVE Live(_, _)
Live(q, alive) == IF Len(q) = 0 THEN <<>>
                 ELSE IF alive[Head(q)] THEN <<Head(q)>> \o Live(Tail(q), alive)
                 ELSE Live(Tail(q), alive)
Range(q) == {q[i] : i \in 1..Len(q)}
Current(q, alive) == LET live == Live(q, alive)
                    IN IF Len(live) = 0 THEN 0 ELSE live[Len(live)]

Init == s = [open |-> FALSE, claim |-> FALSE, selected |-> FALSE,
             snapshotOpen |-> FALSE, overlap |-> FALSE,
             alive |-> [v \in Versions |-> TRUE], next |-> 1,
             pending |-> <<>>, accepted |-> <<>>, disk |-> 0,
             busy |-> "none", writing |-> 0, epoch |-> 0, capturedEpoch |-> 0,
             removed |-> FALSE, cancelledCommit |-> FALSE, staleCommit |-> FALSE,
             effect |-> FALSE]

\* Environment: a tab requests a local folder while removal may own it.
Open == /\ ~s.open /\ (~s.claim \/ BugAllowOpen)
        /\ s' = [s EXCEPT !.open = TRUE, !.overlap = @ \/ s.claim \/ s.effect]
Close == /\ s.open /\ s' = [s EXCEPT !.open = FALSE]

\* @code native/ompdesk/crates/core/src/worktree_lifecycle/manual/orphans.rs:72-74 listing can yield
SelectFolders == /\ ~s.selected
                 /\ s' = [s EXCEPT !.selected = TRUE, !.snapshotOpen = s.open]
\* @code native/ompdesk/crates/core/src/worktree_lifecycle/claims.rs:66-76 try_claim
\* The current-folder read and this policy call must be ONE Base hub admission.
Claim == /\ s.selected /\ ~s.claim
         /\ (IF BugSplitClaim THEN ~s.snapshotOpen ELSE ~s.open)
         /\ s' = [s EXCEPT !.claim = TRUE, !.overlap = @ \/ s.open]
\* @code native/ompdesk/crates/core/src/worktree_lifecycle/claims.rs:80-82 RemovalGuard::drop
Release == /\ s.claim /\ (~s.effect \/ BugEarlyRelease)
           /\ s' = [s EXCEPT !.claim = FALSE, !.selected = FALSE]
\* @code native/ompdesk/crates/core/src/worktree_lifecycle/manual/orphans.rs:92-110 retained claim through all effects
BeginEffect == /\ s.claim /\ ~s.effect /\ s' = [s EXCEPT !.effect = TRUE]
\* @code native/ompdesk/crates/core/src/worktree_lifecycle/manual/orphans.rs:98-110 actual effects complete before guard drop
EndEffect == /\ s.effect /\ s' = [s EXCEPT !.effect = FALSE]

\* Environment: cancellation does not acquire the Saves mutex.
Cancel(v) == /\ s.alive[v] /\ s' = [s EXCEPT !.alive[v] = FALSE]

\* @code native/ompdesk/crates/core/src/disk/saves.rs:124-154 Saves::write_if
BeginWrite == /\ s.busy = "none" /\ s.next \in Versions /\ s.alive[s.next]
              /\ s' = [s EXCEPT !.busy = "write", !.writing = s.next,
                                 !.next = @ + 1, !.capturedEpoch = s.epoch]
\* A quota result is accepted desired state only while its predicate still admits it.
QuotaWrite == /\ s.busy = "write"
              /\ LET admitted == s.alive[s.writing]
                     prior == IF BugDropPrior THEN <<>> ELSE s.pending
                 IN s' = [s EXCEPT
                     !.pending = IF admitted THEN Append(prior, s.writing) ELSE @,
                     !.accepted = IF admitted THEN Append(@, s.writing) ELSE @,
                     !.busy = "none"]
\* A new non-quota failure is NOT an accepted mutation.
FailedWrite == /\ s.busy = "write"
               /\ s' = [s EXCEPT !.pending = IF BugClearPrior THEN <<>> ELSE @,
                                  !.busy = "none"]

\* @code native/ompdesk/crates/core/src/disk/saves.rs:191-211 Saves::retry_once
\* pending also denotes the stack temporarily held on the locked retry's stack.
BeginRetry == /\ s.busy = "none" /\ Current(s.pending, s.alive) # 0
              /\ s' = [s EXCEPT !.busy = "retry",
                  !.writing = Current(s.pending, s.alive), !.capturedEpoch = s.epoch]
RetryBlocked == /\ s.busy = "retry" /\ s.alive[s.writing]
                /\ s' = [s EXCEPT !.busy = "none"]
RetryCancelled == /\ s.busy = "retry" /\ ~s.alive[s.writing]
                  /\ s' = [s EXCEPT !.pending = Live(@, s.alive), !.busy = "none"]
WriteCancelled == /\ s.busy = "write" /\ ~s.alive[s.writing]
                  /\ s' = [s EXCEPT !.busy = "none"]

\* @code native/ompdesk/crates/core/src/disk/tree.rs:294-299 write_atomic_if rename fence
Commit == /\ s.busy \in {"write", "retry"}
          /\ (s.alive[s.writing] \/ BugSkipCommit)
          /\ s' = [s EXCEPT !.disk = s.writing, !.pending = <<>>, !.accepted = <<>>,
              !.busy = "none", !.cancelledCommit = @ \/ ~s.alive[s.writing],
              !.staleCommit = @ \/ (s.capturedEpoch # s.epoch)]

\* @code native/ompdesk/crates/core/src/disk/saves.rs:156-174 Saves::remove
Remove == /\ ~s.removed /\ (s.busy = "none" \/ (BugUnlockRetry /\ s.busy = "retry"))
          /\ s' = [s EXCEPT !.disk = 0, !.pending = <<>>, !.accepted = <<>>,
                             !.removed = TRUE, !.epoch = 1]
Next == Open \/ Close \/ SelectFolders \/ Claim \/ Release \/ BeginEffect \/ EndEffect \/ BeginWrite
        \/ QuotaWrite \/ FailedWrite \/ BeginRetry \/ RetryBlocked
        \/ RetryCancelled \/ WriteCancelled \/ Commit \/ Remove
        \/ (\E v \in Versions : Cancel(v))
Spec == Init /\ [][Next]_vars

\* BEGIN FROZEN PROTOCOL PROPERTIES
NoOpenDuringRemoval == ~s.overlap
NoCancelledCommit == ~s.cancelledCommit
NoRetryAfterRemoval == ~s.staleCommit
AcceptedPendingIsRetained == Range(Live(s.accepted, s.alive)) \subseteq Range(s.pending)
\* END FROZEN PROTOCOL PROPERTIES

TypeOK == /\ s.open \in BOOLEAN /\ s.claim \in BOOLEAN /\ s.overlap \in BOOLEAN
          /\ s.alive \in [Versions -> BOOLEAN] /\ s.next \in 1..(VersionCount + 1)
          /\ s.pending \in Seq(Versions) /\ s.accepted \in Seq(Versions)
          /\ s.disk \in (Versions \cup {0}) /\ s.writing \in (Versions \cup {0})
          /\ s.busy \in {"none", "write", "retry"} /\ s.epoch \in {0, 1}
=============================================================================
