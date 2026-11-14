--------------------------- MODULE SessionOwnership ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Sessions, Tags, OwnerIds, MaxLaunches
Kinds == {"local", "hosted"}
Owners == Sessions \X Kinds \X OwnerIds
None == "none"

VARIABLES app, frozen, launches, tab, held, state, session, kind, owner,
          used, alive, inflight, allowed, saved, keep, swept, queue,
          grace, exited, retries, retryUsed, failed, tookOver, retired
vars == <<app, frozen, launches, tab, held, state, session, kind, owner,
          used, alive, inflight, allowed, saved, keep, swept, queue,
          grace, exited, retries, retryUsed, failed, tookOver, retired>>

TypeOK ==
    /\ app \in {"up", "down"} /\ frozen \in BOOLEAN
    /\ launches \in 1..MaxLaunches
    /\ tab \in [Owners -> {"closed", "restored", "started"}]
    /\ held \in [Owners -> Tags \cup {None}]
    /\ state \in [Tags -> {"free", "left", "live", "closing", "ending"}]
    /\ session \in [Tags -> Sessions \cup {None}]
    /\ kind \in [Tags -> Kinds \cup {None}]
    /\ owner \in [Tags -> Owners \cup {None}]
    /\ used \subseteq Tags /\ alive \subseteq Tags /\ inflight \subseteq Tags
    /\ allowed \subseteq Tags /\ saved \subseteq Owners /\ keep \subseteq Sessions
    /\ swept \in BOOLEAN /\ queue \subseteq Tags /\ grace \in BOOLEAN
    /\ exited \subseteq Tags /\ retries \subseteq Tags /\ retryUsed \subseteq Tags
    /\ failed \in BOOLEAN /\ tookOver \in BOOLEAN
    /\ retired \subseteq Owners

Init ==
    /\ app = "up" /\ frozen = FALSE /\ launches = 1
    /\ tab = [o \in Owners |-> "closed"] /\ held = [o \in Owners |-> None]
    /\ state = [t \in Tags |-> "free"]
    /\ session = [t \in Tags |-> None] /\ kind = [t \in Tags |-> None]
    /\ owner = [t \in Tags |-> None] /\ used = {} /\ alive = {}
    /\ inflight = {} /\ allowed = {} /\ saved = {} /\ keep = {}
    /\ swept = TRUE /\ queue = {} /\ grace = FALSE /\ exited = {}
    /\ retries = {} /\ retryUsed = {} /\ failed = FALSE /\ tookOver = FALSE /\ retired = {}

LeftOf(o) == {t \in Tags : state[t] = "left" /\ session[t] = o[1] /\ kind[t] = o[2]}
HostedHeld(t) == \E o \in Owners : o[1] = session[t] /\ o[2] = "hosted" /\ tab[o] # "closed"
LocalTarget(t) == state[t] = "left" /\ kind[t] = "local" /\ session[t] \notin keep
HostedTarget(t) == state[t] = "left" /\ kind[t] = "hosted" /\ ~HostedHeld(t)
RetryEligible(t) == state[t] = "left"

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:99-155 acquire, takeover, fresh tag, journal
Open(o) ==
    /\ app = "up" /\ ~frozen /\ tab[o] \in {"closed", "restored"} /\ o \notin retired
    /\ ~\E other \in Owners : other # o /\ other[1] = o[1] /\ other[2] = o[2] /\ tab[other] # "closed"
    /\ \/ /\ LeftOf(o) # {}
          /\ \E t \in LeftOf(o) :
                /\ state' = [state EXCEPT ![t] = "live"]
                /\ owner' = [owner EXCEPT ![t] = o]
                /\ held' = [held EXCEPT ![o] = t]
                /\ allowed' = allowed \ {t}
          /\ tookOver' = TRUE
          /\ UNCHANGED <<session, kind, used>>
       \/ /\ LeftOf(o) = {}
          /\ \E t \in Tags \ used :
                /\ state' = [state EXCEPT ![t] = "live"]
                /\ owner' = [owner EXCEPT ![t] = o]
                /\ session' = [session EXCEPT ![t] = o[1]]
                /\ kind' = [kind EXCEPT ![t] = o[2]]
                /\ used' = used \cup {t}
                /\ held' = [held EXCEPT ![o] = t]
          /\ UNCHANGED <<allowed, tookOver>>
    /\ tab' = [tab EXCEPT ![o] = "started"]
    /\ UNCHANGED <<app, frozen, launches, alive, inflight, saved, keep, swept,
                   queue, grace, exited, retries, retryUsed, failed, retired>>

