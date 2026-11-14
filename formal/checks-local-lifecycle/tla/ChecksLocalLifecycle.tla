------------------------- MODULE ChecksLocalLifecycle -------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANT Workers
None == "none"
Epochs == 0..Cardinality(Workers)
WorkerSymmetry == Permutations(Workers)

VARIABLE s
vars == <<s>>

Initial ==
         [ paused |-> FALSE,
           stopped |-> [w \in Workers |-> FALSE],
           core |-> [w \in Workers |-> "live"],
           admission |-> [w \in Workers |-> "new"],
           phase |-> [w \in Workers |-> "new"],
           a |-> None, b |-> None, bOwner |-> None,
           epoch |-> 0, broken |-> FALSE,
           childEpoch |-> [w \in Workers |-> 0],
           child |-> [w \in Workers |-> "none"],
           kind |-> [w \in Workers |-> None], sha |-> None,
           named |-> [w \in Workers |-> FALSE],
           cancel |-> [w \in Workers |-> FALSE],
           cancelSent |-> [w \in Workers |-> FALSE],
           returned |-> [w \in Workers |-> FALSE],
           fallbackReady |-> [w \in Workers |-> FALSE],
           fallback |-> [w \in Workers |-> FALSE],
           badPause |-> FALSE, badFallback |-> FALSE,
           badEpoch |-> FALSE, badSha |-> FALSE,
           badReturn |-> FALSE, badRepair |-> FALSE, badDamagedWork |-> FALSE ]

Init == s = Initial

\* A reachable three-worker prefix: delayed epoch-1 starter, epoch-2 active worker
\* whose core died, and a third core holding A while it waits for that worker's B.
WorkerBusyInit ==
  \E late, old, fresh \in Workers :
    /\ late # old /\ old # fresh /\ late # fresh
    /\ s = [Initial EXCEPT
         !.admission = [w \in Workers |-> "accepted"],
         !.phase[late] = "reserved", !.phase[old] = "reserved", !.phase[fresh] = "a",
         !.core[late] = "dead", !.core[old] = "dead",
         !.stopped[late] = TRUE, !.stopped[old] = TRUE,
         !.cancel[late] = TRUE, !.cancel[old] = TRUE,
         !.a = fresh, !.b = old, !.bOwner = "worker", !.epoch = 2,
         !.childEpoch[late] = 1, !.childEpoch[old] = 2,
         !.child[late] = "pending", !.child[old] = "active",
         !.kind[late] = "check", !.kind[old] = "git", !.sha = old]

TypeOK ==
  /\ s.paused \in BOOLEAN /\ s.broken \in BOOLEAN
  /\ s.stopped \in [Workers -> BOOLEAN] /\ s.core \in [Workers -> {"live", "dead"}]
  /\ s.admission \in [Workers -> {"new", "accepted", "refused"}]
  /\ s.phase \in [Workers -> {"new", "a", "b", "reserved", "failed"}]
  /\ s.a \in Workers \cup {None} /\ s.b \in Workers \cup {None}
  /\ s.bOwner \in {None, "core", "worker"} /\ s.epoch \in Epochs
  /\ s.childEpoch \in [Workers -> Epochs]
  /\ s.child \in [Workers -> {"none", "pending", "held", "active", "cleanup", "done", "rejected"}]
  /\ s.kind \in [Workers -> {None, "git", "setup", "check"}] /\ s.sha \in Workers \cup {None}
  /\ s.named \in [Workers -> BOOLEAN] /\ s.cancel \in [Workers -> BOOLEAN]
  /\ s.cancelSent \in [Workers -> BOOLEAN] /\ s.returned \in [Workers -> BOOLEAN]
  /\ s.fallback \in [Workers -> BOOLEAN] /\ s.fallbackReady \in [Workers -> BOOLEAN]
  /\ s.badPause \in BOOLEAN /\ s.badFallback \in BOOLEAN /\ s.badEpoch \in BOOLEAN
  /\ s.badSha \in BOOLEAN /\ s.badReturn \in BOOLEAN /\ s.badRepair \in BOOLEAN
  /\ s.badDamagedWork \in BOOLEAN

\* The owner may pause or resume between admissions.
TogglePause == s' = [s EXCEPT !.paused = ~@]

\* @code native/ompdesk/crates/core/src/checks/hub_local.rs:234-265 the receiving hub refuses a paused local request
Admit(w) ==
  /\ s.core[w] = "live" /\ s.admission[w] = "new"
  /\ ~s.paused  \* pause-admission
  /\ s' = [s EXCEPT !.admission[w] = "accepted", !.badPause = @ \/ s.paused]

\* @code native/ompdesk/crates/core/src/checks/hub_local.rs:234-265 pause refusal
Refuse(w) ==
  /\ s.admission[w] = "new" /\ s.paused
  /\ s' = [s EXCEPT !.admission[w] = "refused"]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:211-241 acquire the checkout A lock
