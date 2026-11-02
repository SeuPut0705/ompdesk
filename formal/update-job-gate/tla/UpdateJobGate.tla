------------------------- MODULE UpdateJobGate -------------------------
(* The automatic update's last look and its quit (2 Nov 2026).               *)
(* Main asks every omp for `composer.freeze_jobs`; each omp reads its job    *)
(* tree and, in the same synchronous step, closes a gate on every new tool   *)
(* call when no job runs and no tool call is under way (JobGate.freeze).     *)
(* Main installs (quits) only when every omp froze and none reported work or *)
(* a call under way; otherwise it thaws them all. Every job starts from a    *)
(* tool call, so with the gate closed nothing can start between the look    *)
(* and the quit.                                                             *)
(*                                                                           *)
(* The toggles below are the bug variants (matrix.json):                     *)
(*   Legacy / RequireFrozen   the plain look (`composer.jobs`, the old code) *)
(*   CountStarting = FALSE    a gate that ignores the calls under way        *)
(*   LeaseOutlastsRound=FALSE the lease may expire before the quit           *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Omps,               \* the omps main asks (the members of one freeze)
    CallsPer,           \* tool calls each omp can make in the run (slots)
    MaxJobs,            \* running jobs one omp can have at once
    MaxRounds,          \* freeze rounds main may start in the run
    CountStarting,      \* TRUE: freeze counts the tool calls under way (job-gate.ts:74-75)
    RequireFrozen,      \* TRUE: main installs only when every omp answered frozen (background-work.ts:278)
    Legacy,             \* omps whose answer is a plain look: rows only, no gate, no verdict
    LeaseOutlastsRound  \* TRUE: the 20 s lease never expires between the first freeze of a round and the quit

VARIABLES
    gate,    \* gate[o] \in {"open","closed"}: JobGate.#closed of omp o
    call,    \* call[o][c]: one tool call of omp o: idle, waiting at the closed gate, under way (past it), done
    jobs,    \* jobs[o]: running background jobs of omp o (a `bash` gone background, a `task`)
    inbox,   \* inbox[o]: requests main sent to omp o, in order, not handled yet
    outbox,  \* outbox[o]: answers omp o sent to main, in order, not read yet
    mphase,  \* main: "idle", "asking" (freeze sent, answers awaited), "installing" (install ran, quit not yet), "quit"
    mstat,   \* mstat[o]: main's view of this round's answer from o: none, pend, got, tmo (timed out)
    mans,    \* mans[o]: the answer main keeps (a timed-out one is unknown work)
    rounds   \* freeze rounds started

vars == <<gate, call, jobs, inbox, outbox, mphase, mstat, mans, rounds>>

Calls == 1..CallsPer
Round == 1..MaxRounds
Request == [kind : {"freeze", "thaw"}, rd : 0..MaxRounds]
Answer == [rd : 0..MaxRounds, frozen : BOOLEAN, work : BOOLEAN, starting : 0..CallsPer]
\* background-work.ts:366-367: a failed or slow answer is unknown work, never frozen
Unknown == [frozen |-> FALSE, work |-> TRUE, starting |-> 0]

TypeOK ==
    /\ gate \in [Omps -> {"open", "closed"}]
    /\ call \in [Omps -> [Calls -> {"idle", "waiting", "under", "done"}]]
    /\ jobs \in [Omps -> 0..MaxJobs]
    /\ inbox \in [Omps -> Seq(Request)]
    /\ outbox \in [Omps -> Seq(Answer)]
    /\ mphase \in {"idle", "asking", "installing", "quit"}
    /\ mstat \in [Omps -> {"none", "pend", "got", "tmo"}]
    /\ \A o \in Omps : mans[o].frozen \in BOOLEAN /\ mans[o].work \in BOOLEAN /\ mans[o].starting \in 0..CallsPer
    /\ rounds \in 0..MaxRounds

Underway(o) == {c \in Calls : call[o][c] = "under"}

\* FROZEN PROPERTIES (Properties.md)
\* The quit never cuts a job: when the app quits, no omp has a running job and no tool call is past the gate
\* (a call past the gate may still register a job).
NoJobCutByQuit ==
    mphase = "quit" => \A o \in Omps : jobs[o] = 0 /\ Underway(o) = {}

\* A gate main closed is opened again by main (thaw) unless the app quits: the lease is only the safety net,
\* so this is checked without fairness on `Expire`.
FrozenEventuallyThawed ==
    \A o \in Omps : [](gate[o] = "closed" => <>(gate[o] = "open" \/ mphase = "quit"))

\* A tool call held at the closed gate runs once the gate opens, or the app quits.
HeldEventuallyRuns ==
    \A o \in Omps : \A c \in Calls :
        [](call[o][c] = "waiting" => <>(call[o][c] # "waiting" \/ mphase = "quit"))
\* END FROZEN PROPERTIES

\* The same promise, only for a job already registered: the bug variants' traces (MC_bug*_job.cfg) show the job the quit cut.
NoRunningJobCutByQuit == mphase = "quit" => \A o \in Omps : jobs[o] = 0

\* Sanity properties: each MUST be violated (MC_sanity*.cfg), or the model cannot reach what it checks.
NeverQuits == mphase # "quit"
NeverHeld == \A o \in Omps : \A c \in Calls : call[o][c] # "waiting"
NeverPartialFreeze ==
    ~(mphase = "asking" /\ \E o1, o2 \in Omps : gate[o1] = "closed" /\ jobs[o2] > 0)

Init ==
    /\ gate = [o \in Omps |-> "open"]
    /\ call = [o \in Omps |-> [c \in Calls |-> "idle"]]
    /\ jobs = [o \in Omps |-> 0]
    /\ inbox = [o \in Omps |-> <<>>]
    /\ outbox = [o \in Omps |-> <<>>]
    /\ mphase = "idle"
    /\ mstat = [o \in Omps |-> "none"]
    /\ mans = [o \in Omps |-> Unknown]
    /\ rounds = 0

Live == mphase # "quit"

(***************************** the omp's side *****************************)

\* @code resources/gui-bridge/job-gate.ts:54-57 JobGate.enter: the gate is open, so the call is counted under way in the same step
\* @code resources/gui-bridge/composer.ts:656-659 stock's tool_call hook awaits enter
Enter(o, c) ==
    /\ Live
    /\ call[o][c] \in {"idle", "waiting"}
    /\ gate[o] = "open"
    /\ call' = [call EXCEPT ![o][c] = "under"]
    /\ UNCHANGED <<gate, jobs, inbox, outbox, mphase, mstat, mans, rounds>>

\* @code resources/gui-bridge/job-gate.ts:55 `while (this.#closed) await this.#closed.promise`: a call reaching the closed gate waits
Block(o, c) ==
    /\ Live
    /\ call[o][c] = "idle"
    /\ gate[o] = "closed"
    /\ call' = [call EXCEPT ![o][c] = "waiting"]
    /\ UNCHANGED <<gate, jobs, inbox, outbox, mphase, mstat, mans, rounds>>

\* Stock's side, not in this repo (a `bash` going to the background, a `task` spawning): a call past the gate registers a job.
Register(o, c) ==
    /\ Live
    /\ call[o][c] = "under"
    /\ jobs[o] < MaxJobs
    /\ jobs' = [jobs EXCEPT ![o] = jobs[o] + 1]
    /\ UNCHANGED <<gate, call, inbox, outbox, mphase, mstat, mans, rounds>>

\* @code resources/gui-bridge/job-gate.ts:60-62 JobGate.leave (`tool_execution_end`)
\* @code resources/gui-bridge/job-gate.ts:65-67 JobGate.agentEnded (an agent's loop ended: its calls are no longer under way)
\* @code resources/gui-bridge/composer.ts:660-665 the hooks that call leave and agentEnded
Leave(o, c) ==
    /\ Live
    /\ call[o][c] = "under"
    /\ call' = [call EXCEPT ![o][c] = "done"]
    /\ UNCHANGED <<gate, jobs, inbox, outbox, mphase, mstat, mans, rounds>>

\* Environment: a background job finishes (or is cancelled).
JobEnd(o) ==
    /\ Live
    /\ jobs[o] > 0
    /\ jobs' = [jobs EXCEPT ![o] = jobs[o] - 1]
    /\ UNCHANGED <<gate, call, inbox, outbox, mphase, mstat, mans, rounds>>

\* @code resources/gui-bridge/composer.ts:435-447 composer.freeze_jobs: the tree read and the gate's decision are one synchronous step
\* @code resources/gui-bridge/job-gate.ts:73-80 JobGate.freeze: closes the gate only when no job runs and no call is under way
\* @code src/main/background-work.ts:354-369 freezeMember reads `frozen`, `work`, `starting` of the answer
FreezeAt(o) ==
    /\ Live
    /\ inbox[o] # <<>> /\ Head(inbox[o]).kind = "freeze"
    /\ inbox' = [inbox EXCEPT ![o] = Tail(inbox[o])]
    /\ LET running == jobs[o] > 0
           starting == IF CountStarting THEN Cardinality(Underway(o)) ELSE 0
           holdOpen == running \/ starting > 0 \/ o \in Legacy
       IN /\ outbox' = [outbox EXCEPT ![o] = Append(@, [rd |-> Head(inbox[o]).rd, frozen |-> ~holdOpen,
                                                       work |-> running, starting |-> IF o \in Legacy THEN 0 ELSE starting])]
          /\ gate' = IF holdOpen THEN gate ELSE [gate EXCEPT ![o] = "closed"]
    /\ UNCHANGED <<call, jobs, mphase, mstat, mans, rounds>>

\* @code resources/gui-bridge/composer.ts:450 composer.thaw_jobs
\* @code resources/gui-bridge/job-gate.ts:83-91 JobGate.thaw: the gate opens, the calls it held run
ThawAt(o) ==
    /\ Live
    /\ inbox[o] # <<>> /\ Head(inbox[o]).kind = "thaw"
    /\ inbox' = [inbox EXCEPT ![o] = Tail(inbox[o])]
    /\ gate' = [gate EXCEPT ![o] = "open"]
    /\ UNCHANGED <<call, jobs, outbox, mphase, mstat, mans, rounds>>

\* Environment: the lease timer (20 s, at most 25 s) fires `thaw()` on its own. The assumption of the passing model:
\* it does not fire while main's round is under way or the install is on its way to the quit (LeaseOutlastsRound).
Expire(o) ==
    /\ Live
    /\ gate[o] = "closed"
    /\ LeaseOutlastsRound => mphase = "idle"
    /\ gate' = [gate EXCEPT ![o] = "open"]
    /\ UNCHANGED <<call, jobs, inbox, outbox, mphase, mstat, mans, rounds>>

(****************************** main's side *******************************)

\* @code src/main/app-auto-update.ts:302 effects.verify at the countdown's end (#safeToInstall found no fresh frozen answer)
\* @code src/main/updater.ts:939 verify: probe.backgroundWork.freeze().then(() => autoInstall?.tick())
\* @code src/main/background-work.ts:262-275 freeze() asks every member with composer.freeze_jobs
StartRound ==
    /\ mphase = "idle"
    /\ rounds < MaxRounds
    /\ rounds' = rounds + 1
    /\ mphase' = "asking"
    /\ inbox' = [o \in Omps |-> Append(inbox[o], [kind |-> "freeze", rd |-> rounds + 1])]
    /\ mstat' = [o \in Omps |-> "pend"]
    /\ UNCHANGED <<gate, call, jobs, outbox, mans>>

\* @code src/main/background-work.ts:272-274 the answer of one member lands (an answer of an earlier round is no one's: its promise settled)
Deliver(o) ==
    /\ Live
    /\ outbox[o] # <<>>
    /\ outbox' = [outbox EXCEPT ![o] = Tail(outbox[o])]
    /\ LET a == Head(outbox[o])
       IN IF mphase = "asking" /\ mstat[o] = "pend" /\ a.rd = rounds
          THEN /\ mstat' = [mstat EXCEPT ![o] = "got"]
               /\ mans' = [mans EXCEPT ![o] = [frozen |-> a.frozen, work |-> a.work, starting |-> a.starting]]
          ELSE UNCHANGED <<mstat, mans>>
    /\ UNCHANGED <<gate, call, jobs, inbox, mphase, rounds>>

\* Environment (main's clock): one request's own timeout (3 s) ends before the answer came; the omp may still freeze later.
\* @code src/main/background-work.ts:332-342 requestInTime rejects; background-work.ts:366-368 freezeMember answers unknown work
Timeout(o) ==
    /\ Live
    /\ mphase = "asking" /\ mstat[o] = "pend"
    /\ mstat' = [mstat EXCEPT ![o] = "tmo"]
    /\ mans' = [mans EXCEPT ![o] = Unknown]
    /\ UNCHANGED <<gate, call, jobs, inbox, outbox, mphase, rounds>>

\* Nothing missing: every member answered or timed out (Promise.all), so the .then of freeze() runs.
Answered == \A o \in Omps : mstat[o] # "pend"

\* @code src/main/background-work.ts:278 `stopped === asked.length && !hasBackgroundWork(work) && !work.starting`
\* @code src/main/app-auto-update.ts:301 `fresh && backgroundWorkFrozen`
AllClear ==
    \A o \in Omps :
        /\ mans[o].work = FALSE
        /\ mans[o].starting = 0
        /\ (RequireFrozen => mans[o].frozen)

\* @code src/main/background-work.ts:285-287 every omp stopped and none runs work: `#frozen = asked`, the answer lands
\* @code src/main/app-auto-update.ts:215-241 the tick after it: #safeToInstall true, `effects.install()` (restartIntoUpdate: updater.ts:845)
DecideInstall ==
    /\ mphase = "asking" /\ Answered /\ AllClear
    /\ mphase' = "installing"
    /\ mstat' = [o \in Omps |-> "none"]
    /\ UNCHANGED <<gate, call, jobs, inbox, outbox, mans, rounds>>

\* @code src/main/background-work.ts:279-283 one omp still runs (or may start) work, or answered nothing: every omp asked is thawed
DecidePartial ==
    /\ mphase = "asking" /\ Answered /\ ~AllClear
    /\ mphase' = "idle"
    /\ mstat' = [o \in Omps |-> "none"]
    /\ inbox' = [o \in Omps |-> Append(inbox[o], [kind |-> "thaw", rd |-> rounds])]
    /\ UNCHANGED <<gate, call, jobs, outbox, mans, rounds>>

\* @code src/main/app-auto-update.ts:294-299 the tick holds for another reason (a card, a compaction): `effects.thaw()` lets every frozen omp go
\* @code src/main/background-work.ts:296-300 thaw()
DecideHold ==
    /\ mphase = "asking" /\ Answered /\ AllClear
    /\ mphase' = "idle"
    /\ mstat' = [o \in Omps |-> "none"]
    /\ inbox' = [o \in Omps |-> Append(inbox[o], [kind |-> "thaw", rd |-> rounds])]
    /\ UNCHANGED <<gate, call, jobs, outbox, mans, rounds>>

\* @code src/main/updater.ts:845-873 restartIntoUpdate: the installer starts (seconds on Windows), then the app quits and every omp ends
Quit ==
    /\ mphase = "installing"
    /\ mphase' = "quit"
    /\ UNCHANGED <<gate, call, jobs, inbox, outbox, mstat, mans, rounds>>

OmpStep(o) == FreezeAt(o) \/ ThawAt(o) \/ Deliver(o) \/ JobEnd(o) \/ Expire(o)
              \/ \E c \in Calls : Enter(o, c) \/ Block(o, c) \/ Register(o, c) \/ Leave(o, c)
MainStep == StartRound \/ DecideInstall \/ DecidePartial \/ DecideHold \/ Quit \/ \E o \in Omps : Timeout(o)

Step == MainStep \/ \E o \in Omps : OmpStep(o)
\* After the quit, or when the bounds ran out, nothing moves; the end is not a deadlock.
Next == Step \/ (UNCHANGED vars)

Fairness ==
    /\ WF_vars(DecideInstall) /\ WF_vars(DecidePartial) /\ WF_vars(DecideHold) /\ WF_vars(Quit)
    /\ \A o \in Omps : WF_vars(FreezeAt(o)) /\ WF_vars(ThawAt(o)) /\ WF_vars(Deliver(o))
    /\ \A o \in Omps : \A c \in Calls : WF_vars(Enter(o, c))

Spec == Init /\ [][Next]_vars /\ Fairness
=============================================================================