\* The spawned omp or a descendant inherits the tag.
Spawn(o) ==
    /\ app = "up" /\ tab[o] = "started"
    /\ alive' = alive \cup {held[o]}
    /\ UNCHANGED <<app, frozen, launches, tab, held, state, session, kind, owner,
                   used, inflight, allowed, saved, keep, swept, queue, grace,
                   exited, retries, retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/sidecar/lane.rs:2056-2078 dispose and when_all_exited
\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:190-201 closing
\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:310-338 session_released, abstracted as a queue
Dispose(o) ==
    /\ app = "up" /\ tab[o] # "closed"
    /\ LET own == IF tab[o] = "started" THEN {held[o]} ELSE {}
           left == IF frozen THEN {} ELSE LeftOf(o)
       IN /\ state' = [t \in Tags |-> IF t \in own THEN "closing" ELSE state[t]]
          /\ allowed' = IF frozen THEN allowed ELSE allowed \cup own \cup left
          /\ queue' = queue \cup left
          /\ exited' = exited \ own
    /\ tab' = [tab EXCEPT ![o] = "closed"]
    /\ retired' = retired \cup {o}
    /\ held' = [held EXCEPT ![o] = None]
    /\ keep' = IF o[2] = "local" THEN keep \ {o[1]} ELSE keep
    /\ UNCHANGED <<app, frozen, launches, session, kind, owner, used, alive,
                   inflight, saved, swept, grace, retries, retryUsed, failed, tookOver>>


\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:190-201 closing before acquire
CloseBeforeAcquire(o) ==
    /\ app = "up" /\ tab[o] = "closed" /\ o \notin retired
    /\ retired' = retired \cup {o}
    /\ UNCHANGED <<app, frozen, launches, tab, held, state, session, kind, owner,
                   used, alive, inflight, allowed, saved, keep, swept, queue, grace,
                   exited, retries, retryUsed, failed, tookOver>>
\* The host reports that all omps stopped by dispose have exited.
Exited(t) ==
    /\ app = "up" /\ state[t] = "closing" /\ t \notin exited
    /\ exited' = exited \cup {t}
    /\ UNCHANGED <<app, frozen, launches, tab, held, state, session, kind, owner,
                   used, alive, inflight, allowed, saved, keep, swept, queue,
                   grace, retries, retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:204-224 released after Base joins the receipt
CloseAfterExit(t) ==
    /\ app = "up" /\ ~frozen /\ state[t] = "closing" /\ t \in exited
    /\ state' = [state EXCEPT ![t] = "ending"]
    /\ inflight' = inflight \cup {t}
    /\ UNCHANGED exited
    /\ UNCHANGED <<app, frozen, launches, tab, held, session, kind, owner, used,
                   alive, allowed, saved, keep, swept, queue, grace, retries,
                   retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:232-276 local sweep and hosted timer setup
Sweep ==
    /\ app = "up" /\ ~frozen /\ ~swept
    /\ swept' = TRUE
    /\ queue' = queue \cup {t \in Tags : LocalTarget(t)}
    /\ allowed' = allowed \cup {t \in Tags : state[t] = "left" /\ kind[t] = "local" /\ session[t] \notin keep}
    /\ grace' = \E t \in Tags : state[t] = "left" /\ kind[t] = "hosted"
    /\ UNCHANGED <<app, frozen, launches, tab, held, state, session, kind, owner,
                   used, alive, inflight, saved, keep, exited, retries, retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:278-307 hosted grace callback
