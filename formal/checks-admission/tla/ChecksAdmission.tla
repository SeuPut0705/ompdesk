--------------------------- MODULE ChecksAdmission ---------------------------
(*
 * ChecksHub admission: which job of a check takes a place in a pool, and when (docs/design/check-control.md, 5 and 9).
 *
 * A job belongs to one pool: "mac" (GitHub-hosted macOS runners), "hosted" (GitHub-hosted Linux and Windows runners)
 * or "device" (one computer's heavy slots). "mac" and "hosted" also share the account's limit on all hosted jobs.
 * The hub governs only the jobs it was asked to start; a person's run, another repo's run and another program's heavy
 * command take places too and are never touched (`Outside`).
 *
 * A governed job is asked for (`Start`): refused while the owner paused admission, answered `reused` from a green run
 * of the same input digest, else it waits (`held`) in OMPdesk, not at GitHub. A start supersedes the older runs of its
 * repo, ref and workflow. A held entry keeps a lease its owner's heartbeats renew; one whose lease lapsed leaves the
 * queue. The pump (`Admit`) gives a free place to the first live entry in line: lane first (release, land, branch,
 * local), then arrival.
 *
 * Design model (workflow W3): the code is not written. Every action that stands for code says which step of the hub
 * it is; the action table is ../CORRESPONDENCE.md, and each action gets its code tag when
 * native/ompdesk/crates/core/src/checks/admission.rs lands.
 *)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Jobs,          \* every job of the scenario
    Outside,       \* jobs the hub does not govern (a person's run, another repo's, another program's heavy command)
    Release,       \* jobs of lane "release"
    Land,          \* jobs of lane "land" (the merge queue's runs)
    Branch,        \* jobs of lane "branch"; a job in none of the three is of lane "local"
    Mac,           \* jobs of pool "mac"
    Device,        \* jobs of pool "device"; a job in neither is of pool "hosted"
    SameKey,       \* jobs of one repo, ref and workflow; every other job has a key of its own
    SameDigest,    \* jobs with one input digest; every other job has a digest of its own
    MacLimit,      \* macOS jobs the account runs at once (5)
    HostedCap,     \* hosted jobs the account runs at once, macOS included (40)
    DeviceLimit,   \* the computer's heavy slots
    MayPause,      \* the owner may pause and resume admission
    Lapses         \* a held entry's lease may lapse (its owner died, or its heartbeats stalled)

ASSUME
    /\ Outside \subseteq Jobs /\ Release \subseteq Jobs /\ Land \subseteq Jobs /\ Branch \subseteq Jobs
    /\ Mac \subseteq Jobs /\ Device \subseteq Jobs /\ SameKey \subseteq Jobs /\ SameDigest \subseteq Jobs
    /\ Release \cap Land = {} /\ Release \cap Branch = {} /\ Land \cap Branch = {}
    /\ Mac \cap Device = {}
    /\ MacLimit \in Nat /\ MacLimit > 0
    /\ HostedCap \in Nat /\ HostedCap > 0
    /\ DeviceLimit \in Nat /\ DeviceLimit > 0
    /\ MayPause \in BOOLEAN /\ Lapses \in BOOLEAN

\* Mutation switch: a heartbeat that arrives after its lease lapsed renews the lease.
LateHeartbeatRenews == FALSE

\* ============================ What a job is (never changes) ============================

Governed == Jobs \ Outside

LaneOf(j) ==
    IF j \in Release THEN "release" ELSE IF j \in Land THEN "land" ELSE IF j \in Branch THEN "branch" ELSE "local"

\* Lane order: release, land, branch, local (design 5, "Release-bound work first").
Rank(j) == IF j \in Release THEN 0 ELSE IF j \in Land THEN 1 ELSE IF j \in Branch THEN 2 ELSE 3

PoolOf(j) == IF j \in Mac THEN "mac" ELSE IF j \in Device THEN "device" ELSE "hosted"

\* The pools under the account's limit on all hosted jobs.
Account == {"mac", "hosted"}

Limit(p) == IF p = "mac" THEN MacLimit ELSE IF p = "device" THEN DeviceLimit ELSE HostedCap

SameKeyAs(a, b) == a # b /\ a \in SameKey /\ b \in SameKey
SameDigestAs(a, b) == a # b /\ a \in SameDigest /\ b \in SameDigest

\* Two jobs can take a place from one another: one pool, or two pools under the account's limit.
Competes(a, b) == PoolOf(a) = PoolOf(b) \/ (PoolOf(a) \in Account /\ PoolOf(b) \in Account)

VARIABLES
    state,    \* job -> where it is (see States)
    seq,      \* job -> its arrival number at the hub (0: never asked for)
    next,     \* the next arrival number
    lapsed,   \* held entries whose lease ran out before a heartbeat renewed it
    paused,   \* the owner paused admission
    admits,   \* ghost: job -> how many times the hub took a place and dispatched it
    at        \* ghost: job -> the arrival number `next` had when the job last took a place (0: never)

vars == <<state, seq, next, lapsed, paused, admits, at>>

\* A job that ended, one way or another.
Over == {"refused", "reused", "failed", "green", "red", "cancelled", "expired", "gone"}
States == {"none", "held", "dispatching", "running", "cancelling"} \cup Over

TypeOK ==
    /\ state \in [Jobs -> States]
    /\ seq \in [Jobs -> 0 .. Cardinality(Jobs)]
    /\ next \in 1 .. Cardinality(Jobs) + 1
    /\ lapsed \subseteq Jobs
    /\ paused \in BOOLEAN
    /\ admits \in [Jobs -> 0 .. 2]
    /\ at \in [Jobs -> 0 .. Cardinality(Jobs) + 1]

Init ==
    /\ state = [j \in Jobs |-> "none"]
    /\ seq = [j \in Jobs |-> 0]
    /\ next = 1
    /\ lapsed = {}
    /\ paused = FALSE
    /\ admits = [j \in Jobs |-> 0]
    /\ at = [j \in Jobs |-> 0]

\* ============================ What is true of the pools ============================

\* A job that holds a place: dispatched and not yet seen at GitHub, running, or cancelled and not yet seen to end.
Occupies(j) == state[j] \in {"dispatching", "running", "cancelling"}
In(p) == {j \in Jobs : PoolOf(j) = p /\ Occupies(j)}
AccountLoad == Cardinality(In("mac")) + Cardinality(In("hosted"))

\* A place is free for the job, in its pool and under the account's limit.
Free(j) ==
    /\ Cardinality(In(PoolOf(j))) < Limit(PoolOf(j))
    /\ (PoolOf(j) \in Account => AccountLoad < HostedCap)

\* A held entry whose lease holds.
Waiting(j) == state[j] = "held" /\ j \notin lapsed

\* Who is first: the higher lane, then the earlier arrival.
Ahead(a, b) == Rank(a) < Rank(b) \/ (Rank(a) = Rank(b) /\ seq[a] < seq[b])

\* ============================ The hub's ledger and its rules ============================

\* What the hub counts as a taken place: its own entries from its ledger, the others from the poller.
Counted(j) ==
    \/ state[j] = "dispatching"
    \/ state[j] = "running"
    \/ state[j] = "cancelling"
Places(p) == {j \in Jobs : PoolOf(j) = p /\ Counted(j)}

\* A release entry whose own pool is full holds one place of the account for itself (the owner's F1 decision,
\* 14 Nov 2026): a job behind it may not take the account's places it holds. A release entry waits "only on its own
\* pool" exactly when this matters: a job behind it is admitted only while the account has room, so the account is
\* never what that entry waits on at that moment.
Holds(r) ==
    /\ Waiting(r)
    /\ r \in Release
    /\ PoolOf(r) \in Account
    /\ Cardinality(Places(PoolOf(r))) >= Limit(PoolOf(r))
HeldAhead(j) == {r \in Jobs : Holds(r) /\ Ahead(r, j)}

Room(j) ==
    /\ Cardinality(Places(PoolOf(j))) < Limit(PoolOf(j))
    /\ (PoolOf(j) \in Account =>
           Cardinality(Places("mac")) + Cardinality(Places("hosted")) + Cardinality(HeldAhead(j)) < HostedCap)

\* The runs a start of `j` supersedes (design 5 "Overlapping runs cancel themselves", 9.1).
Superseded(j) ==
    {x \in Jobs :
        /\ SameKeyAs(x, j)
        /\ x \in Governed
        /\ LaneOf(x) # "release"
        /\ LaneOf(x) # "land"
        /\ state[x] \in {"held", "dispatching", "running"}}

\* The green runs a start of `j` may be answered from (design 5 "Reuse a green result").
ReuseSources(j) == {g \in Jobs : SameDigestAs(g, j) /\ state[g] = "green"}

\* ============================ The hub's steps ============================

\* `start`: one step of the hub, after the caller's input digest is known.
\* Refused while paused; reused from a green run of the same digest; else held, superseding the older runs of its key.
\* A superseded entry that only waited is gone at once; one that holds a place keeps it until GitHub shows it ended.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:173-218 Admission::start: refuse, reuse or hold, and supersede, in one step under the lock
\* @code native/ompdesk/crates/core/src/checks/hub.rs:883-1118 Core::submit: policy fixes lane, pool, key and digest first (A5), then admission.start; the superseded runs' GitHub cancel follows
Start(j) ==
    /\ j \in Governed
    /\ state[j] = "none"
    /\ LET decision == IF paused THEN "refused" ELSE IF ReuseSources(j) # {} THEN "reused" ELSE "held"
           out == IF decision = "held" THEN Superseded(j) ELSE {}
       IN  state' = [x \in Jobs |->
                        IF x = j THEN decision
                        ELSE IF x \notin out THEN state[x]
                        ELSE IF state[x] = "held" THEN "cancelled" ELSE "cancelling"]
    /\ seq' = [seq EXCEPT ![j] = next]
    /\ next' = next + 1
    /\ UNCHANGED <<lapsed, paused, admits, at>>

\* The pump: the first live entry in line that has a place takes it, and its dispatch is sent. One step: the place
\* is in the ledger before the dispatch's `await`.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:279-293 Admission::admit: the first live entry in line with room, while not paused
\* @code native/ompdesk/crates/core/src/checks/admission.rs:259-275 room: the pool below its limit and the account with HeldAhead counted
\* @code native/ompdesk/crates/core/src/checks/admission.rs:250-256 holds: the model's Holds(r), derived on every pass
\* @code native/ompdesk/crates/core/src/checks/admission.rs:385-402 pump: admit under the lock, then await the dispatch with the lock released (A1, A2)
\* @code native/ompdesk/crates/core/src/checks/hub.rs:489-494 Core::pump: one pump pass after another until nothing more is admitted
Admit(j) ==
    /\ state[j] = "held"
    /\ j \notin lapsed
    /\ ~paused
    /\ Room(j)
    /\ ~(\E r \in Jobs : Waiting(r) /\ Competes(r, j) /\ Ahead(r, j) /\ Room(r))
    /\ state' = [state EXCEPT ![j] = "dispatching"]
    /\ admits' = [admits EXCEPT ![j] = @ + 1]
    /\ at' = [at EXCEPT ![j] = next]
    /\ UNCHANGED <<seq, next, lapsed, paused>>

\* The dispatch was accepted: the run exists.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:296-303 Admission::dispatched
\* @code native/ompdesk/crates/core/src/checks/hub.rs:498-546 Core::dispatch: the poller's claim, then GitHub's dispatch; its answer decides Dispatched or DispatchFails
Dispatched(j) ==
    /\ state[j] = "dispatching"
    /\ state' = [state EXCEPT ![j] = "running"]
    /\ UNCHANGED <<seq, next, lapsed, paused, admits, at>>

\* The dispatch failed, or its answer never came: the entry ends and its place goes back. It is never queued again,
\* because a dispatch whose answer was lost may have started the run.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:307-314 Admission::dispatch_failed: never put back in the queue
DispatchFails(j) ==
    /\ state[j] = "dispatching"
    /\ state' = [state EXCEPT ![j] = "failed"]
    /\ UNCHANGED <<seq, next, lapsed, paused, admits, at>>

\* The poller shows the run ended (a job the hub governs: green or red; any other: only that it is gone).
\* @code native/ompdesk/crates/core/src/checks/admission.rs:317-329 Admission::run_ended: a green one may be reused on its digest
\* @code native/ompdesk/crates/core/src/checks/hub.rs:449-486 Core::settle: the poller's snapshot frees ended runs' places, outside runs counted by set_pools
RunEnds(j) ==
    /\ state[j] = "running"
    /\ \E verdict \in (IF j \in Outside THEN {"gone"} ELSE {"green", "red"}) :
          state' = [state EXCEPT ![j] = verdict]
    /\ UNCHANGED <<seq, next, lapsed, paused, admits, at>>

\* The poller shows a superseded run ended: only now is its place free.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:332-339 Admission::cancel_landed
CancelLands(j) ==
    /\ state[j] = "cancelling"
    /\ state' = [state EXCEPT ![j] = "cancelled"]
    /\ UNCHANGED <<seq, next, lapsed, paused, admits, at>>

\* The lease sweep, or a heartbeat that arrives after its lease lapsed: the entry leaves the queue and its owner is
\* told `expired`.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:361-370 Admission::reap: the sweep
\* @code native/ompdesk/crates/core/src/checks/admission.rs:343-357 Admission::heartbeat: a lapsed lease is reaped, never renewed (the guard the Renew mutation removes)
Reap(j) ==
    /\ j \in lapsed /\ state[j] = "held"
    /\ state' = [state EXCEPT ![j] = "expired"]
    /\ UNCHANGED <<seq, next, lapsed, paused, admits, at>>

\* Only under LateHeartbeatRenews: the heartbeat handler renews a lease without reading its deadline.
Renew(j) ==
    /\ LateHeartbeatRenews
    /\ j \in lapsed /\ state[j] = "held"
    /\ lapsed' = lapsed \ {j}
    /\ UNCHANGED <<state, seq, next, paused, admits, at>>

\* The owner's one control.
\* @code native/ompdesk/crates/core/src/checks/admission.rs:373-375 Admission::pause
\* @code native/ompdesk/crates/core/src/checks/hub.rs:1161-1174 Core::pause: kept with write_kept, read again when the hub opens
Pause ==
    /\ MayPause /\ ~paused
    /\ paused' = TRUE
    /\ UNCHANGED <<state, seq, next, lapsed, admits, at>>

Resume ==
    /\ MayPause /\ paused
    /\ paused' = FALSE
    /\ UNCHANGED <<state, seq, next, lapsed, admits, at>>

\* ============================ The environment ============================

\* A job the hub does not govern starts. GitHub (or the computer's heavy pool) lets it in only while a place is free.
OutsideStarts(j) ==
    /\ j \in Outside
    /\ state[j] = "none"
    /\ Free(j)
    /\ state' = [state EXCEPT ![j] = "running"]
    /\ at' = [at EXCEPT ![j] = next]
    /\ UNCHANGED <<seq, next, lapsed, paused, admits>>

\* A lease's time runs out with no heartbeat (the owner died, slept, or lost its link).
Lapse(j) ==
    /\ Lapses
    /\ state[j] = "held"
    /\ j \notin lapsed
    /\ lapsed' = lapsed \cup {j}
    /\ UNCHANGED <<state, seq, next, paused, admits, at>>

\* Every job is over: nothing is left to do.
Terminated == (\A j \in Jobs : state[j] \in Over) /\ UNCHANGED vars

Next ==
    \/ \E j \in Jobs :
          \/ Start(j) \/ Admit(j) \/ Dispatched(j) \/ DispatchFails(j) \/ RunEnds(j) \/ CancelLands(j)
          \/ Reap(j) \/ Renew(j) \/ OutsideStarts(j) \/ Lapse(j)
    \/ Pause \/ Resume
    \/ Terminated

Spec == Init /\ [][Next]_vars

\* What the liveness properties assume: the hub's pump and its lease sweep run, a dispatch gets its answer, and every
\* run ends (GitHub's job timeout; the heavy pool's OS lock). Nothing is assumed of starts, lapses or the owner.
Fairness ==
    /\ WF_vars(\E j \in Jobs : Admit(j))
    /\ WF_vars(\E j \in Jobs : Reap(j))
    /\ WF_vars(\E j \in Jobs : Dispatched(j) \/ DispatchFails(j))
    /\ WF_vars(\E j \in Jobs : RunEnds(j))
    /\ WF_vars(\E j \in Jobs : CancelLands(j))

FairSpec == Spec /\ Fairness

(* ---- BEGIN FROZEN PROPERTIES (formal/checks-admission/Properties.md) ---- *)

\* The step in which the hub admits a job.
Starts(j) == state[j] = "held" /\ state'[j] = "dispatching"

\* P1: no pool, and not the account, ever holds more jobs than its limit.
WithinPoolLimits ==
    /\ Cardinality(In("mac")) <= MacLimit
    /\ AccountLoad <= HostedCap
    /\ Cardinality(In("device")) <= DeviceLimit

\* P2: a job is admitted at most once.
AdmittedOnce == \A j \in Jobs : admits[j] <= 1

\* P3: a job is never admitted while a job of a higher lane waits for a place that is free for it.
HigherLaneFirst ==
    [][\A j \in Jobs :
          Starts(j) => ~(\E r \in Jobs : Waiting(r) /\ Competes(r, j) /\ Rank(r) < Rank(j) /\ Free(r))]_vars

\* P4: within a lane, a job is never admitted while an earlier one waits for a place that is free for it.
FifoWithinLane ==
    [][\A j \in Jobs :
          Starts(j) =>
              ~(\E r \in Jobs : Waiting(r) /\ Competes(r, j) /\ Rank(r) = Rank(j) /\ seq[r] < seq[j] /\ Free(r))]_vars

\* P5: the hub cancels a run only when a newer run of the same repo, ref and workflow enters the queue in that step,
\* and never a release run, a merge-queue run or a run it does not govern.
CancelsOnlySuperseded ==
    [][\A x \in Jobs :
          (state[x] \notin {"cancelling", "cancelled"} /\ state'[x] \in {"cancelling", "cancelled"}) =>
              /\ x \in Governed
              /\ LaneOf(x) \notin {"release", "land"}
              /\ \E s \in Governed : SameKeyAs(s, x) /\ state[s] = "none" /\ state'[s] = "held"]_vars

\* P6: a start is answered `reused` only from a green run of the same input digest.
ReusesOnlyGreen ==
    [][\A j \in Jobs :
          (state[j] # "reused" /\ state'[j] = "reused") =>
              \E g \in Jobs : SameDigestAs(g, j) /\ state[g] = "green"]_vars

\* P7: while the owner paused admission, a start is refused and no job is admitted.
PausedStartsNothing ==
    [][paused =>
          \A j \in Governed :
              /\ (state[j] = "none" => state'[j] \in {"none", "refused"})
              /\ ~Starts(j)]_vars

\* P8: a lapsed lease is final: its entry is never admitted and its lease never holds again.
LapsedLeaseIsFinal ==
    [][\A j \in lapsed :
          state[j] = "held" => (~Starts(j) /\ (state'[j] = "held" => j \in lapsed'))]_vars

\* P9 (amended 14 Nov 2026 with the F1 decision): the first live entry in line that has a free place can be admitted
\* (unless paused): nothing ahead of it that cannot start itself (a lapsed entry, an entry whose own pool is full)
\* keeps it waiting, except for the account places a release entry ahead of it holds (P12).
OwnPoolFree(j) == Cardinality(In(PoolOf(j))) < Limit(PoolOf(j))
HoldsPlace(r) == Waiting(r) /\ r \in Release /\ PoolOf(r) \in Account /\ ~OwnPoolFree(r)
FreeFor(j) ==
    /\ Free(j)
    /\ (PoolOf(j) \in Account =>
           AccountLoad + Cardinality({r \in Jobs : HoldsPlace(r) /\ Ahead(r, j)}) < HostedCap)
FirstInLine(j) ==
    /\ Waiting(j)
    /\ FreeFor(j)
    /\ ~(\E r \in Jobs : Waiting(r) /\ Competes(r, j) /\ Ahead(r, j) /\ FreeFor(r))
FirstInLineCanStart == \A j \in Jobs : (~paused /\ FirstInLine(j)) => ENABLED Admit(j)

\* P10 (liveness, under Fairness): a release job that waits is admitted, unless its lease lapses first.
ReleaseEventuallyAdmitted ==
    \A j \in Release \ Outside : (state[j] = "held") ~> (state[j] = "dispatching" \/ j \in lapsed)

\* P11 (liveness, under Fairness): a held entry whose lease lapsed leaves the queue.
LapsedLeaves == \A j \in Governed : (state[j] = "held" /\ j \in lapsed) ~> (state[j] # "held")

\* P12 (added 14 Nov 2026 with the F1 decision): a release job whose own pool (macOS) has a free place is never kept
\* out by the account limit because the hub admitted a job behind it into the account after it arrived. Jobs the hub
\* does not govern can still take the account's places: a macOS place that frees is also an account place, and the
\* release entry holds one more, so only two outside jobs started after it arrived can have taken both.
BlockedByLaterAdmit(r) ==
    /\ Waiting(r)
    /\ r \in Release
    /\ PoolOf(r) \in Account
    /\ OwnPoolFree(r)
    /\ AccountLoad >= HostedCap
    /\ \E j \in Governed : Occupies(j) /\ PoolOf(j) \in Account /\ Ahead(r, j) /\ at[j] > seq[r]
ReleaseKeepsItsAccountPlace ==
    \A r \in Release \ Outside :
        BlockedByLaterAdmit(r) =>
            Cardinality({o \in Outside : PoolOf(o) \in Account /\ at[o] > seq[r]}) >= 2

(* ---- END FROZEN PROPERTIES ---- *)

\* ============================ Sanity (each must be violated) ============================

NeverAdmits == \A j \in Jobs : admits[j] = 0
NeverWaitsForAPlace == \A j \in Jobs : ~(Waiting(j) /\ ~Free(j))
NeverReuses == \A j \in Jobs : state[j] # "reused"
NeverCancelsARunningJob == \A j \in Jobs : state[j] # "cancelling"
NeverExpires == \A j \in Jobs : state[j] # "expired"
NeverRefuses == \A j \in Jobs : state[j] # "refused"
NeverFillsTheAccount == AccountLoad < HostedCap
NeverHoldsAnAccountPlace == \A r \in Jobs : ~HoldsPlace(r)
NeverBlockedByLaterAdmit == \A r \in Jobs : ~BlockedByLaterAdmit(r)
=============================================================================