\* @code native/ompdesk/crates/core/src/checks/local_run.rs:489-490 hold A across the local run
TakeA(w) ==
  /\ s.core[w] = "live" /\ ~s.stopped[w] /\ s.admission[w] = "accepted"
  /\ s.phase[w] = "new" /\ s.a = None
  /\ s' = [s EXCEPT !.a = w, !.phase[w] = "a"]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:491-494 acquire B before changing the epoch
TakeCoreB(w) ==
  /\ s.core[w] = "live" /\ s.a = w /\ s.phase[w] = "a" /\ s.b = None
  /\ s' = [s EXCEPT !.b = w, !.bOwner = "core", !.phase[w] = "b"]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:495-524 advance the epoch while B is held
Reserve(w) ==
  /\ s.core[w] = "live" /\ s.phase[w] = "b" /\ s.b = w /\ s.bOwner = "core"
  /\ ~s.broken \* damaged-epoch
  /\ s.epoch < Cardinality(Workers)
  /\ s' = [s EXCEPT !.epoch = @ + 1, !.childEpoch[w] = s.epoch + 1,
             !.phase[w] = "reserved", !.b = None, !.bOwner = None,
             !.badRepair = @ \/ s.broken]

\* An existing epoch may become unreadable. It cannot repair itself.
DamageEpoch(w) ==
  /\ s.core[w] = "live" /\ s.phase[w] = "b" /\ s.b = w /\ s.bOwner = "core" /\ ~s.broken
  /\ s' = [s EXCEPT !.broken = TRUE, !.phase[w] = "failed", !.a = None, !.b = None, !.bOwner = None]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:495-524 unreadable epoch fails closed
FailEpoch(w) ==
  /\ s.core[w] = "live" /\ s.phase[w] = "b" /\ s.broken /\ s.b = w /\ s.bOwner = "core"
  /\ s' = [s EXCEPT !.phase[w] = "failed", !.a = None, !.b = None, !.bOwner = None]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:256-448 spawn a guarded git or setup command
\* @code native/ompdesk/crates/core/src/checks/local_run.rs:525-562 spawn the check starter
Launch(w, k) ==
  /\ s.core[w] = "live" /\ ~s.stopped[w] /\ ~s.cancel[w]
  /\ s.phase[w] = "reserved" /\ s.a = w /\ s.child[w] = "none"
  /\ k \in {"git", "setup", "check"}
  /\ s' = [s EXCEPT !.child[w] = "pending", !.kind[w] = k, !.named[w] = FALSE, !.cancelSent[w] = FALSE]

\* @code native/ompdesk/crates/checks/src/check.rs:48-103 a spawned supervisor or detached check takes B
TakeWorkerB(w) ==
  /\ s.child[w] = "pending"
  /\ s.b = None  \* worker-B
  /\ s' = [s EXCEPT !.b = w, !.bOwner = "worker", !.child[w] = "held"]

\* @code native/ompdesk/crates/checks/src/check.rs:48-103 validate generation and SHA under B
\* @code native/ompdesk/crates/checks/src/check.rs:125-158 acquire the setup guard before spawning work
BeginWork(w) ==
  /\ s.child[w] = "held"
  /\ ~s.broken \* readable-epoch
  /\ s.childEpoch[w] = s.epoch \* epoch-fence
  /\ (s.kind[w] = "git" \/ s.sha = w) \* sha-fence
  /\ s' = [s EXCEPT !.child[w] = "active",
             !.badEpoch = @ \/ (s.childEpoch[w] # s.epoch),
             !.badDamagedWork = @ \/ s.broken,
             !.badSha = @ \/ (s.kind[w] # "git" /\ s.sha # w),
             !.sha = IF s.kind[w] = "git" THEN w ELSE @]

\* @code native/ompdesk/crates/checks/src/check.rs:48-103 a stale generation or wrong SHA is refused under B
RejectStale(w) ==
  /\ s.child[w] = "held" /\ (s.broken \/ s.childEpoch[w] # s.epoch \/ (s.kind[w] # "git" /\ s.sha # w))
  /\ s' = [s EXCEPT !.child[w] = "rejected", !.b = None, !.bOwner = None]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:569-585 the starter may name its journal after cancellation
ObserveId(w) ==
  /\ s.kind[w] = "check" /\ s.child[w] \in {"pending", "held", "active", "cleanup"} /\ ~s.named[w]
  /\ s' = [s EXCEPT !.named[w] = TRUE]

\* A request can be cancelled before or after its journal id is observed.
RequestCancel(w) ==
  /\ ~s.cancel[w] /\ ~s.returned[w]
  /\ s' = [s EXCEPT !.cancel[w] = TRUE]

\* @code native/ompdesk/crates/core/src/checks/hub.rs:341-347 hub drop signals its work
Stop(w) ==
  /\ s.core[w] = "live" /\ ~s.stopped[w]
  /\ s' = [s EXCEPT !.stopped[w] = TRUE, !.cancel[w] = TRUE]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:450-463 send cancellation to the CLI runner
\* @code native/ompdesk/crates/core/src/checks/local_run.rs:569-604 wait until its id is known
SendCancel(w) ==
  /\ s.cancel[w] /\ s.named[w] /\ ~s.cancelSent[w] /\ s.kind[w] = "check"
  /\ s' = [s EXCEPT !.cancelSent[w] = TRUE]

\* @code native/ompdesk/crates/checks/src/check.rs:48-103 a waiting guard observes cancellation
\* @code native/ompdesk/crates/checks/src/check.rs:110-138 setup can stop before touching the checkout
CancelWaiting(w) ==
  /\ s.child[w] \in {"pending", "held"}
  /\ s.cancel[w] /\ (s.kind[w] # "check" \/ s.cancelSent[w])
  /\ s' = [s EXCEPT !.child[w] = "done",
             !.b = IF s.child[w] = "held" THEN None ELSE @,
             !.bOwner = IF s.child[w] = "held" THEN None ELSE @]

\* @code native/ompdesk/crates/checks/src/check.rs:159-179 setup enters cleanup before B is released
\* @code native/ompdesk/crates/checks/src/check.rs:1190-1266 the check runner retains its guard through cleanup
BeginCleanup(w) ==
  /\ s.child[w] = "active"
  /\ s' = [s EXCEPT !.child[w] = "cleanup"]

\* @code native/ompdesk/crates/checks/src/check.rs:159-179 setup releases B after cleanup
\* @code native/ompdesk/crates/checks/src/check.rs:1190-1266 the check runner releases its guard after cleanup
EndCleanup(w) ==
  /\ s.child[w] = "cleanup"
  /\ s' = [s EXCEPT !.child[w] = IF s.core[w] = "live" /\ ~s.cancel[w] /\ ~s.stopped[w] THEN "none" ELSE "done",
             !.b = None, !.bOwner = None]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:592-611 cancellation returns only after the child and journal cleanup
ReturnCancelled(w) ==
  /\ s.core[w] = "live" /\ s.cancel[w] /\ ~s.returned[w]
  /\ s.child[w] \in {"none", "done", "rejected"} \* cleanup-joined
  /\ s' = [s EXCEPT !.returned[w] = TRUE,
             !.badReturn = @ \/ (s.child[w] \notin {"none", "done", "rejected"}),
             !.a = IF s.a = w THEN None ELSE @]