GraceExpires ==
    /\ app = "up" /\ grace
    /\ grace' = FALSE
    /\ queue' = IF frozen THEN queue ELSE queue \cup {t \in Tags : HostedTarget(t)}
    /\ allowed' = IF frozen THEN allowed ELSE allowed \cup {t \in Tags : state[t] = "left" /\ kind[t] = "hosted" /\ ~HostedHeld(t)}
    /\ UNCHANGED <<app, frozen, launches, tab, held, state, session, kind, owner,
                   used, alive, inflight, saved, keep, swept, exited, retries, retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:232-266 sweep selects and marks under one lock
\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:310-338 session_released selects and marks under one lock
BeginQueuedEnd(t) ==
    /\ app = "up" /\ t \in queue
    /\ queue' = queue \ {t}
    /\ IF ~frozen /\ state[t] = "left"
       THEN /\ state' = [state EXCEPT ![t] = "ending"]
            /\ inflight' = inflight \cup {t}
       ELSE UNCHANGED <<state, inflight>>
    /\ UNCHANGED <<app, frozen, launches, tab, held, session, kind, owner, used,
                   alive, allowed, saved, keep, swept, grace, exited, retries, retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:340-356 procs end
\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:358-408 finish_end and retry scheduling
EndAnswer(t, result) ==
    /\ app = "up" /\ t \in inflight /\ result \in {"empty", "retained", "own", "error"}
    /\ inflight' = inflight \ {t}
    /\ state' = [state EXCEPT ![t] = IF result = "empty" THEN "free" ELSE "left"]
    /\ alive' = IF result = "empty" THEN alive \ {t} ELSE alive
    /\ failed' = IF result = "empty" THEN failed ELSE TRUE
    /\ retries' = IF result = "retained" /\ t \notin retryUsed THEN retries \cup {t} ELSE retries
    /\ retryUsed' = IF result = "retained" THEN retryUsed \cup {t} ELSE retryUsed
    /\ UNCHANGED <<app, frozen, launches, tab, held, session, kind, owner, used,
                   allowed, saved, keep, swept, queue, grace, exited, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:410-426 retry checks freeze and left under lock
Retry(t) ==
    /\ app = "up" /\ t \in retries
    /\ retries' = retries \ {t}
    /\ IF ~frozen /\ RetryEligible(t)
       THEN /\ state' = [state EXCEPT ![t] = "ending"]
            /\ inflight' = inflight \cup {t}
       ELSE UNCHANGED <<state, inflight>>
    /\ UNCHANGED <<app, frozen, launches, tab, held, session, kind, owner, used,
                   alive, allowed, saved, keep, swept, queue, grace, exited,
                   retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:227-229 freeze latch
Freeze ==
    /\ app = "up" /\ ~frozen
    /\ frozen' = TRUE
    /\ saved' = {o \in Owners : tab[o] # "closed"}
    /\ UNCHANGED <<app, launches, tab, held, state, session, kind, owner, used,
                   alive, inflight, allowed, keep, swept, queue, grace, exited,
                   retries, retryUsed, failed, tookOver, retired>>

\* A crash can occur at any time; the file is abstracted as all non-free entries.
Down ==
    /\ app = "up"
    /\ app' = "down"
    /\ saved' = IF frozen THEN saved ELSE {o \in Owners : tab[o] # "closed"}
    /\ tab' = [o \in Owners |-> "closed"] /\ held' = [o \in Owners |-> None]
    /\ inflight' = {} /\ queue' = {} /\ grace' = FALSE /\ exited' = {} /\ retries' = {}
    /\ UNCHANGED <<frozen, launches, state, session, kind, owner, used, alive,
                   allowed, keep, swept, retryUsed, failed, tookOver, retired>>

