------------------------ MODULE NativeReportCoalescer ------------------------
EXTENDS Naturals, FiniteSets

(***************************************************************************
 SOURCE candidate, Main d113 / Inbox 9f42f5ccb. No TLC verdict or code-sync stamp.
 One native sender/receiver pair. Pending is the EXISTING coalescing slot;
 inFlight contains only exact completion handles, not another mail queue.
 See CORRESPONDENCE.md for actual lock/await boundaries and remaining gaps.
 ************************************************************************ **)
CONSTANTS Keys, Callers, MaxCalls, MaxGenerations, MaxRetries, EarlyAck

None == 0
Hashes == {1, 2}
Gens == 1 .. MaxGenerations
Attempts == 1 .. (MaxRetries + 1)
Reqs == Callers \X (1 .. MaxCalls)
Success == {"new", "existing"}
Outcomes == {"none", "new", "existing", "error", "unadmitted", "unknown"}
ActivePhases == {"lookup", "carry", "persist", "offer", "return"}
Phases == {"unused", "queued", "claimed", "finished", "stopped"} \cup ActivePhases

VARIABLES flights, originalHash, requests, counts, lastGen, pending, inFlight,
          receiver, owned, effects, known, received, expectedJoin,
          unknownActive, unknownEnded, scheduled
vars == <<flights, originalHash, requests, counts, lastGen, pending, inFlight,
          receiver, owned, effects, known, received, expectedJoin,
          unknownActive, unknownEnded, scheduled>>

EmptyFlight == [key |-> None, hash |-> None, kind |-> "progress", phase |-> "unused",
                attempt |-> 0, ever |-> FALSE, sourceOwned |-> FALSE,
                outcome |-> "none", receipt |-> "none"]
EmptyRequest == [state |-> "unused", key |-> None, hash |-> None, gen |-> None,
                 result |-> "none", by |-> None]
Indexed == inFlight \cup {g \in Gens : flights[g].phase = "queued"}
Matching(k) == {g \in Indexed : flights[g].key = k}
CanCall(c) == /\ counts[c] < MaxCalls
              /\ \A n \in 1 .. counts[c] : requests[<<c, n>>].state = "done"
NextReq(c) == <<c, counts[c] + 1>>
UnadmittedOutcome(g) == IF flights[g].ever THEN "unknown" ELSE "unadmitted"
Effective(g, result) == IF flights[g].outcome = "none" THEN result ELSE flights[g].outcome
Settle(g, result, by) ==
    [r \in Reqs |-> IF requests[r].state = "waiting" /\ requests[r].gen = g
                    THEN [requests[r] EXCEPT !.state = "done", !.result = result, !.by = by]
                    ELSE requests[r]]
CancelPending ==
    IF pending = None THEN flights
    ELSE [flights EXCEPT ![pending].phase = "stopped",
                         ![pending].outcome = Effective(pending, UnadmittedOutcome(pending))]
CancelPendingRequests ==
    IF pending = None THEN requests
    ELSE Settle(pending, Effective(pending, UnadmittedOutcome(pending)), pending)

Init ==
    /\ flights = [g \in Gens |-> EmptyFlight]
    /\ originalHash = [g \in Gens |-> None]
    /\ requests = [r \in Reqs |-> EmptyRequest]
    /\ counts = [c \in Callers |-> 0]
    /\ lastGen = 0
    /\ pending = None
    /\ inFlight = {}
    /\ receiver \in [Keys -> Hashes \cup {None}]
    /\ owned = {p \in Keys \X Hashes : receiver[p[1]] = p[2]}
    /\ effects = {}
    /\ known = {}
    /\ received = {}
    /\ expectedJoin = [r \in Reqs |-> None]
    /\ unknownActive = {}
    /\ unknownEnded = {}
    /\ scheduled = {}

