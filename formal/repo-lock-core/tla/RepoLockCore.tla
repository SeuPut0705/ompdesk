---------------------------- MODULE RepoLockCore ----------------------------
(* A repository-lock holder whose git runs in the core process (unit 2c).    *)
(* Main sends one request in a lock step (coreGit), tracks it as the step's  *)
(* effect until the core is done with it (onEnded), and asks the core to     *)
(* cancel it when the step is stopped or the call's timeout ran out. The     *)
(* core registers the request's cancel flag, its handler runs up to MaxGits  *)
(* gits (Par at once), starts none once cancelled and ends the running ones, *)
(* and answers only when no git of the request is alive. The next holder    *)
(* starts once the stopped step's effects settled. The core can die: its    *)
(* gits are in its process group (POSIX) or job object (Windows), and main  *)
(* settles what waited on it only once none of them is alive.               *)
(* Since unit 2f a request may make a scratch object store on disk (a merge *)
(* prediction, a landing check under an orphan removal's lock) and removes   *)
(* it before its handler returns.                                            *)
(* Constants pick the code (all TRUE, BoundMayPass FALSE) or a variant.      *)
EXTENDS Naturals, Sequences

CONSTANTS MaxGits, Par, WaitGroup, SettleOnAnswer, CoreMayDie, KillGroup, BoundMayPass

VARIABLES step, req, toCore, toMain, registered, cancelled, handler, gits, alive,
          answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch
vars == <<step, req, toCore, toMain, registered, cancelled, handler, gits, alive,
          answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

TypeOK ==
    /\ step \in {"running", "stopped", "done"}
    /\ req \in {"none", "pending", "late", "settled"}
    /\ toCore \in Seq({"request", "cancel"})
    /\ toMain \in Seq({"answer"})
    /\ registered \in BOOLEAN /\ cancelled \in BOOLEAN /\ answered \in BOOLEAN
    /\ handler \in {"idle", "running", "finished"}
    /\ gits \in 0..MaxGits /\ alive \in 0..Par
    /\ coreUp \in BOOLEAN
    /\ nextHolder \in {"waiting", "running"}
    /\ spawnedAfterStop \in BOOLEAN /\ timedOut \in BOOLEAN
    /\ scratch \in {"none", "made", "gone"}

Init ==
    /\ step = "running" /\ req = "none" /\ toCore = <<>> /\ toMain = <<>>
    /\ registered = FALSE /\ cancelled = FALSE /\ handler = "idle"
    /\ gits = 0 /\ alive = 0 /\ answered = FALSE /\ coreUp = TRUE
    /\ nextHolder = "waiting" /\ spawnedAfterStop = FALSE /\ timedOut = FALSE
    /\ scratch = "none"

\* @code src/main/local/git/exec.ts:161-195 heldRequest (coreGit, coreGh): a live step sends its request; its end is the step's tracked effect
Send ==
    /\ step = "running" /\ req = "none" /\ coreUp
    /\ req' = "pending" /\ toCore' = Append(toCore, "request")
    /\ UNCHANGED <<step, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* Environment: the step ran past its bound (serial-chain.ts #step timer, or its caller's step was stopped).
\* @code src/main/core/process.ts:259-260 the signal's abort listener writes {"cancel": id} while the call waits
Stop ==
    /\ step = "running"
    /\ step' = "stopped"
    /\ toCore' = IF req = "pending" /\ coreUp THEN Append(toCore, "cancel") ELSE toCore
    /\ UNCHANGED <<req, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* Environment: the call's own timeout passes.
\* @code src/main/core/process.ts:248-254 the caller fails, the request goes on waiting for its end, the core is asked to cancel
Timeout ==
    /\ req = "pending" /\ coreUp
    /\ req' = IF SettleOnAnswer THEN "late" ELSE "settled"
    /\ toCore' = Append(toCore, "cancel") /\ timedOut' = TRUE
    /\ UNCHANGED <<step, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, scratch>>

\* @code src/main/local/git/scm.ts:87-95 mutate: the step's code ends once its call answered or failed
StepEnds ==
    /\ step = "running" /\ req \in {"late", "settled"}
    /\ step' = "done"
    /\ UNCHANGED <<req, toCore, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code native/ompdesk/crates/core/src/server.rs:194-211 a request registers its cancel flag before the next frame is read
CoreReadsRequest ==
    /\ coreUp /\ toCore # <<>> /\ Head(toCore) = "request"
    /\ toCore' = Tail(toCore) /\ registered' = TRUE /\ handler' = "running"
    /\ UNCHANGED <<step, req, toMain, cancelled, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code native/ompdesk/crates/core/src/server.rs:188-193 a cancel sets the flag of a request still in flight; else nothing
CoreReadsCancel ==
    /\ coreUp /\ toCore # <<>> /\ Head(toCore) = "cancel"
    /\ toCore' = Tail(toCore)
    /\ cancelled' = (cancelled \/ (registered /\ ~answered))
    /\ UNCHANGED <<step, req, toMain, registered, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code native/ompdesk/crates/core/src/run.rs:93-95 a git (or gh) starts only while its request is not cancelled
Spawn ==
    /\ coreUp /\ handler = "running" /\ ~cancelled /\ gits < MaxGits /\ alive < Par
    /\ gits' = gits + 1 /\ alive' = alive + 1
    /\ spawnedAfterStop' = (spawnedAfterStop \/ step = "stopped")
    /\ UNCHANGED <<step, req, toCore, toMain, registered, cancelled, handler, answered, coreUp, nextHolder, timedOut, scratch>>

\* @code native/ompdesk/crates/core/src/run.rs:246-266 supervise: the git (or gh) exits (by itself, or ended after a cancel or its timeout)
GitExits ==
    /\ alive > 0
    /\ alive' = alive - 1
    /\ UNCHANGED <<step, req, toCore, toMain, registered, cancelled, handler, gits, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code native/ompdesk/crates/core/src/git/branches.rs:198-204 Scratch::new: the request makes its scratch object store (whether or not it was cancelled)
MakeScratch ==
    /\ coreUp /\ handler = "running" /\ scratch = "none"
    /\ scratch' = "made"
    /\ UNCHANGED <<step, req, toCore, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut>>

\* @code native/ompdesk/crates/core/src/git/branches.rs:211-215 Scratch's drop removes it when the function that made it returns, inside the handler
DropScratch ==
    /\ coreUp /\ handler = "running" /\ scratch = "made"
    /\ scratch' = "gone"
    /\ UNCHANGED <<step, req, toCore, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut>>

\* @code native/ompdesk/crates/core/src/server.rs:241-251 the handler returns (done, failed or cancelled); a git's task may still run, the scratch store is gone
HandlerEnds ==
    /\ coreUp /\ handler = "running"
    /\ scratch # "made"
    /\ handler' = "finished"
    /\ UNCHANGED <<step, req, toCore, toMain, registered, cancelled, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code native/ompdesk/crates/core/src/server.rs:252-253 the answer waits until every scope clone (a git's supervisor) is gone
CoreAnswers ==
    /\ coreUp /\ handler = "finished" /\ ~answered
    /\ WaitGroup => alive = 0
    /\ answered' = TRUE /\ toMain' = Append(toMain, "answer")
    /\ UNCHANGED <<step, req, toCore, registered, cancelled, handler, gits, alive, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code src/main/core/process.ts:322-354 #receive: the answer, also a late one, calls onEnded
MainReceives ==
    /\ toMain # <<>>
    /\ toMain' = Tail(toMain)
    /\ req' = IF req \in {"pending", "late"} THEN "settled" ELSE req
    /\ UNCHANGED <<step, toCore, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* Environment: the core process dies (a crash, a kill, stop()'s kill). Its gits are still alive at that moment.
CoreDies ==
    /\ CoreMayDie /\ coreUp
    /\ coreUp' = FALSE /\ toCore' = <<>> /\ toMain' = <<>>
    /\ UNCHANGED <<step, req, registered, cancelled, handler, gits, alive, answered, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code src/main/core/process.ts:356-387 #ended: once the core's group is gone (groupGone), what waited on it settles
MainSeesDeath ==
    /\ ~coreUp /\ req \in {"pending", "late"}
    /\ KillGroup => alive = 0
    /\ req' = "settled"
    /\ UNCHANGED <<step, toCore, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* Environment: a git of the dead core outlives SIGKILL past GROUP_GONE_MS (a process stuck in the kernel).
\* @code src/main/core/process.ts:68-80 groupGone answers false past its bound; #ended settles anyway, naming it
BoundPasses ==
    /\ BoundMayPass /\ ~coreUp /\ req \in {"pending", "late"} /\ alive > 0
    /\ req' = "settled"
    /\ UNCHANGED <<step, toCore, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, nextHolder, spawnedAfterStop, timedOut, scratch>>

\* @code src/main/serial-chain.ts:262-269 #clearHolds: after a stopped step, the next one starts once its effects settled
NextStarts ==
    /\ nextHolder = "waiting" /\ step # "running"
    /\ step = "stopped" => req \in {"none", "settled"}
    /\ nextHolder' = "running"
    /\ UNCHANGED <<step, req, toCore, toMain, registered, cancelled, handler, gits, alive, answered, coreUp, spawnedAfterStop, timedOut, scratch>>

Step ==
    \/ Send \/ Stop \/ Timeout \/ StepEnds \/ CoreReadsRequest \/ CoreReadsCancel \/ Spawn \/ GitExits
    \/ MakeScratch \/ DropScratch
    \/ HandlerEnds \/ CoreAnswers \/ MainReceives \/ CoreDies \/ MainSeesDeath \/ BoundPasses \/ NextStarts

\* Everything has run its course: the next holder runs and the request is over.
Finished == nextHolder = "running" /\ alive = 0 /\ req \in {"none", "settled"} /\ (coreUp => handler # "running")

Next == Step \/ (Finished /\ UNCHANGED vars)

Fairness ==
    /\ WF_vars(Send) /\ WF_vars(StepEnds) /\ WF_vars(CoreReadsRequest) /\ WF_vars(CoreReadsCancel)
    /\ WF_vars(GitExits) /\ WF_vars(DropScratch) /\ WF_vars(HandlerEnds) /\ WF_vars(CoreAnswers)
    /\ WF_vars(MainReceives) /\ WF_vars(MainSeesDeath) /\ WF_vars(NextStarts)

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
\* ===== Frozen properties (Properties.md) =====
\* P1: the next holder never runs while a git of the stopped holder's request is alive.
NoOverlapAfterStop == (nextHolder = "running" /\ step = "stopped") => alive = 0
\* P2: once the core read the cancel, the request starts no git.
NoSpawnAfterCancel == [][cancelled => gits' = gits]_vars
\* P3: a request answers only when its handler returned.
AnswerAfterHandler == answered => handler = "finished"
\* P4: a stopped holder hands the lock on: the next holder runs.
StopReleases == (step = "stopped") ~> (nextHolder = "running")
\* P5: a stopped holder's request still in flight is cancelled in the core once the core read what main sent.
CancelReachesCore ==
    (step = "stopped" /\ req = "pending" /\ registered /\ ~answered /\ coreUp /\ toCore = <<>>) => cancelled
\* P6: after the core died, the next holder never runs while a git it started is alive (a step that timed out is the
\* call timeout's own case: the caller heard at once, as execBin's timeout told it, and the git is being ended).
NoOverlapAfterCoreDeath == (nextHolder = "running" /\ ~coreUp /\ ~timedOut) => alive = 0
\* P7 (unit 2f): while the core lives, the next holder never runs while the stopped holder's request still has its
\* scratch store on disk (a core that died leaves it behind, as a main that died left its mkdtemp folder).
NoScratchAfterStop == (nextHolder = "running" /\ step = "stopped" /\ coreUp) => scratch # "made"
\* ===== End frozen properties =====

\* Sanity (must FAIL): a git can start after the stop, before the cancel reached the core.
NoSpawnAfterStop == ~spawnedAfterStop
=============================================================================