\* @code native/ompdesk/crates/core/src/checks/hub_local.rs:189-208 an unavailable placement begins fallback
PrepareFallback(w) ==
  /\ s.core[w] = "live" /\ s.admission[w] = "accepted" /\ ~s.stopped[w] /\ ~s.fallbackReady[w]
  /\ s' = [s EXCEPT !.fallbackReady[w] = TRUE]

\* @code native/ompdesk/crates/core/src/checks/hub.rs:811-916 the actual dispatch must recheck stop after awaits
Fallback(w) ==
  /\ s.core[w] = "live" /\ s.fallbackReady[w] /\ ~s.fallback[w]
  /\ ~s.stopped[w] \* stop-fallback
  /\ s' = [s EXCEPT !.fallback[w] = TRUE, !.badFallback = @ \/ s.stopped[w]]

\* @code native/ompdesk/crates/core/src/checks/local_run.rs:410-418 isolate the B owner from the POSIX core group's death
\* A core can die at any point; its A and core-owned B are released, not B held by the surviving supervisor.
Crash(w) ==
  /\ s.core[w] = "live"
  /\ s' = [s EXCEPT !.core[w] = "dead", !.stopped[w] = TRUE, !.cancel[w] = TRUE,
             !.a = IF s.a = w THEN None ELSE @,
             !.b = IF s.b = w /\ s.bOwner = "core" THEN None ELSE @,
             !.bOwner = IF s.b = w /\ s.bOwner = "core" THEN None ELSE @]

\* Frozen protocol properties. Do not weaken these to make a run pass.
NoPausedDestinationStart == ~s.badPause
NoFallbackAfterStop == ~s.badFallback
NoCheckoutOverlap == Cardinality({w \in Workers : s.child[w] \in {"active", "cleanup"}}) <= 1
NoStaleGenerationWork == ~s.badEpoch
NoWrongShaWork == ~s.badSha
NoReturnBeforeCleanup == ~s.badReturn
NoWorkOnDamagedEpoch == ~s.badDamagedWork
NoAutomaticEpochRepair == ~s.badRepair
\* End frozen protocol properties.

Next ==
  \/ TogglePause
  \/ \E w \in Workers : Admit(w) \/ Refuse(w) \/ TakeA(w) \/ TakeCoreB(w) \/ Reserve(w)
       \/ DamageEpoch(w) \/ FailEpoch(w) \/ (\E k \in {"git", "setup", "check"} : Launch(w, k))
       \/ TakeWorkerB(w) \/ BeginWork(w) \/ RejectStale(w) \/ ObserveId(w)
       \/ RequestCancel(w) \/ Stop(w) \/ SendCancel(w) \/ CancelWaiting(w)
       \/ BeginCleanup(w) \/ EndCleanup(w) \/ ReturnCancelled(w) \/ PrepareFallback(w) \/ Fallback(w) \/ Crash(w)

Spec == Init /\ [][Next]_vars
BusySpec == WorkerBusyInit /\ [][Next]_vars
=============================================================================