\* SOURCE mailbox post: one tables mutex section, no physical attachment effects.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:763-875
Admit(c, k, h, kind) ==
    /\ CanCall(c)
    /\ lastGen < MaxGenerations
    /\ Matching(k) = {}
    /\ LET g == lastGen + 1
           r == NextReq(c)
           active == kind # "progress"
       IN /\ flights' = [CancelPending EXCEPT ![g] =
                 [key |-> k, hash |-> h, kind |-> kind,
                  phase |-> IF active THEN "claimed" ELSE "queued",
                  attempt |-> 0, ever |-> FALSE,
                  sourceOwned |-> FALSE, outcome |-> "none", receipt |-> "none"]]
          /\ originalHash' = [originalHash EXCEPT ![g] = h]
          /\ requests' = [CancelPendingRequests EXCEPT ![r] =
                 [state |-> "waiting", key |-> k, hash |-> h, gen |-> g,
                  result |-> "none", by |-> None]]
          /\ expectedJoin' = [expectedJoin EXCEPT ![r] =
                 IF Matching(k) = {} THEN None ELSE CHOOSE prior \in Matching(k) : TRUE]
          /\ counts' = [counts EXCEPT ![c] = @ + 1]
          /\ lastGen' = g
          /\ pending' = (IF active THEN None ELSE g)
          /\ inFlight' = (IF active THEN inFlight \cup {g} ELSE inFlight)
          /\ scheduled' = (IF active THEN scheduled \cup {g} ELSE scheduled)
          /\ unknownEnded' = (IF pending # None /\ flights[pending].ever
                               THEN unknownEnded \cup {pending} ELSE unknownEnded)
    /\ UNCHANGED <<receiver, owned, effects, known, received, unknownActive>>

\* SOURCE mailbox pending/in-flight canonical equality under the same tables mutex.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:773-790
Join(c, g) ==
    /\ CanCall(c)
    /\ g \in Indexed
    /\ LET r == NextReq(c)
           result == flights[g].outcome
       IN /\ requests' = [requests EXCEPT ![r] =
                 [state |-> IF result = "none" THEN "waiting" ELSE "done",
                  key |-> flights[g].key, hash |-> flights[g].hash, gen |-> g,
                  result |-> result, by |-> IF result = "none" THEN None ELSE g]]
          /\ expectedJoin' = [expectedJoin EXCEPT ![r] = g]
          /\ counts' = [counts EXCEPT ![c] = @ + 1]
    /\ UNCHANGED <<flights, originalHash, lastGen, pending, inFlight, receiver,
                   owned, effects, known, received, unknownActive, unknownEnded, scheduled>>

\* SOURCE mailbox immutable canonical hash conflict: original Waiting is retained.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:785-787
Conflict(c, g, h) ==
    /\ CanCall(c)
    /\ g \in Indexed
    /\ h # flights[g].hash
    /\ LET r == NextReq(c)
       IN /\ requests' = [requests EXCEPT ![r] =
                 [state |-> "done", key |-> flights[g].key, hash |-> h, gen |-> None,
                  result |-> "conflict", by |-> None]]
          /\ counts' = [counts EXCEPT ![c] = @ + 1]
    /\ flights' = flights
    /\ UNCHANGED <<originalHash, lastGen, pending, inFlight, receiver, owned,
                   effects, known, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE timer claims a Waiting under Tables; the actual callback has not started.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:596-616
Claim(g) ==
    /\ pending = g
    /\ flights[g].phase = "queued"
    /\ flights[g].outcome = "none"
    /\ flights' = [flights EXCEPT ![g].phase = "claimed"]
    /\ pending' = None
    /\ inFlight' = inFlight \cup {g}
    /\ scheduled' = scheduled \cup {g}
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, receiver, owned,
                   effects, known, received, expectedJoin, unknownActive, unknownEnded>>