\* @code native/ompdesk/crates/core/src/session_ownership/mod.rs:49-90 load persisted entries as left
\* @code native/ompdesk/crates/core/src/session_ownership/journal.rs:11-39 read and validate journal
Boot ==
    /\ app = "down" /\ launches < MaxLaunches
    /\ app' = "up" /\ frozen' = FALSE /\ launches' = launches + 1
    /\ state' = [t \in Tags |-> IF state[t] = "free" THEN "free" ELSE "left"]
    /\ owner' = [t \in Tags |-> None]
    /\ tab' = [o \in Owners |-> IF o \in saved THEN "restored" ELSE "closed"]
    /\ \E markers \in SUBSET Sessions :
           keep' = {o[1] : o \in {p \in saved : p[2] = "local"}} \cup markers
    /\ swept' = FALSE /\ retryUsed' = {} /\ failed' = FALSE
    /\ allowed' = {} /\ retired' = {}
    /\ UNCHANGED <<held, session, kind, used, alive, inflight, saved, queue,
                   grace, exited, retries, tookOver>>

Next ==
    \/ \E o \in Owners : Open(o) \/ Spawn(o) \/ Dispose(o) \/ CloseBeforeAcquire(o)
    \/ \E t \in Tags : Exited(t) \/ CloseAfterExit(t) \/ BeginQueuedEnd(t) \/ Retry(t)
                         \/ \E result \in {"empty", "retained", "own", "error"} : EndAnswer(t, result)
    \/ Sweep \/ GraceExpires \/ Freeze \/ Down \/ Boot
Spec == Init /\ [][Next]_vars

\* Regression scenario: restore a hosted tab, let grace see it, then close it before acquisition.
TraceHostedOwner == CHOOSE o \in Owners : o[2] = "hosted"
HostedTraceNext ==
    \/ /\ launches = 1 /\ used = {} /\ Open(TraceHostedOwner)
    \/ /\ launches = 1 /\ tab[TraceHostedOwner] = "started" /\ Down
    \/ /\ app = "down" /\ Boot
    \/ /\ launches = 2 /\ ~swept /\ Sweep
    \/ /\ launches = 2 /\ swept /\ grace /\ GraceExpires
    \/ /\ launches = 2 /\ swept /\ ~grace /\ tab[TraceHostedOwner] = "restored"
       /\ Dispose(TraceHostedOwner)
HostedTraceSpec == Init /\ [][HostedTraceNext]_vars
NeverHostedReleasedAfterGrace ==
    ~\E t \in queue : kind[t] = "hosted" /\ session[t] = TraceHostedOwner[1]

\* ---------------- FROZEN PROPERTIES: Properties.md ----------------
OnlyGoneTagsEnd == inflight \subseteq allowed
OpenTabsKeepTheirProcesses ==
    \A o \in Owners :
        /\ tab[o] = "started" => (held[o] \notin inflight /\ state[held[o]] = "live")
        /\ tab[o] = "restored" =>
            \A t \in Tags : (session[t] = o[1] /\ kind[t] = o[2] /\ state[t] # "free") => t \notin inflight
NoLeakAtRest ==
    (app = "up" /\ swept /\ ~frozen /\ inflight = {} /\ queue = {} /\ ~grace /\
     {t \in Tags : state[t] = "closing"} = {} /\ ~failed) =>
        \A t \in Tags : state[t] # "free" =>
            \/ state[t] = "live" /\ \E o \in Owners : tab[o] = "started" /\ held[o] = t
            \/ state[t] = "left" /\ \E o \in Owners : tab[o] # "closed" /\ session[t] = o[1] /\ kind[t] = o[2]
            \/ state[t] = "left" /\ kind[t] = "local" /\ session[t] \in keep
NoForgottenTag == \A t \in alive : state[t] # "free"
NoLateAdmission == \A o \in retired : tab[o] # "started"
PendingCloseProtected == \A t \in inflight : owner[t] # None => t \in exited
HostedGraceProtected == grace => \A t \in Tags :
    (kind[t] = "hosted" /\ t \notin allowed) => t \notin inflight
\* ---------------- END FROZEN PROPERTIES ----------------
NeverEnds == inflight = {}
NeverTakesOver == ~tookOver
NeverClosing == \A t \in Tags : state[t] # "closing"
NeverHostedGrace == ~grace
NeverRetryOvertaken == \A t \in retries : state[t] # "live"
=============================================================================
