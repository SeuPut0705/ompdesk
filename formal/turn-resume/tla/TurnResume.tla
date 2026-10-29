---------------------------- MODULE TurnResume ----------------------------
(* Model of OMPdesk's connection wait: a turn that failed on the network is   *)
(* probed (ConnectivityMonitor.verify), held, flushed when connectivity       *)
(* returns, and retried by stock `retry`; plus the scheduled backoff retry    *)
(* and the relaunch's own wait (launch() while offline).                      *)
(* Code: src/main/turn-resume.ts (TurnResume) + src/main/connectivity.ts.     *)
(*                                                                            *)
(* Granularity. Every action below is one macrotask of the code (a pool event *)
(* with the `sync()` it triggers, a timer, a promise continuation that waited *)
(* on I/O). `sync()` and `flush()` are synchronous regions: they run as a     *)
(* chain of micro-steps under a program counter `pc` that no other action can *)
(* interleave with. Promise continuations that only wait on a microtask       *)
(* (whenReady of a ready sidecar) are folded into the step that starts them.  *)
(*                                                                            *)
(* The launch continuation is two commands (`restore_interrupted`, then      *)
(* `retry`), a move (`TOUCH_COMMANDS`) is a command in flight before it is    *)
(* counted (`MovesInFlight`), and Autopilot waits on the launch continuation  *)
(* (`goalSettled`): `mv`, `restoring`, `rg` and `apWait` model those.         *)
(*                                                                            *)
(* Out of scope (SCOPE.md): an online launch's own `#run` past its commands,  *)
(* stock's auto-retry takeover, wake window (shouldWait after resume), hosted *)
(* tabs, quit freeze, tab close.                                              *)
EXTENDS Integers, FiniteSets

CONSTANTS Tabs, MaxStarts, MaxAttempts, MaxFlaps, MaxSess, MaxCancels

Kinds == {"dns", "net", "transient", "fatal"}
Os == 1..MaxStarts
Gens == 0..8                \* cancel generations (cancels[t]); TypeOK checks 8 is never exceeded
LaunchO == 0                \* the outcome id of a relaunch's continuation (no run of this process failed for it)

VARIABLES
    \* pool facts (what resumeFacts() reports) and the marker file
    run, last, kindOf, stopped, sg, awaiting, userRun, ready, nStarts, nO, retryIn, store,
    \* TurnResume bookkeeping (wsg: the session/branch the tab's held wait, or the continuation on its way, is for:
    \* HeldWait.since / #run's `since`)
    waiting, waitFor, wsg, probing, psg, armO, armSg, armAtt, armId, planning, cancels,
    attempts, own, judged, runWait, runFor, fireId, nCancels, nUnready,
    \* a move command in flight per tab ("moves": its answer will count, "stays": cancelled or failed), the continuations
    \* that resume in this macrotask (microtask queue), the launch continuation's restore in flight (its generation and
    \* the session/branch it is for) and Autopilot's wait on it (`#awaitingResume`)
    mv, rg, restoring, restGen, rsg, apWait, runSg, pk, rk,
    \* ConnectivityMonitor and the world it probes
    online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, hostOK, aLink, flaps,
    \* control: the synchronous region currently running
    pc, ct, rp,
    \* history variables: the properties read the bad*/sentFor/calledOff* ghosts; `launched` bounds Launch to once
    bad1, bad2, bad2h, bad6, bad7, bad8, sentFor, calledOff, calledOffH, launched

poolV == <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn, store>>
resV == <<awaiting, waiting, waitFor, wsg, probing, psg, armO, armSg, armAtt, armId, planning, cancels,
          attempts, own, judged, runWait, runFor, fireId, nCancels, nUnready>>
monV == <<online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, hostOK, aLink, flaps>>
ctlV == <<pc, ct, rp>>
histV == <<bad1, bad2, bad2h, bad6, bad7, bad8, sentFor, calledOff, calledOffH, launched>>
mvV == <<mv, rg, restoring, restGen, rsg, apWait>>
vars == <<poolV, resV, mvV, runSg, pk, rk, monV, ctlV, histV>>

\* No synchronous region runs and no continuation is about to resume: a pool event, a timer or a reply may happen.
Idle == pc = "idle" /\ rg = {}
\* turn-resume.ts MovesInFlight: a move command of the tab is on its way, so its `touched` is not final.
Moving(t) == mv[t] # "none"

IsNet(o) == kindOf[o] \in {"dns", "net"}
UserLive(t) == run[t] = "running" /\ last[t] = 0 /\ userRun[t]

\* ===== End conditions: src/main/turn-resume-ends.ts HOLD_ENDS (one End_<row> per row the model has) and HOLD_CHECKS
\* (one Ends_<check> per place the code looks). turn-resume-ends.test.ts compares both sets with the table exactly:
\* a row in one and not the other fails. Rows the model keeps constant: gone, frozen, fileWritten (SCOPE.md). =====

\* @code src/main/turn-resume-ends.ts:88-92 a run none of the hold's own (`ownRun`) and not the failed one still ending
End_personsRun(t, ownRun) == run[t] = "running" /\ last[t] = 0 /\ ~ownRun
\* @code src/main/turn-resume-ends.ts:93-97
End_stopped(t) == stopped[t]
\* @code src/main/turn-resume-ends.ts:55-63 movedSince: another session or branch since `since` was recorded (sg only grows)
End_moved(t, since) == sg[t] > since
\* @code src/main/turn-resume-ends.ts:103-107 the person prompted since the continuation started (pk, rk)
End_personsPrompt(seen) == seen
\* @code src/main/turn-resume-ends.ts:116-120 the tab's last run is no longer the failure the hold is for
End_otherOutcome(t, o) == last[t] # o
\* @code src/main/turn-resume-ends.ts:121-130 the connection wait holds the tab (peer, device, no file: constants here)
End_notRetryable(t) == awaiting[t]
\* @code src/main/turn-resume-ends.ts:131-135 the tab runs
End_busy(t) == run[t] = "running"

Ends_wait(t) == End_personsRun(t, FALSE) \/ End_moved(t, wsg[t])
Ends_probe(t) == End_personsRun(t, FALSE) \/ End_stopped(t)
Ends_probeAnswer(t, o) == End_stopped(t) \/ End_moved(t, psg[t]) \/ End_otherOutcome(t, o)
Ends_armed(t, o, since) ==
    End_personsRun(t, own[t]) \/ End_stopped(t) \/ End_moved(t, since) \/ End_otherOutcome(t, o) \/ End_notRetryable(t)
Ends_firing(t) ==
    End_stopped(t) \/ End_moved(t, armSg[t]) \/ End_otherOutcome(t, armO[t]) \/ End_notRetryable(t) \/ End_busy(t)
Ends_continuing(t, since, seen) == End_moved(t, since) \/ End_personsPrompt(seen)

\* turn-resume.ts #mayRetry: may a scheduled retry for `o` exist now (`armed`, held for the tab as it is)
MayRetry(t, o) == ~Ends_armed(t, o, sg[t])
Pending(t) ==
    (IF waiting[t] THEN {waitFor[t]} ELSE {})
    \cup (IF probing[t] # 0 THEN {probing[t]} ELSE {})
    \cup (IF armO[t] # 0 THEN {armO[t]} ELSE {})
    \cup (IF runWait[t] >= 0 THEN {runFor[t]} ELSE {})
    \cup (IF fireId[t] >= 0 THEN {armO[t]} \ {0} ELSE {})
    \cup (IF restoring[t] THEN {LaunchO} ELSE {})
\* What a session or branch change calls off (NoRetryAfterCallOff): a probe, an armed retry, a continuation waiting for its omp.
MovedOff(t) ==
    (IF probing[t] # 0 THEN {probing[t]} ELSE {}) \cup (IF armO[t] # 0 THEN {armO[t]} ELSE {})
    \cup (IF runWait[t] >= 0 THEN {runFor[t]} ELSE {})
    \cup (IF restoring[t] THEN {LaunchO} ELSE {})

TypeOK ==
    /\ run \in [Tabs -> {"idle", "running"}]
    /\ last \in [Tabs -> 0..MaxStarts] /\ cancels \in [Tabs -> Gens]
    /\ kindOf \in [Os -> Kinds \cup {"none"}]
    /\ stopped \in [Tabs -> BOOLEAN] /\ awaiting \in [Tabs -> BOOLEAN] /\ userRun \in [Tabs -> BOOLEAN]
    /\ sg \in [Tabs -> 0..MaxSess] /\ wsg \in [Tabs -> 0..MaxSess]
    /\ store \in [Tabs -> {"none", "running", "network"}]
    /\ waiting \in [Tabs -> BOOLEAN] /\ probing \in [Tabs -> 0..MaxStarts] /\ armO \in [Tabs -> 0..MaxStarts]
    /\ attempts \in [Tabs -> 0..MaxAttempts]
    /\ vN \in 0..3
    /\ pc \in {"idle", "s_watch", "s_newrun", "s_judge", "s_marker", "flush"}
    /\ launched \in BOOLEAN
    /\ mv \in [Tabs -> {"none", "moves", "stays"}] /\ rg \subseteq Tabs
    /\ restoring \in [Tabs -> BOOLEAN] /\ restGen \in [Tabs -> Gens] /\ rsg \in [Tabs -> 0..MaxSess]
    /\ apWait \in [Tabs -> BOOLEAN] /\ runSg \in [Tabs -> 0..MaxSess]
    /\ pk \in [Tabs -> BOOLEAN] /\ rk \in [Tabs -> BOOLEAN]

Init ==
    /\ run = [t \in Tabs |-> "idle"] /\ last = [t \in Tabs |-> 0] /\ kindOf = [o \in Os |-> "none"]
    /\ stopped = [t \in Tabs |-> FALSE] /\ sg = [t \in Tabs |-> 0] /\ awaiting = [t \in Tabs |-> FALSE]
    /\ userRun = [t \in Tabs |-> FALSE] /\ ready = TRUE /\ nStarts = 0 /\ nO = 0
    /\ retryIn = [t \in Tabs |-> FALSE] /\ store = [t \in Tabs |-> "none"]
    /\ waiting = [t \in Tabs |-> FALSE] /\ waitFor = [t \in Tabs |-> 0] /\ wsg = [t \in Tabs |-> 0]
    /\ probing = [t \in Tabs |-> 0] /\ psg = [t \in Tabs |-> 0]
    /\ armO = [t \in Tabs |-> 0] /\ armSg = [t \in Tabs |-> 0] /\ armAtt = [t \in Tabs |-> 0]
    /\ armId = [t \in Tabs |-> 0] /\ planning = {} /\ cancels = [t \in Tabs |-> 0]
    /\ attempts = [t \in Tabs |-> 0] /\ own = [t \in Tabs |-> FALSE] /\ judged = {}
    /\ runWait = [t \in Tabs |-> -1] /\ runFor = [t \in Tabs |-> 0] /\ fireId = [t \in Tabs |-> -1]
    /\ nCancels = 0 /\ nUnready = 0
    /\ online = TRUE /\ recovering = FALSE /\ probingM = FALSE /\ timer = FALSE
    /\ vN = 0 /\ vLink0 = TRUE /\ vW = {} /\ vRes = {}
    /\ link = TRUE /\ defOK = TRUE /\ hostOK = TRUE /\ aLink = TRUE /\ flaps = 0
    /\ Idle /\ ct = (CHOOSE t \in Tabs : TRUE) /\ rp = "idle"
    /\ mv = [t \in Tabs |-> "none"] /\ rg = {} /\ restoring = [t \in Tabs |-> FALSE] /\ restGen = [t \in Tabs |-> 0]
    /\ rsg = [t \in Tabs |-> 0] /\ apWait = [t \in Tabs |-> FALSE] /\ runSg = [t \in Tabs |-> 0]
    /\ pk = [t \in Tabs |-> FALSE] /\ rk = [t \in Tabs |-> FALSE]
    /\ bad1 = FALSE /\ bad2 = FALSE /\ bad2h = FALSE /\ bad6 = FALSE /\ bad7 = FALSE /\ bad8 = FALSE
    /\ sentFor = {} /\ calledOff = {} /\ calledOffH = {} /\ launched = FALSE

----------------------------------------------------------------------------
\* ===== the relaunch =====

\* @code src/main/turn-resume.ts:1012-1044 launch(): the marker finds its tab (layout, unwritten, opened) and is kept as a launch marker (#pending)
\* @code src/main/turn-resume.ts:1046-1057 each marker's continuation holds (offline) or runs (online) with the tab's session file and `touched` (HeldWait.since / #run's `since`)
\* @code src/main/autopilot.ts:1099-1100 #onReady: a launch marker means the run waits for the continuation's goalSettled (`apWait`)
Launch(t) ==
    /\ Idle /\ ~launched /\ ~online /\ nStarts = 0 /\ run[t] = "idle" /\ ~awaiting[t]
    /\ launched' = TRUE
    /\ waiting' = [waiting EXCEPT ![t] = TRUE]
    /\ waitFor' = [waitFor EXCEPT ![t] = LaunchO]
    /\ wsg' = [wsg EXCEPT ![t] = sg[t]]                \* launch(): HeldWait.since
    /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
    /\ apWait' = [apWait EXCEPT ![t] = TRUE]
    /\ store' = [store EXCEPT ![t] = "network"]         \* the launch marker stays in the file (CORRESPONDENCE A9)
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn,
                   probing, psg, armO, armSg, armAtt, armId, planning, cancels, attempts, own, judged, runWait, runFor,
                   fireId, nCancels, nUnready, mv, rg, restoring, restGen, rsg, runSg, pk, rk, monV, ctlV, bad1, bad2, bad2h, bad6, bad7, bad8,
                   sentFor, calledOff, calledOffH>>

----------------------------------------------------------------------------
\* ===== pool events: each is followed by the `sync()` the pool triggers =====

\* @code src/main/ipc.ts:778-783 the person's prompt: personsPrompt -> SidecarPool.notePrompted (host-services.ts:1957-1964 a device's, a view's through its window tab), before the command is sent
\* @code src/main/sidecar-run-state.ts:156-160 agent_start: a new run clears lastRun, stopped, retry
\* @code src/main/turn-resume.ts:550-553 sync() starts: judge every fact
UserPrompt(t) ==
    /\ Idle /\ run[t] = "idle" /\ ready /\ nStarts < MaxStarts       \* a prompt reaches an omp that is up (also while a continuation is on its way: A11 closed)
    /\ pk' = [pk EXCEPT ![t] = pk[t] \/ runWait[t] >= 0]               \* a continuation on its way (`#run`'s `prompted`) sees the count move
    /\ rk' = [rk EXCEPT ![t] = rk[t] \/ restoring[t]]                  \* so does the launch's restore in flight
    /\ run' = [run EXCEPT ![t] = "running"]
    /\ last' = [last EXCEPT ![t] = 0]
    /\ stopped' = [stopped EXCEPT ![t] = FALSE]
    /\ userRun' = [userRun EXCEPT ![t] = TRUE]
    /\ nStarts' = nStarts + 1
    /\ calledOff' = calledOff \cup Pending(t)
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<kindOf, sg, awaiting, ready, nO, retryIn, store, resV, monV, rp, bad1, bad2, bad2h, bad6, sentFor, calledOffH, launched, mvV, runSg, bad7, bad8>>

\* @code src/main/sidecar-run-state.ts:165-166 agent_end sets lastRun to the run's outcome (the run may still be settling)
\* @code src/main/turn-resume.ts:550-553 sync() starts
EndRun(t, k) ==
    /\ Idle /\ run[t] = "running" /\ last[t] = 0
    /\ runWait[t] < 0 /\ ~restoring[t]     \* A13 (not modeled): a run's end, and so a second `#run` of the tab, waits for the continuation on its way
    /\ nO' = nO + 1
    /\ last' = [last EXCEPT ![t] = nO + 1]
    /\ kindOf' = [kindOf EXCEPT ![nO + 1] = k]
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, stopped, sg, awaiting, userRun, ready, nStarts, retryIn, store, resV, monV, rp, histV, mvV, runSg, pk, rk>>

\* @code src/main/sidecar-run-state.ts:156-172 the run settles (background work done)
\* @code src/main/turn-resume.ts:550-553 sync() starts
Settle(t) ==
    /\ Idle /\ run[t] = "running" /\ last[t] # 0
    /\ run' = [run EXCEPT ![t] = "idle"]
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<last, kindOf, stopped, sg, awaiting, userRun, ready, nStarts, nO, retryIn, store, resV, monV, rp, histV, mvV, runSg, pk, rk>>

\* @code src/main/sidecar-pool.ts:2241-2246 noteStopped: Stop pressed (a run or the probe row)
\* @code src/main/turn-resume.ts:550-553 sync() starts
UserStop(t) ==
    /\ Idle /\ ~stopped[t] /\ (run[t] = "running" \/ probing[t] # 0)
    /\ stopped' = [stopped EXCEPT ![t] = TRUE]
    /\ calledOff' = calledOff \cup (IF probing[t] # 0 THEN {probing[t]} ELSE {})
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, last, kindOf, sg, awaiting, userRun, ready, nStarts, nO, retryIn, store, resV, monV, rp, bad1, bad2, bad2h, bad6, sentFor, calledOffH, launched, mvV, runSg, pk, rk, bad7, bad8>>

\* @code src/main/turn-resume.ts:227-244 trackMove: a TOUCH_COMMANDS command goes out and is marked in flight (MovesInFlight.begin); `touched` counts it only at its answer
\* @code src/main/ipc.ts:968-979 the window tab's move command; src/main/remote/host-services.ts:1956-1991 a device's
MoveSend(t, k) ==
    /\ Idle /\ mv[t] = "none" /\ sg[t] < MaxSess
    /\ mv' = [mv EXCEPT ![t] = k]          \* k = "moves": the answer will count (or it times out); "stays": cancelled or failed
    /\ UNCHANGED <<poolV, resV, rg, restoring, restGen, rsg, apWait, runSg, pk, rk, monV, ctlV, histV>>

\* @code src/main/sidecar-pool.ts:2261-2266 noteTouched (called by trackMove at the answer, a timed-out command included: movesTabUnknown), then onRunningChange -> sync()
\* @code src/main/turn-resume.ts:227-244 trackMove: `end()` runs after `touched` counted, so every continuation waiting in movesSettled resumes then (RunGo)
MoveReply(t) ==
    /\ Idle /\ mv[t] # "none"
    /\ mv' = [mv EXCEPT ![t] = "none"]
    /\ rg' = rg \cup {u \in {t} : runWait[t] >= 0 /\ ready}
    /\ IF mv[t] = "moves"
          THEN /\ sg' = [sg EXCEPT ![t] = sg[t] + 1]
               /\ calledOff' = calledOff \cup MovedOff(t)
               /\ calledOffH' = calledOffH \cup (IF waiting[t] THEN {waitFor[t]} ELSE {})
                                 \cup (IF restoring[t] THEN {LaunchO} ELSE {})
               /\ pc' = "s_watch" /\ ct' = t
          ELSE /\ UNCHANGED <<sg, calledOff, calledOffH, pc, ct>>
    /\ UNCHANGED <<run, last, kindOf, stopped, userRun, ready, nStarts, nO, retryIn, store, resV, restoring, restGen, rsg,
                   apWait, runSg, pk, rk, monV, rp, bad1, bad2, bad2h, bad6, bad7, bad8, sentFor, launched>>

\* Environment: the tab's session moves and no sync() follows (a path that does not tell the resume rules: the model
\* drops the sync() a held wait's file move now triggers, so the continuations' own re-check must hold without it).
\* @code src/main/sidecar-pool.ts:2064-2072 #registerSessionFile: a window tab's file moves (a paired device's switch through a view)
\* @code src/main/remote/host-services.ts:1698-1703 a device's own hosted tab reports another session file
FileMoved(t) ==
    /\ Idle /\ sg[t] + (IF mv[t] = "moves" THEN 1 ELSE 0) < MaxSess
    /\ sg' = [sg EXCEPT ![t] = sg[t] + 1]
    /\ calledOff' = calledOff \cup MovedOff(t)
    /\ calledOffH' = calledOffH \cup (IF waiting[t] THEN {waitFor[t]} ELSE {}) \cup (IF restoring[t] THEN {LaunchO} ELSE {})
    /\ UNCHANGED <<run, last, kindOf, stopped, awaiting, userRun, ready, nStarts, nO, retryIn, store, resV, monV, ctlV,
                   bad1, bad2, bad2h, bad6, sentFor, launched, mvV, runSg, pk, rk, bad7, bad8>>

\* @code src/main/turn-resume.ts:968-990 cancelWait / #dropWait: a held launch continuation tells Autopilot `cancelled` (goalSettled); a restore in flight is called off by the generation
Cancel(t) ==
    /\ Idle /\ nCancels < MaxCancels
    /\ (waiting[t] \/ probing[t] # 0 \/ armO[t] # 0 \/ restoring[t])
    /\ nCancels' = nCancels + 1
    /\ calledOff' = calledOff \cup Pending(t)
    /\ cancels' = [cancels EXCEPT ![t] = cancels[t] + 1]
    /\ apWait' = [apWait EXCEPT ![t] = IF waiting[t] /\ waitFor[t] = LaunchO THEN FALSE ELSE apWait[t]]
    /\ waiting' = [waiting EXCEPT ![t] = FALSE]
    /\ probing' = [probing EXCEPT ![t] = 0]
    /\ own' = [own EXCEPT ![t] = FALSE]
    /\ armO' = [armO EXCEPT ![t] = 0]
    /\ awaiting' = [awaiting EXCEPT ![t] = FALSE]
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn, store,
                   waitFor, wsg, psg, armSg, armAtt, armId, planning, attempts, judged, runWait, runFor, fireId, nUnready,
                   mv, rg, restoring, restGen, rsg, runSg, pk, rk, monV, rp, bad1, bad2, bad2h, bad6, bad7, bad8, sentFor, calledOffH, launched>>

\* @code src/main/turn-resume.ts:864-869 the `retry` command lands: stock starts the retried run (agent_start), or has nothing to retry
RetryTaken(t) ==
    /\ Idle /\ retryIn[t]
    /\ retryIn' = [retryIn EXCEPT ![t] = FALSE]
    /\ \/ /\ run[t] = "idle" /\ ready /\ nStarts < MaxStarts
          /\ run' = [run EXCEPT ![t] = "running"]
          /\ last' = [last EXCEPT ![t] = 0]
          /\ stopped' = [stopped EXCEPT ![t] = FALSE]
          /\ userRun' = [userRun EXCEPT ![t] = FALSE]
          /\ nStarts' = nStarts + 1
          /\ UNCHANGED <<own, attempts, mvV, runSg, pk, rk, bad7, bad8>>
       \/ /\ own' = [own EXCEPT ![t] = FALSE]      \* turn-resume.ts:766-769: nothing started, the chain is over
          /\ attempts' = [attempts EXCEPT ![t] = 0]
          /\ UNCHANGED <<run, last, stopped, userRun, nStarts, mvV, runSg, pk, rk, bad7, bad8>>
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<kindOf, sg, awaiting, ready, nO, store, waiting, waitFor, wsg, probing, psg, armO, armSg, armAtt, armId,
                   planning, cancels, judged, runWait, runFor, fireId, nCancels, nUnready, monV, rp, histV, mvV, runSg, pk, rk>>

\* Environment, not code: the tab's omp goes to sleep / restarts; a flush must wait for it (whenReady).
Unready ==
    /\ Idle /\ ready /\ nUnready < 1 /\ \A t \in Tabs : run[t] = "idle"     \* a run cannot be live on an omp that is not up
    /\ ready' = FALSE /\ nUnready' = nUnready + 1
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, awaiting, userRun, nStarts, nO, retryIn, store,
                   waiting, waitFor, wsg, probing, psg, armO, armSg, armAtt, armId, planning, cancels, attempts, own,
                   judged, runWait, runFor, fireId, nCancels, monV, ctlV, histV, mvV, runSg, pk, rk>>

\* @code src/main/turn-resume.ts:470-494 whenReady: the sidecar's status becomes ready; its resolution is a microtask, so every #run waiting on it continues in this same macrotask (RunGo)
\* @code src/main/turn-resume.ts:845-854 #run: a continuation also waits in movesSettled while a move is on its way; it resumes with MoveReply instead
Boot ==
    /\ Idle /\ ~ready
    /\ ready' = TRUE
    /\ rg' = {t \in Tabs : runWait[t] >= 0 /\ ~Moving(t)}
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, nStarts, nO, retryIn, store, resV, mv, restoring, restGen, rsg,
                   apWait, runSg, pk, rk, monV, ctlV, histV>>

\* @code src/main/turn-resume.ts:830-861 #run after whenReady and movesSettled: the session, branch and the person's prompts are checked again (holdEnd "continuing") and the cancel generation; a moved or cancelled continuation sends nothing
\* @code src/main/turn-resume-ends.ts:73-151 holdEnd("continuing"): moved ends every hold of the tab (dropWait), personsPrompt ends this continuation
\* @code src/main/turn-resume.ts:864-895 send(): the launch's `restore_interrupted`, or stock `retry` for a failed turn
\* @code src/main/turn-resume.ts:855-861 a call-off ends the run: goalSettled `cancelled` reaches Autopilot (apWait)
RunGo(t) ==
    /\ pc = "idle" /\ t \in rg
    /\ rg' = rg \ {t}
    /\ runWait' = [runWait EXCEPT ![t] = -1]
    /\ LET o == runFor[t]
           go == runWait[t] >= 0 /\ cancels[t] = runWait[t] /\ ~Ends_continuing(t, runSg[t], pk[t])
       IN IF go
             THEN /\ sentFor' = sentFor \cup {o}
                  /\ bad1' = (bad1 \/ UserLive(t))
                  /\ bad2' = (bad2 \/ o \in calledOff)
                  /\ bad2h' = (bad2h \/ o \in calledOffH)
                  /\ bad7' = (bad7 \/ mv[t] = "moves")
                  /\ bad8' = (bad8 \/ pk[t])
                  /\ IF o = LaunchO
                        THEN /\ restoring' = [restoring EXCEPT ![t] = TRUE]     \* the launch's first command is `restore_interrupted`
                             /\ restGen' = [restGen EXCEPT ![t] = cancels[t]]
                             /\ rsg' = [rsg EXCEPT ![t] = runSg[t]]
                             /\ rk' = [rk EXCEPT ![t] = pk[t]]                 \* the restore keeps the continuation's baseline
                             /\ UNCHANGED <<retryIn, own, attempts, apWait>>
                        ELSE /\ retryIn' = [retryIn EXCEPT ![t] = TRUE]
                             /\ UNCHANGED <<restoring, restGen, rsg, rk, own, attempts, apWait>>
             ELSE /\ own' = [own EXCEPT ![t] = FALSE]
                  /\ attempts' = [attempts EXCEPT ![t] = 0]
                  /\ apWait' = [apWait EXCEPT ![t] = IF o = LaunchO THEN FALSE ELSE apWait[t]]
                  /\ UNCHANGED <<retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8, restoring, restGen, rsg, rk>>
    /\ pk' = [pk EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, store,
                   awaiting, waiting, waitFor, wsg, probing, psg, armO, armSg, armAtt, armId, planning, cancels, judged, runFor,
                   fireId, nCancels, nUnready, mv, runSg, monV, ctlV, bad6, calledOff, calledOffH, launched>>

\* @code src/main/turn-resume.ts:896 send("retry") after the restore answered (also :904 the unwritten prompt, :915 the goal resume): `await stale()` waits for a move in flight, then a moved or called-off tab sends nothing
\* @code src/main/turn-resume.ts:942-946 the run ends (continues = the restore went on with the turn, no retry is sent): goalSettled
RestoreDone(t, c) ==
    /\ Idle /\ restoring[t] /\ ~Moving(t)
    /\ restoring' = [restoring EXCEPT ![t] = FALSE]
    /\ apWait' = [apWait EXCEPT ![t] = FALSE]
    /\ IF c
          THEN UNCHANGED <<retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8, own, attempts>>
          ELSE IF cancels[t] = restGen[t] /\ ~Ends_continuing(t, rsg[t], rk[t])
                  THEN /\ retryIn' = [retryIn EXCEPT ![t] = TRUE]
                       /\ sentFor' = sentFor \cup {LaunchO}
                       /\ bad1' = (bad1 \/ UserLive(t))
                       /\ bad2' = (bad2 \/ LaunchO \in calledOff)
                       /\ bad2h' = (bad2h \/ LaunchO \in calledOffH)
                       /\ bad7' = (bad7 \/ mv[t] = "moves")
                       /\ bad8' = (bad8 \/ rk[t])
                       /\ UNCHANGED <<own, attempts>>
                  ELSE /\ own' = [own EXCEPT ![t] = FALSE]
                       /\ attempts' = [attempts EXCEPT ![t] = 0]
                       /\ UNCHANGED <<retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8>>
    /\ rk' = [rk EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, store, resV, mv, rg, restGen, rsg, runSg, pk, monV, ctlV,
                   bad6, calledOff, calledOffH, launched>>

----------------------------------------------------------------------------
\* ===== sync(): the synchronous judge chain for the tab `ct` =====

\* @code src/main/turn-resume.ts:738-744 #watchScheduledRetry: a user run ends the chain; an armed retry that no longer holds is dropped
\* @code src/main/turn-resume-ends.ts:73-151 holdEnd("armed"): personsRun, stopped, moved, otherOutcome, notRetryable (S_Watch's `newUser \/ ~HoldsArm`)
S_Watch ==
    /\ pc = "s_watch"
    /\ LET t == ct
           newUser == End_personsRun(t, own[t])
           dropA == armO[t] # 0 /\ Ends_armed(t, armO[t], armSg[t])
       IN /\ cancels' = [cancels EXCEPT ![t] = IF dropA THEN cancels[t] + 1 ELSE cancels[t]]
          /\ armO' = [armO EXCEPT ![t] = IF dropA THEN 0 ELSE armO[t]]
          /\ attempts' = [attempts EXCEPT ![t] = IF dropA \/ newUser THEN 0 ELSE attempts[t]]
    /\ pc' = "s_newrun"
    /\ UNCHANGED <<poolV, awaiting, waiting, waitFor, wsg, probing, psg, armSg, armAtt, armId, planning, own, judged, runWait, runFor,
                   fireId, nCancels, nUnready, monV, ct, rp, histV, mvV, runSg, pk, rk>>

\* @code src/main/turn-resume.ts:601-606 #judge: the person's new run or Stop on a probe, a move on a held wait: #ends("wait" | "probe") ends it (dropWait)
\* @code src/main/turn-resume-ends.ts:88-97 HOLD_ENDS personsRun (wait, probe), stopped (probe)
\* @code src/main/turn-resume-ends.ts:98-102 HOLD_ENDS moved (wait)
\* @code src/main/turn-resume-ends.ts:55-63 movedSince: `touched` or the session file the hold was taken on changed
\* @code src/main/turn-resume.ts:973-990 #dropWait
S_NewRun ==
    /\ pc = "s_newrun"
    /\ LET t == ct
           drop == (waiting[t] /\ Ends_wait(t)) \/ (probing[t] # 0 /\ Ends_probe(t))
       IN /\ cancels' = [cancels EXCEPT ![t] = IF drop THEN cancels[t] + 1 ELSE cancels[t]]
          /\ waiting' = [waiting EXCEPT ![t] = IF drop THEN FALSE ELSE waiting[t]]
          /\ probing' = [probing EXCEPT ![t] = IF drop THEN 0 ELSE probing[t]]
          /\ own' = [own EXCEPT ![t] = IF drop THEN FALSE ELSE own[t]]
          /\ armO' = [armO EXCEPT ![t] = IF drop THEN 0 ELSE armO[t]]
          /\ awaiting' = [awaiting EXCEPT ![t] = IF drop THEN FALSE ELSE awaiting[t]]
          /\ apWait' = [apWait EXCEPT ![t] = IF drop /\ waiting[t] /\ waitFor[t] = LaunchO THEN FALSE ELSE apWait[t]]
    /\ pc' = "s_judge"
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn, store, waitFor, wsg, psg, armSg, armAtt,
                   armId, planning, attempts, judged, runWait, runFor, fireId, nCancels, nUnready, mv, rg, restoring, restGen, rsg, runSg, pk, rk, monV, ct, rp, histV>>

\* @code src/main/turn-resume.ts:611-634 #judge: the run's final outcome decides: hold, probe the lookup, or plan a scheduled retry
\* @code src/main/turn-resume.ts:642-647 #verifyNetwork: show the wait, ask ConnectivityMonitor.verify (one probe per host, shared)
\* @code src/main/turn-resume.ts:702-717 #planRetry: transient failures await stock `retry.enabled` before arming
\* @code src/main/turn-resume.ts:810-814 #hold: the wait records the session and branch it holds for
S_Judge ==
    /\ pc = "s_judge"
    /\ LET t == ct
           o == last[t]
       IN \/ /\ (o = 0 \/ o \in judged)                         \* nothing new to judge
                /\ pc' = "s_marker"
                /\ UNCHANGED <<resV, awaiting, monV, mvV, runSg, pk, rk, bad7, bad8>>
          \/ /\ o # 0 /\ o \notin judged
                /\ judged' = judged \cup {o}
                /\ own' = [own EXCEPT ![t] = FALSE]
                /\ pc' = "s_marker"
                /\ \/ /\ awaiting[t]                             \* the wait already held it
                         /\ UNCHANGED <<waiting, waitFor, wsg, probing, psg, planning, attempts, awaiting, monV, mvV, runSg, pk, rk, bad7, bad8>>
                   \/ /\ ~awaiting[t] /\ kindOf[o] = "fatal"
                         /\ attempts' = [attempts EXCEPT ![t] = 0]
                         /\ UNCHANGED <<waiting, waitFor, wsg, probing, psg, planning, awaiting, monV, mvV, runSg, pk, rk, bad7, bad8>>
                   \/ /\ ~awaiting[t] /\ IsNet(o) /\ ~online      \* offline: the connection wait owns a network failure
                         /\ waiting' = [waiting EXCEPT ![t] = TRUE]
                         /\ waitFor' = [waitFor EXCEPT ![t] = o]
                         /\ wsg' = [wsg EXCEPT ![t] = sg[t]]
                         /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
                         /\ UNCHANGED <<probing, psg, planning, attempts, monV, mvV, runSg, pk, rk, bad7, bad8>>
                   \/ /\ ~awaiting[t] /\ kindOf[o] = "dns" /\ online   \* a failed lookup while the link is up: probe it
                         /\ probing' = [probing EXCEPT ![t] = o]
                         /\ psg' = [psg EXCEPT ![t] = sg[t]]
                         /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
                         /\ vN' = (IF vN = 0 THEN 1 ELSE vN)
                         /\ vLink0' = (IF vN = 0 THEN link ELSE vLink0)
                         /\ vW' = vW \cup {<<t, o>>}
                         /\ UNCHANGED <<waiting, waitFor, wsg, planning, attempts, online, recovering, probingM, timer, vRes, link,
                                        defOK, hostOK, aLink, flaps, mvV, runSg, pk, rk, bad7, bad8>>
                   \/ /\ ~awaiting[t] /\ kindOf[o] \in {"net", "transient"} /\ (online \/ kindOf[o] = "transient")
                         /\ UNCHANGED <<waiting, waitFor, wsg, probing, psg, awaiting, monV, mvV, runSg, pk, rk, bad7, bad8>>
                         /\ IF attempts[t] >= MaxAttempts \/ ~MayRetry(t, o)
                               THEN UNCHANGED <<planning, attempts, mvV, runSg, pk, rk, bad7, bad8>>
                               ELSE /\ planning' = planning \cup {<<t, o, cancels[t], attempts[t]>>}
                                    /\ UNCHANGED attempts
    /\ UNCHANGED <<poolV, armO, armSg, armAtt, armId, cancels, runWait, runFor, fireId, nCancels, nUnready, ct, rp, histV, mvV, runSg, pk, rk>>

\* @code src/main/turn-resume.ts:572-578 sync(): deriveMarkers writes the marker file (awaitingConnection wins, then Stop, then running)
S_Marker ==
    /\ pc = "s_marker"
    /\ store' = [store EXCEPT ![ct] =
                   IF awaiting[ct] THEN "network" ELSE IF stopped[ct] THEN "none"
                   ELSE IF run[ct] = "running" THEN "running" ELSE "none"]
    /\ pc' = "idle"
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, awaiting, userRun, ready, nStarts, nO, retryIn, resV, monV, ct, rp, histV, mvV, runSg, pk, rk>>

----------------------------------------------------------------------------
\* ===== TurnResume continuations =====

\* @code src/main/turn-resume.ts:647-663 the probe answered: Stop/Cancel/new run/session change ended it, else hold (unreachable) or plan a retry
\* @code src/main/turn-resume-ends.ts:73-151 holdEnd("probeAnswer"): gone, frozen, stopped, moved, fileWritten, otherOutcome
VerifyThen(t, o, reachable) ==
    /\ Idle /\ <<t, o, reachable>> \in vRes
    /\ vRes' = vRes \ {<<t, o, reachable>>}
    /\ LET holds == ~Ends_probeAnswer(t, o)
       IN \/ /\ probing[t] # o                                  \* whoever ended this probe also cleared its row
                /\ UNCHANGED <<resV, awaiting, ctlV, histV, planning, mvV, runSg, pk, rk>>
          \/ /\ probing[t] = o /\ holds /\ ~reachable
                /\ probing' = [probing EXCEPT ![t] = 0]
                /\ waiting' = [waiting EXCEPT ![t] = TRUE]
                /\ waitFor' = [waitFor EXCEPT ![t] = o]
                /\ wsg' = [wsg EXCEPT ![t] = psg[t]]                  \* #hold(tabId, "retry", probe)
                /\ pc' = (IF online THEN "flush" ELSE "s_watch")      \* #hold flushes at once when online; then sync()
                /\ ct' = t
                /\ rp' = (IF online THEN "s_watch" ELSE "idle")
                /\ UNCHANGED <<awaiting, planning, histV, psg, armO, armSg, armAtt, armId, cancels, attempts, own, judged,
                               runWait, runFor, fireId, nCancels, nUnready, mvV, runSg, pk, rk>>
          \/ /\ probing[t] = o /\ (~holds \/ reachable)
                /\ probing' = [probing EXCEPT ![t] = 0]
                /\ awaiting' = [awaiting EXCEPT ![t] = FALSE]
                /\ pc' = "s_watch" /\ ct' = t
                /\ planning' = (IF holds /\ kindOf[o] # "fatal" /\ attempts[t] < MaxAttempts
                                  THEN planning \cup {<<t, o, cancels[t], attempts[t]>>} ELSE planning)
                /\ UNCHANGED <<waiting, waitFor, wsg, psg, armO, armSg, armAtt, armId, cancels, attempts, own, judged,
                               runWait, runFor, fireId, nCancels, nUnready, rp, histV, mvV, runSg, pk, rk>>
    /\ UNCHANGED <<poolV, vN, vLink0, vW, online, recovering, probingM, timer, link, defOK, hostOK, aLink, flaps, mvV, runSg, pk, rk, bad7, bad8>>

\* @code src/main/turn-resume.ts:711-716 #planRetry's continuation after `await #stockRetryOn`; #arm shows the row and starts the timer
\* @code src/main/turn-resume.ts:719-736 #arm
PlanResume(t, o, gen, used) ==
    /\ Idle /\ <<t, o, gen, used>> \in planning
    /\ planning' = planning \ {<<t, o, gen, used>>}
    /\ IF cancels[t] # gen \/ armO[t] # 0 \/ ~MayRetry(t, o)
             THEN UNCHANGED <<armO, armSg, armAtt, armId, mvV, runSg, pk, rk, bad7, bad8>>
             ELSE /\ armO' = [armO EXCEPT ![t] = o]
                  /\ armSg' = [armSg EXCEPT ![t] = sg[t]]
                  /\ armAtt' = [armAtt EXCEPT ![t] = used + 1]
                  /\ armId' = [armId EXCEPT ![t] = armId[t] + 1]
    /\ UNCHANGED <<poolV, awaiting, waiting, waitFor, wsg, probing, psg, cancels, attempts, own, judged, runWait, runFor, fireId,
                   nCancels, nUnready, monV, ctlV, histV, mvV, runSg, pk, rk>>

\* @code src/main/turn-resume.ts:747-755 #fire: the timer ran; re-check everything before asking stock's retry setting
\* @code src/main/turn-resume-ends.ts:73-151 holdEnd("firing"): the armed rows and busy (`run[t] = "idle" /\ HoldsArm(t)`)
FireStart(t) ==
    /\ Idle /\ armO[t] # 0 /\ fireId[t] < 0 /\ ~Moving(t)     \* #fire: `await movesSettled` before it looks
    /\ IF ~Ends_firing(t)
          THEN /\ fireId' = [fireId EXCEPT ![t] = armId[t]]
               /\ UNCHANGED <<cancels, armO, attempts, mvV, runSg, pk, rk, bad7, bad8>>
          ELSE /\ cancels' = [cancels EXCEPT ![t] = cancels[t] + 1]       \* #dropScheduled
               /\ armO' = [armO EXCEPT ![t] = 0]
               /\ attempts' = [attempts EXCEPT ![t] = 0]
               /\ UNCHANGED fireId
    /\ UNCHANGED <<poolV, awaiting, waiting, waitFor, wsg, probing, psg, armSg, armAtt, armId, planning, own, judged, runWait, runFor,
                   nCancels, nUnready, monV, ctlV, histV, mvV, runSg, pk, rk>>

\* @code src/main/turn-resume.ts:752-770 #fire after `await #stockRetryOn`: re-check, release the row, then hold and sync() (offline) or #run for the armed session (online)
\* @code src/main/turn-resume.ts:810-814 #hold: the wait records the armed retry's session and branch
FireResume(t) ==
    /\ Idle /\ fireId[t] >= 0
    /\ fireId' = [fireId EXCEPT ![t] = -1]
    /\ IF armO[t] # 0 /\ armId[t] = fireId[t] /\ ~Ends_firing(t)
          THEN /\ attempts' = [attempts EXCEPT ![t] = armAtt[t]]
               /\ own' = [own EXCEPT ![t] = TRUE]
               /\ armO' = [armO EXCEPT ![t] = 0]                         \* #releaseScheduled
               /\ cancels' = cancels
               /\ IF ~online
                     THEN /\ waiting' = [waiting EXCEPT ![t] = TRUE]
                          /\ waitFor' = [waitFor EXCEPT ![t] = armO[t]]
                          /\ wsg' = [wsg EXCEPT ![t] = armSg[t]]
                          /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
                          /\ UNCHANGED <<runWait, runFor, retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8, runSg, pk, rk>>
                          /\ pc' = "s_watch" /\ ct' = t /\ rp' = rp        \* the sync() after #hold in #fire
                     ELSE /\ UNCHANGED <<waiting, waitFor, awaiting, ctlV>>
                          /\ \/ /\ ready /\ ~Moving(t)                    \* whenReady is a microtask, movesSettled is quiet: send in the same macrotask
                                   /\ retryIn' = [retryIn EXCEPT ![t] = TRUE]
                                   /\ sentFor' = sentFor \cup {armO[t]}
                                   /\ bad1' = (bad1 \/ UserLive(t))
                                   /\ bad2' = (bad2 \/ armO[t] \in calledOff)
                                   /\ bad2h' = (bad2h \/ armO[t] \in calledOffH)
                                   /\ bad7' = (bad7 \/ mv[t] = "moves")
                                   /\ UNCHANGED <<runWait, runFor, wsg, runSg, pk, rk, bad8>>
                             \/ /\ ~(ready /\ ~Moving(t))
                                   /\ runWait' = [runWait EXCEPT ![t] = cancels[t]]
                                   /\ runFor' = [runFor EXCEPT ![t] = armO[t]]
                                   /\ runSg' = [runSg EXCEPT ![t] = armSg[t]]  \* #run's `since`: the armed session
                                   /\ pk' = [pk EXCEPT ![t] = FALSE]            \* #run's `prompted` is taken as it starts
                                   /\ UNCHANGED <<retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8, wsg, rk>>
          ELSE /\ IF armO[t] # 0 /\ armId[t] = fireId[t]
                     THEN /\ cancels' = [cancels EXCEPT ![t] = cancels[t] + 1]    \* #dropScheduled
                          /\ armO' = [armO EXCEPT ![t] = 0]
                          /\ attempts' = [attempts EXCEPT ![t] = 0]
                     ELSE UNCHANGED <<cancels, armO, attempts>>
               /\ UNCHANGED <<own, waiting, waitFor, wsg, awaiting, runWait, runFor, runSg, pk, rk, retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8, ctlV>>
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, store, probing, psg, armSg, armAtt, armId,
                   planning, judged, nCancels, nUnready, mvV, monV, bad6, calledOff, calledOffH, launched>>

\* @code src/main/turn-resume.ts:817-827 flush(): every held tab leaves the wait and runs its continuation with the wait's `since`
\* @code src/main/turn-resume.ts:830-861 #run: capture the cancel generation; a wait whose tab moved since is dropped (holdEnd "continuing": moved); with a ready sidecar and no move in flight the first command goes out in the same macrotask, else the continuation waits (runWait; Boot / MoveReply resume it)
FlushStep ==
    /\ pc = "flush"
    /\ pc' = rp /\ rp' = "idle"
    /\ IF ~online
          THEN UNCHANGED <<waiting, awaiting, cancels, runWait, runFor, retryIn, sentFor, bad1, bad2, bad2h, bad7, bad8,
                           restoring, restGen, rsg, apWait, runSg, pk, rk>>
          ELSE LET moved == {t \in Tabs : waiting[t] /\ Ends_continuing(t, wsg[t], FALSE)}                \* the re-check when the wait lets go
                   go == {t \in Tabs : waiting[t] /\ t \notin moved}
                   direct == {t \in go : ready /\ mv[t] = "none"}               \* the omp is up and no move is on its way
                   launch == {t \in direct : waitFor[t] = LaunchO}
               IN /\ waiting' = [t \in Tabs |-> FALSE]
                  /\ awaiting' = [t \in Tabs |-> IF waiting[t] THEN FALSE ELSE awaiting[t]]
                  /\ cancels' = [t \in Tabs |-> IF t \in moved THEN cancels[t] + 1 ELSE cancels[t]]
                  /\ runWait' = [t \in Tabs |-> IF t \in go \ direct THEN cancels[t] ELSE runWait[t]]
                  /\ runFor' = [t \in Tabs |-> IF t \in go \ direct THEN waitFor[t] ELSE runFor[t]]
                  /\ runSg' = [t \in Tabs |-> IF t \in go \ direct THEN wsg[t] ELSE runSg[t]]
                  /\ pk' = [t \in Tabs |-> IF t \in go \ direct THEN FALSE ELSE pk[t]]
                  /\ rk' = [t \in Tabs |-> IF t \in launch THEN FALSE ELSE rk[t]]
                  /\ retryIn' = [t \in Tabs |-> IF t \in direct \ launch THEN TRUE ELSE retryIn[t]]
                  /\ restoring' = [t \in Tabs |-> IF t \in launch THEN TRUE ELSE restoring[t]]
                  /\ restGen' = [t \in Tabs |-> IF t \in launch THEN cancels[t] ELSE restGen[t]]
                  /\ rsg' = [t \in Tabs |-> IF t \in launch THEN wsg[t] ELSE rsg[t]]
                  /\ apWait' = [t \in Tabs |-> IF t \in moved /\ waitFor[t] = LaunchO THEN FALSE ELSE apWait[t]]
                  /\ sentFor' = sentFor \cup {waitFor[t] : t \in direct}
                  /\ bad1' = (bad1 \/ \E t \in direct : UserLive(t))
                  /\ bad2' = (bad2 \/ \E t \in direct : waitFor[t] \in calledOff)
                  /\ bad2h' = (bad2h \/ \E t \in direct : waitFor[t] \in calledOffH)
                  /\ bad7' = (bad7 \/ \E t \in direct : mv[t] = "moves")
                  /\ UNCHANGED bad8
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, store, waitFor, wsg, probing, psg, armO, armSg, armAtt, armId, planning, attempts, own, judged,
                   fireId, nCancels, nUnready, mv, rg, monV, ct, bad6, calledOff, calledOffH, launched>>

----------------------------------------------------------------------------
\* ===== ConnectivityMonitor =====

\* @code src/main/connectivity.ts:127-138 #check: the probe answered; unreachable takes the state offline and starts the recovery loop
\* @code src/main/connectivity.ts:140-146 #reachable: the default way out or the host answers
MProbeDone ==
    /\ Idle /\ vN > 0
    /\ LET reach == vLink0 /\ (defOK \/ hostOK)
           result == online /\ reach
           goOff == online /\ ~reach /\ ~recovering
       IN /\ vRes' = vRes \cup {<<w[1], w[2], result>> : w \in vW}
          /\ recovering' = (recovering \/ goOff)
          /\ online' = (online /\ ~goOff)
          /\ timer' = (timer \/ (goOff /\ ~probingM))
          /\ bad6' = (bad6 \/ (goOff /\ vLink0 /\ (defOK \/ hostOK)))
    /\ vW' = {} /\ vN' = 0
    /\ UNCHANGED <<poolV, resV, probingM, vLink0, link, defOK, hostOK, aLink, flaps, ctlV, bad1, bad2, bad2h, sentFor, calledOff, calledOffH, launched, mvV, runSg, pk, rk, bad7, bad8>>

\* @code src/main/connectivity.ts:159-165 #attempt starts: one recovery probe at a time
TimerFire ==
    /\ Idle /\ timer /\ ~probingM
    /\ timer' = FALSE /\ probingM' = TRUE /\ aLink' = link
    /\ UNCHANGED <<poolV, resV, online, recovering, vN, vLink0, vW, vRes, link, defOK, hostOK, flaps, ctlV, histV, mvV, runSg, pk, rk>>

\* @code src/main/connectivity.ts:166-176 #attempt resolves: reachable ends the recovery and the state goes online; else try again in 2 s
\* @code src/main/connectivity.ts:148-152 #set(online): `changed` runs turnResume.connectivityChanged() = flush()
AttemptDone ==
    /\ Idle /\ probingM
    /\ probingM' = FALSE
    /\ IF ~recovering
          THEN UNCHANGED <<online, recovering, timer, pc, rp, mvV, runSg, pk, rk, bad7, bad8>>
          ELSE IF aLink /\ (defOK \/ hostOK)
                  THEN /\ recovering' = FALSE /\ online' = TRUE /\ pc' = "flush" /\ rp' = "idle"
                       /\ UNCHANGED timer
                  ELSE /\ timer' = TRUE
                       /\ UNCHANGED <<online, recovering, pc, rp, mvV, runSg, pk, rk, bad7, bad8>>
    /\ UNCHANGED <<poolV, resV, vN, vLink0, vW, vRes, link, defOK, hostOK, aLink, flaps, ct, histV, mvV, runSg, pk, rk>>

\* @code src/main/connectivity.ts:74-82 report(true): while recovering the probe decides, else the state goes online at once
ReportOnline ==
    /\ Idle /\ ~link
    /\ link' = TRUE
    /\ IF recovering
          THEN /\ IF probingM THEN UNCHANGED <<probingM, timer, aLink, mvV, runSg, pk, rk, bad7, bad8>>
                 ELSE /\ probingM' = TRUE /\ timer' = FALSE /\ aLink' = TRUE
               /\ UNCHANGED <<online, pc, rp, mvV, runSg, pk, rk, bad7, bad8>>
          ELSE /\ online' = TRUE
               /\ IF online THEN UNCHANGED <<pc, rp, mvV, runSg, pk, rk, bad7, bad8>> ELSE /\ pc' = "flush" /\ rp' = "idle"
               /\ UNCHANGED <<probingM, timer, aLink, mvV, runSg, pk, rk, bad7, bad8>>
    /\ UNCHANGED <<poolV, resV, recovering, vN, vLink0, vW, vRes, defOK, hostOK, flaps, ct, histV, mvV, runSg, pk, rk>>

\* @code src/main/connectivity.ts:74-77 report(false): the state goes offline (net.isOnline() poll or a window's `offline` event)
LinkDown ==
    /\ Idle /\ link /\ flaps < MaxFlaps
    /\ link' = FALSE /\ online' = FALSE /\ flaps' = flaps + 1
    /\ UNCHANGED <<poolV, resV, recovering, probingM, timer, vN, vLink0, vW, vRes, defOK, hostOK, aLink, ctlV, histV, mvV, runSg, pk, rk>>

\* Environment, not code: the default way out or the failed host stops answering / starts answering.
DefDown == Idle /\ defOK /\ flaps < MaxFlaps /\ defOK' = FALSE /\ flaps' = flaps + 1
           /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, hostOK, aLink, ctlV, histV, mvV, runSg, pk, rk>>
HostDown == Idle /\ hostOK /\ flaps < MaxFlaps /\ hostOK' = FALSE /\ flaps' = flaps + 1
            /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, aLink, ctlV, histV, mvV, runSg, pk, rk>>
DefUp == Idle /\ ~defOK /\ defOK' = TRUE
         /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, hostOK, aLink, flaps, ctlV, histV, mvV, runSg, pk, rk>>
HostUp == Idle /\ ~hostOK /\ hostOK' = TRUE
          /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, aLink, flaps, ctlV, histV, mvV, runSg, pk, rk>>

----------------------------------------------------------------------------
SyncStep == S_Watch \/ S_NewRun \/ S_Judge \/ S_Marker
EnvStep == Unready \/ Boot \/ LinkDown \/ DefDown \/ HostDown \/ DefUp \/ HostUp

\* Nothing in flight and nobody waiting: the model may stop here. Any other state with no enabled action is a stuck wait (TLC deadlock).
Quiescent ==
    /\ Idle /\ planning = {} /\ vRes = {} /\ vN = 0
    /\ \A t \in Tabs : ~awaiting[t] /\ ~waiting[t] /\ probing[t] = 0 /\ runWait[t] < 0 /\ fireId[t] < 0 /\ ~retryIn[t]
                       /\ mv[t] = "none" /\ ~restoring[t] /\ ~apWait[t]
Terminated == Quiescent /\ UNCHANGED vars

Next == \/ \E t \in Tabs : Launch(t)
        \/ \E t \in Tabs, k \in Kinds : EndRun(t, k)
        \/ \E t \in Tabs : UserPrompt(t)
        \/ \E t \in Tabs : Settle(t)
        \/ \E t \in Tabs : UserStop(t)
        \/ \E t \in Tabs, k \in {"moves", "stays"} : MoveSend(t, k)
        \/ \E t \in Tabs : MoveReply(t)
        \/ \E t \in Tabs : RunGo(t)
        \/ \E t \in Tabs, c \in BOOLEAN : RestoreDone(t, c)
        \/ \E t \in Tabs : FileMoved(t)
        \/ \E t \in Tabs : Cancel(t)
        \/ S_Watch \/ S_NewRun \/ S_Judge \/ S_Marker
        \/ FlushStep
        \/ \E t \in Tabs, o \in Os, r \in BOOLEAN : VerifyThen(t, o, r)
        \/ \E t \in Tabs, o \in Os, g \in Gens, u \in 0..MaxAttempts : PlanResume(t, o, g, u)
        \/ \E t \in Tabs : FireStart(t)
        \/ \E t \in Tabs : FireResume(t)
        \/ \E t \in Tabs : RetryTaken(t)
        \/ MProbeDone \/ TimerFire \/ AttemptDone \/ ReportOnline
        \/ EnvStep
        \/ Terminated

ResumeSys == FlushStep
              \/ (\E t \in Tabs : RunGo(t))
              \/ (\E t \in Tabs, c \in BOOLEAN : RestoreDone(t, c))
              \/ (\E t \in Tabs, o \in Os, r \in BOOLEAN : VerifyThen(t, o, r))
              \/ (\E t \in Tabs, o \in Os, g \in Gens, u \in 0..MaxAttempts : PlanResume(t, o, g, u))
              \/ (\E t \in Tabs : FireStart(t) \/ FireResume(t) \/ RetryTaken(t))
MonitorSys == MProbeDone \/ TimerFire \/ AttemptDone
MoveSys == \E t \in Tabs : MoveReply(t)

\* Strong fairness, one term per component: the runtime always eventually runs what is queued (timers fire, promises
\* settle, the omp boots). These actions are enabled only while no synchronous region (`pc`) is running, so they are
\* enabled intermittently, which weak fairness would not cover. The network eventually coming back (ReportOnline,
\* DefUp, HostUp) is an ASSUMPTION (SCOPE.md A-heal), not a fact about the code.
Fairness ==
    /\ SF_vars(SyncStep) /\ SF_vars(ResumeSys) /\ SF_vars(MonitorSys) /\ SF_vars(MoveSys) /\ SF_vars(Boot)
    /\ SF_vars(DefUp) /\ SF_vars(HostUp) /\ SF_vars(ReportOnline)

Spec == Init /\ [][Next]_vars /\ Fairness
SpecNoFair == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* ===== Properties (protocol level, frozen: Properties.md) =====

\* P1: no `retry` is ever sent into a run the user started.
NoRetryIntoUserRun == ~bad1
\* P2: Cancel, Stop, a new prompt, or a session/branch change during a probe (or while a retry is scheduled) never leads to a later retry of that failure.
NoRetryAfterCallOff == ~bad2
\* P3: a wait never gets stuck: once connectivity returns, the wait row ends.
WaitEnds == \A t \in Tabs : awaiting[t] ~> ~awaiting[t]
\* P3b: a probe row never gets stuck either.
ProbeEnds == \A t \in Tabs : (probing[t] # 0) ~> (probing[t] = 0)
\* P4: the marker file says `network` whenever a wait holds (a crash during the wait still retries).
MarkerNetwork == pc = "idle" => \A t \in Tabs : awaiting[t] => store[t] = "network"
\* P5: a tab has at most one of (wait, probe, scheduled retry).
OneOfWaitOrScheduled == \A t \in Tabs : ~(armO[t] # 0 /\ (waiting[t] \/ probing[t] # 0))
\* P6: one probe per host: concurrent asks share it.
OneProbePerHost == vN <= 1
\* P7: the state goes offline by a probe only when neither the failed host nor the default way out answered.
OfflineOnlyOnNoAnswer == ~bad6

\* P8 (found by the verifier as F4, adopted 28 Oct 2026): a session/branch change while a wait HOLDS ends it; the failed turn is never retried.
NoRetryAfterSessionChangeWhileHeld == ~bad2h

\* P9 (review of v0.82.0, finding 3): no continuation sends a command to a tab while a move command that will move it is
\* on its way (`touched` counts it only at its answer; `movesSettled`).
NoSendWhileMoveInFlight == ~bad7

\* P10 (review of v0.82.0, finding 1): Autopilot waits on the launch continuation only while something will still tell it:
\* the held wait, a continuation on its way, or the restore in flight (goalSettled).
GoalHeard == \A t \in Tabs : apWait[t] =>
    ((waiting[t] /\ waitFor[t] = LaunchO) \/ (runWait[t] >= 0 /\ runFor[t] = LaunchO) \/ restoring[t] \/ t \in rg)

\* P11 (A11, closed 29 Oct 2026): a continuation (a flush, a fired scheduled retry, a launch's restore and its second
\* command) sends no command after the person sent the tab a prompt since it started: that run is theirs, not its own.
NoSendAfterPersonsPrompt == ~bad8

\* Sanity (must FAIL): the interesting states are reachable.
NeverWaits == \A t \in Tabs : ~waiting[t]
NeverRetries == sentFor = {}
NeverArmed == \A t \in Tabs : armO[t] = 0
NeverProbing == \A t \in Tabs : probing[t] = 0
NeverLaunchWaits == ~(\E t \in Tabs : waiting[t] /\ waitFor[t] = LaunchO)
NeverRestores == \A t \in Tabs : ~restoring[t]
NeverMoveInFlight == \A t \in Tabs : mv[t] = "none"
NeverDeferredByMove == \A t \in Tabs : ~(runWait[t] >= 0 /\ ready)
NeverPromptedDeferred == \A t \in Tabs : ~pk[t]
NeverPromptedRestore == \A t \in Tabs : ~rk[t]
=============================================================================