\* SOURCE exact generation + Arc check, then attempted=true before calling Deliver.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:621-645
BeginDeliver(g) ==
    /\ g \in scheduled
    /\ g \in inFlight
    /\ flights[g].phase = "claimed"
    /\ flights[g].outcome = "none"
    /\ flights' = [flights EXCEPT ![g].phase = "lookup", ![g].ever = TRUE,
                                 ![g].attempt = @ + 1]
    /\ scheduled' = scheduled \ {g}
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   receiver, owned, effects, known, received, expectedJoin, unknownActive, unknownEnded>>

\* SOURCE an unstarted forgotten task fails its exact-handle check; Drop is fenced.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:482-509
FenceUnstarted(g) ==
    /\ g \in scheduled
    /\ flights[g].outcome # "none"
    /\ scheduled' = scheduled \ {g}
    /\ flights' = [flights EXCEPT ![g].phase = "stopped"]
    /\ inFlight' = inFlight \ {g}
    /\ unknownActive' = unknownActive \ {g}
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, receiver,
                   owned, effects, known, received, expectedJoin, unknownEnded>>

\* SOURCE actual Deliver canonical lookup returns known responsibility; no carry/land.
\* @code native/ompdesk/crates/core/src/agentctl/service/attach.rs:768-781
LookupKnown(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "lookup"
    /\ receiver[flights[g].key] = flights[g].hash
    /\ flights' = [flights EXCEPT ![g].phase = "return", ![g].receipt = "existing"]
    /\ known' = known \cup {<<g, flights[g].attempt>>}
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   receiver, owned, effects, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE actual selected Deliver's second canonical lookup still says Missing.
\* @code native/ompdesk/crates/core/src/agentctl/service/attach.rs:768-790
LookupMissing(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "lookup"
    /\ receiver[flights[g].key] = None
    /\ flights' = [flights EXCEPT ![g].phase = "carry"]
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   receiver, owned, effects, known, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE lookup conflict is an error and cannot overwrite receiver ownership.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_source.rs:224-239
LookupConflict(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "lookup"
    /\ receiver[flights[g].key] \notin {None, flights[g].hash}
    /\ flights' = [flights EXCEPT ![g].phase = "return", ![g].receipt = "error"]
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   receiver, owned, effects, known, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE materialize selected original Arc attachment plan outside the tables lock.
\* @code native/ompdesk/crates/core/src/agentctl/service/attach.rs:667-708
Materialize(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "carry"
    /\ flights' = [flights EXCEPT ![g].phase = "persist"]
    /\ effects' = effects \cup {<<g, flights[g].attempt>>}
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   receiver, owned, known, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE persist original native source responsibility before offering to receiver.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_source.rs:240-244
PersistSource(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "persist"
    /\ flights' = [flights EXCEPT ![g].phase = "offer", ![g].sourceOwned = TRUE]
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   receiver, owned, effects, known, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE receiving native Disk transaction; wire response can still be lost afterward.
\* @code native/ompdesk/crates/core/src/agentctl/runtime/inbox_source.rs:620-643
Receive(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "offer"
    /\ flights[g].sourceOwned
    /\ receiver[flights[g].key] \in {None, flights[g].hash}
    /\ flights' = [flights EXCEPT ![g].phase = "return",
          ![g].receipt = IF receiver[flights[g].key] = None THEN "new" ELSE "existing"]
    /\ receiver' = [receiver EXCEPT ![flights[g].key] = flights[g].hash]
    /\ owned' = owned \cup {<<flights[g].key, flights[g].hash>>}
    /\ received' = received \cup {<<g, flights[g].attempt, g \in unknownEnded>>}
    /\ UNCHANGED <<originalHash, requests, counts, lastGen, pending, inFlight,
                   effects, known, expectedJoin, unknownActive, unknownEnded, scheduled>>

\* SOURCE response resumes the original Deliver; exact handle owns its latch/cleanup.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:646-657
Return(g) ==
    /\ g \in inFlight
    /\ flights[g].phase = "return"
    /\ LET result == Effective(g, IF flights[g].receipt = "error" THEN "unknown" ELSE flights[g].receipt)
       IN /\ flights' = [flights EXCEPT ![g].phase = "finished", ![g].outcome = result]
          /\ requests' = Settle(g, result, g)
    /\ pending' = (IF pending = g THEN None ELSE pending)
    /\ inFlight' = inFlight \ {g}
    /\ unknownActive' = unknownActive \ {g}
    /\ UNCHANGED <<originalHash, counts, lastGen, receiver, owned, effects,
                   known, received, expectedJoin, unknownEnded, scheduled>>

\* SOURCE failed actual Deliver may have acquired receiving Disk before response loss.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:659-688
FailDeliver(g) ==
    /\ g \in inFlight
    /\ flights[g].phase \in ActivePhases
    /\ LET retry == flights[g].kind = "progress" /\ flights[g].attempt <= MaxRetries
                    /\ pending = None /\ flights[g].outcome = "none"
           result == Effective(g, "unknown")
       IN /\ flights' = [flights EXCEPT ![g].phase = IF retry THEN "queued" ELSE "stopped",
              ![g].outcome = IF retry THEN "none" ELSE result, ![g].receipt = "none"]
          /\ requests' = (IF retry THEN requests ELSE Settle(g, result, g))
          /\ pending' = (IF retry THEN g ELSE pending)
    /\ inFlight' = inFlight \ {g}
    /\ unknownActive' = unknownActive \ {g}
    /\ UNCHANGED <<originalHash, counts, lastGen, receiver, owned, effects,
                   known, received, expectedJoin, unknownEnded, scheduled>>

\* SOURCE forget fences unstarted claims, but retains actually attempted deliveries.
\* @code native/ompdesk/crates/core/src/agentctl/rules/mail.rs:930-954
Forget ==
    /\ pending # None \/ inFlight # {}
    /\ LET affected == inFlight \cup (IF pending = None THEN {} ELSE {pending})
           outcome(g) == UnadmittedOutcome(g)
       IN /\ flights' = [g \in Gens |->
                 IF g \in affected
                 THEN [flights[g] EXCEPT !.outcome = Effective(g, outcome(g)),
                       !.phase = IF g \in inFlight /\ flights[g].ever THEN @ ELSE "stopped"]
                 ELSE flights[g]]
          /\ requests' = [r \in Reqs |->
                 IF requests[r].state = "waiting" /\ requests[r].gen \in affected
                 THEN [requests[r] EXCEPT !.state = "done",
                       !.result = Effective(requests[r].gen, outcome(requests[r].gen)),
                       !.by = requests[r].gen]
                 ELSE requests[r]]
          /\ unknownEnded' = unknownEnded \cup {g \in affected : flights[g].ever}
    /\ pending' = None
    /\ inFlight' = {g \in inFlight : flights[g].ever}
    /\ unknownActive' = unknownActive \cup {g \in inFlight : flights[g].ever}
    /\ UNCHANGED <<originalHash, counts, lastGen, receiver, owned, effects, scheduled,
                   known, received, expectedJoin>>

\* Deliberately broken baseline mode: memory queue result mistaken for native success.
AckQueued ==
    /\ EarlyAck
    /\ pending # None
    /\ \E r \in Reqs : requests[r].state = "waiting" /\ requests[r].gen = pending
    /\ requests' = Settle(pending, "new", pending)
    /\ UNCHANGED <<flights, originalHash, counts, lastGen, pending, inFlight,
                   receiver, owned, effects, known, received, expectedJoin, unknownActive, unknownEnded, scheduled>>

Next ==
    \/ \E c \in Callers, k \in Keys, h \in Hashes,
          kind \in {"progress", "done", "question"} : Admit(c, k, h, kind)
    \/ \E c \in Callers, g \in Indexed : Join(c, g)
    \/ \E c \in Callers, g \in Indexed, h \in Hashes : Conflict(c, g, h)
    \/ \E g \in Gens : Claim(g) \/ BeginDeliver(g) \/ FenceUnstarted(g)
                       \/ LookupKnown(g) \/ LookupMissing(g) \/ LookupConflict(g)
                       \/ Materialize(g) \/ PersistSource(g) \/ Receive(g)
                       \/ Return(g) \/ FailDeliver(g)
    \/ Forget
    \/ AckQueued
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ flights \in [Gens -> [key : Keys \cup {None}, hash : Hashes \cup {None},
          kind : {"progress", "done", "question"}, phase : Phases,
          attempt : 0 .. (MaxRetries + 1), ever : BOOLEAN, sourceOwned : BOOLEAN,
          outcome : Outcomes, receipt : {"none", "new", "existing", "error"}]]
    /\ originalHash \in [Gens -> Hashes \cup {None}]
    /\ requests \in [Reqs -> [state : {"unused", "waiting", "done"},
          key : Keys \cup {None}, hash : Hashes \cup {None}, gen : Gens \cup {None},
          result : Outcomes \cup {"conflict"}, by : Gens \cup {None}]]
    /\ counts \in [Callers -> 0 .. MaxCalls]
    /\ lastGen \in 0 .. MaxGenerations
    /\ pending \in Gens \cup {None}
    /\ inFlight \subseteq Gens
    /\ scheduled \subseteq Gens
    /\ receiver \in [Keys -> Hashes \cup {None}]
    /\ owned \subseteq Keys \X Hashes
    /\ effects \subseteq Gens \X Attempts
    /\ known \subseteq Gens \X Attempts
    /\ received \subseteq Gens \X Attempts \X BOOLEAN
    /\ expectedJoin \in [Reqs -> Gens \cup {None}]
    /\ unknownActive \subseteq Gens
    /\ unknownEnded \subseteq Gens

\* ======================== FROZEN PROPERTIES ========================
NoAckBeforeReceiverOwned ==
    \A r \in Reqs : requests[r].result \in Success =>
        <<requests[r].key, requests[r].hash>> \in owned
NoSupersededEffects ==
    \A g \in Gens : flights[g].outcome = "unadmitted" =>
        /\ ~flights[g].ever
        /\ \A a \in Attempts : <<g, a>> \notin effects
        /\ \A event \in received : event[1] # g
NoConcurrentIdentityDeliver ==
    /\ \A x, y \in inFlight :
         (flights[x].key = flights[y].key /\ flights[x].hash = flights[y].hash) => x = y
    /\ \A r \in Reqs : expectedJoin[r] # None => requests[r].gen = expectedJoin[r]
NoKnownRetryEffects == known \cap effects = {}
NoLateReplacementMutation ==
    /\ \A g \in Gens : flights[g].phase = "queued" => pending = g
    /\ \A r \in Reqs : requests[r].state = "done" /\ requests[r].gen # None =>
                            requests[r].by = requests[r].gen
NoUnadmittedWaiterOrphan ==
    \A r \in Reqs : requests[r].gen # None =>
        (flights[requests[r].gen].outcome = "unadmitted" => requests[r].state = "done")
ConflictPreservesOriginal ==
    \A g \in Gens : flights[g].hash = originalHash[g]
UnknownRetainsResponsibility ==
    /\ unknownActive \subseteq inFlight
    /\ \A g \in unknownEnded : flights[g].outcome = "unknown"
    /\ \A p \in owned : receiver[p[1]] = p[2]
\* ====================== END FROZEN PROPERTIES ======================

NeverNewReceiverOwned == received = {}
NeverJoined == \A r \in Reqs : expectedJoin[r] = None
NeverUnknown == unknownEnded = {}
NeverRetryQueued == \A g \in Gens : ~(flights[g].phase = "queued" /\ flights[g].ever)
NeverUnadmitted == \A g \in Gens : flights[g].outcome # "unadmitted"
NeverUnknownLateEffect == \A event \in received : ~event[3]
=============================================================================
