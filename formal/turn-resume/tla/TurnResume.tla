---------------------------- MODULE TurnResume ----------------------------
(* Model of OMPdesk's connection wait: a turn that failed on the network is   *)
(* probed (ConnectivityMonitor.verify), held, flushed when connectivity       *)
(* returns, and retried by stock `retry`; plus the scheduled backoff retry.   *)
(* Code: src/main/turn-resume.ts (TurnResume) + src/main/connectivity.ts.     *)
(*                                                                            *)
(* Granularity. Every action below is one macrotask of the code (a pool event *)
(* with the `sync()` it triggers, a timer, a promise continuation that waited *)
(* on I/O). `sync()` and `flush()` are synchronous regions: they run as a     *)
(* chain of micro-steps under a program counter `pc` that no other action can *)
(* interleave with. Promise continuations that only wait on a microtask       *)
(* (whenReady of a ready sidecar) are folded into the step that starts them.  *)
(*                                                                            *)
(* Out of scope (SCOPE.md): launch markers, stock's auto-retry takeover, wake *)
(* window (shouldWait after resume), hosted tabs, quit freeze, tab close.     *)
EXTENDS Integers, FiniteSets

CONSTANTS Tabs, MaxStarts, MaxAttempts, MaxFlaps, MaxSess, MaxCancels,
          FireSyncs   \* FALSE = the code as written; TRUE mirrors a proposed fix for F1 (#fire calls sync() after #hold)

Kinds == {"dns", "net", "transient", "fatal"}
Os == 1..MaxStarts
Gens == 0..8                \* cancel generations (cancels[t]); TypeOK checks 8 is never exceeded

VARIABLES
    \* pool facts (what resumeFacts() reports) and the marker file
    run, last, kindOf, stopped, sg, awaiting, userRun, ready, nStarts, nO, retryIn, store,
    \* TurnResume bookkeeping
    waiting, waitFor, probing, psg, armO, armSg, armAtt, armId, planning, cancels,
    attempts, own, judged, runWait, runFor, fireId, nCancels, nUnready,
    \* ConnectivityMonitor and the world it probes
    online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, hostOK, aLink, flaps,
    \* control: the synchronous region currently running
    pc, ct, rp,
    \* history (ghost) variables the properties read
    bad1, bad2, bad2h, bad6, sentFor, calledOff, calledOffH

poolV == <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn, store>>
resV == <<awaiting, waiting, waitFor, probing, psg, armO, armSg, armAtt, armId, planning, cancels,
          attempts, own, judged, runWait, runFor, fireId, nCancels, nUnready>>
monV == <<online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, hostOK, aLink, flaps>>
ctlV == <<pc, ct, rp>>
histV == <<bad1, bad2, bad2h, bad6, sentFor, calledOff, calledOffH>>
vars == <<poolV, resV, monV, ctlV, histV>>

IsNet(o) == kindOf[o] \in {"dns", "net"}
\* turn-resume.ts #mayRetry (peer, device, frozen and sessionFile are constants of this model)
MayRetry(t, o) == ~stopped[t] /\ ~awaiting[t] /\ last[t] = o
HoldsArm(t) == MayRetry(t, armO[t]) /\ sg[t] = armSg[t]
UserLive(t) == run[t] = "running" /\ last[t] = 0 /\ userRun[t]
Pending(t) ==
    (IF waiting[t] THEN {waitFor[t]} ELSE {})
    \cup (IF probing[t] # 0 THEN {probing[t]} ELSE {})
    \cup (IF armO[t] # 0 THEN {armO[t]} ELSE {})
    \cup (IF runWait[t] >= 0 THEN {runFor[t]} ELSE {})
    \cup (IF fireId[t] >= 0 THEN {armO[t]} \ {0} ELSE {})

TypeOK ==
    /\ run \in [Tabs -> {"idle", "running"}]
    /\ last \in [Tabs -> 0..MaxStarts] /\ cancels \in [Tabs -> Gens]
    /\ kindOf \in [Os -> Kinds \cup {"none"}]
    /\ stopped \in [Tabs -> BOOLEAN] /\ awaiting \in [Tabs -> BOOLEAN] /\ userRun \in [Tabs -> BOOLEAN]
    /\ sg \in [Tabs -> 0..MaxSess]
    /\ store \in [Tabs -> {"none", "running", "network"}]
    /\ waiting \in [Tabs -> BOOLEAN] /\ probing \in [Tabs -> 0..MaxStarts] /\ armO \in [Tabs -> 0..MaxStarts]
    /\ attempts \in [Tabs -> 0..MaxAttempts]
    /\ vN \in 0..3
    /\ pc \in {"idle", "s_watch", "s_newrun", "s_judge", "s_marker", "flush"}

Init ==
    /\ run = [t \in Tabs |-> "idle"] /\ last = [t \in Tabs |-> 0] /\ kindOf = [o \in Os |-> "none"]
    /\ stopped = [t \in Tabs |-> FALSE] /\ sg = [t \in Tabs |-> 0] /\ awaiting = [t \in Tabs |-> FALSE]
    /\ userRun = [t \in Tabs |-> FALSE] /\ ready = TRUE /\ nStarts = 0 /\ nO = 0
    /\ retryIn = [t \in Tabs |-> FALSE] /\ store = [t \in Tabs |-> "none"]
    /\ waiting = [t \in Tabs |-> FALSE] /\ waitFor = [t \in Tabs |-> 0]
    /\ probing = [t \in Tabs |-> 0] /\ psg = [t \in Tabs |-> 0]
    /\ armO = [t \in Tabs |-> 0] /\ armSg = [t \in Tabs |-> 0] /\ armAtt = [t \in Tabs |-> 0]
    /\ armId = [t \in Tabs |-> 0] /\ planning = {} /\ cancels = [t \in Tabs |-> 0]
    /\ attempts = [t \in Tabs |-> 0] /\ own = [t \in Tabs |-> FALSE] /\ judged = {}
    /\ runWait = [t \in Tabs |-> -1] /\ runFor = [t \in Tabs |-> 0] /\ fireId = [t \in Tabs |-> -1]
    /\ nCancels = 0 /\ nUnready = 0
    /\ online = TRUE /\ recovering = FALSE /\ probingM = FALSE /\ timer = FALSE
    /\ vN = 0 /\ vLink0 = TRUE /\ vW = {} /\ vRes = {}
    /\ link = TRUE /\ defOK = TRUE /\ hostOK = TRUE /\ aLink = TRUE /\ flaps = 0
    /\ pc = "idle" /\ ct = (CHOOSE t \in Tabs : TRUE) /\ rp = "idle"
    /\ bad1 = FALSE /\ bad2 = FALSE /\ bad2h = FALSE /\ bad6 = FALSE
    /\ sentFor = {} /\ calledOff = {} /\ calledOffH = {}

----------------------------------------------------------------------------
\* ===== pool events: each is followed by the `sync()` the pool triggers =====

\* @code src/main/sidecar-run-state.ts:156-160 agent_start: a new run clears lastRun, stopped, retry
\* @code src/main/turn-resume.ts:448-451 sync() starts: judge every fact
UserPrompt(t) ==
    /\ pc = "idle" /\ run[t] = "idle" /\ ready /\ nStarts < MaxStarts       \* a prompt reaches an omp that is up
    /\ run' = [run EXCEPT ![t] = "running"]
    /\ last' = [last EXCEPT ![t] = 0]
    /\ stopped' = [stopped EXCEPT ![t] = FALSE]
    /\ userRun' = [userRun EXCEPT ![t] = TRUE]
    /\ nStarts' = nStarts + 1
    /\ calledOff' = calledOff \cup Pending(t)
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<kindOf, sg, awaiting, ready, nO, retryIn, store, resV, monV, rp, bad1, bad2, bad2h, bad6, sentFor, calledOffH>>

\* @code src/main/sidecar-run-state.ts:165-166 agent_end sets lastRun to the run's outcome (the run may still be settling)
\* @code src/main/turn-resume.ts:448-451 sync() starts
EndRun(t, k) ==
    /\ pc = "idle" /\ run[t] = "running" /\ last[t] = 0
    /\ nO' = nO + 1
    /\ last' = [last EXCEPT ![t] = nO + 1]
    /\ kindOf' = [kindOf EXCEPT ![nO + 1] = k]
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, stopped, sg, awaiting, userRun, ready, nStarts, retryIn, store, resV, monV, rp, histV>>

\* @code src/main/sidecar-run-state.ts:156-172 the run settles (background work done)
\* @code src/main/turn-resume.ts:448-451 sync() starts
Settle(t) ==
    /\ pc = "idle" /\ run[t] = "running" /\ last[t] # 0
    /\ run' = [run EXCEPT ![t] = "idle"]
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<last, kindOf, stopped, sg, awaiting, userRun, ready, nStarts, nO, retryIn, store, resV, monV, rp, histV>>

\* @code src/main/sidecar-pool.ts:2218-2223 noteStopped: Stop pressed (a run or the probe row)
\* @code src/main/turn-resume.ts:448-451 sync() starts
UserStop(t) ==
    /\ pc = "idle" /\ ~stopped[t] /\ (run[t] = "running" \/ probing[t] # 0)
    /\ stopped' = [stopped EXCEPT ![t] = TRUE]
    /\ calledOff' = calledOff \cup (IF probing[t] # 0 THEN {probing[t]} ELSE {})
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, last, kindOf, sg, awaiting, userRun, ready, nStarts, nO, retryIn, store, resV, monV, rp, bad1, bad2, bad2h, bad6, sentFor, calledOffH>>

\* @code src/main/sidecar-pool.ts:2238-2243 noteTouched: new_session/switch_session/fork/branch/switch_leaf bumps `touched`
\* @code src/main/turn-resume.ts:448-451 sync() starts
SessionChange(t) ==
    /\ pc = "idle" /\ sg[t] < MaxSess
    /\ sg' = [sg EXCEPT ![t] = sg[t] + 1]
    /\ calledOff' = calledOff \cup (IF probing[t] # 0 THEN {probing[t]} ELSE {}) \cup (IF armO[t] # 0 THEN {armO[t]} ELSE {})
    /\ calledOffH' = calledOffH \cup (IF waiting[t] THEN {waitFor[t]} ELSE {})
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, last, kindOf, stopped, awaiting, userRun, ready, nStarts, nO, retryIn, store, resV, monV, rp, bad1, bad2, bad2h, bad6, sentFor>>

\* @code src/main/turn-resume.ts:872-887 cancelWait: dropWait, then sync
Cancel(t) ==
    /\ pc = "idle" /\ nCancels < MaxCancels
    /\ (waiting[t] \/ probing[t] # 0 \/ armO[t] # 0)
    /\ nCancels' = nCancels + 1
    /\ calledOff' = calledOff \cup Pending(t)
    /\ cancels' = [cancels EXCEPT ![t] = cancels[t] + 1]
    /\ waiting' = [waiting EXCEPT ![t] = FALSE]
    /\ probing' = [probing EXCEPT ![t] = 0]
    /\ own' = [own EXCEPT ![t] = FALSE]
    /\ armO' = [armO EXCEPT ![t] = 0]
    /\ awaiting' = [awaiting EXCEPT ![t] = FALSE]
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn, store,
                   waitFor, psg, armSg, armAtt, armId, planning, attempts, judged, runWait, runFor, fireId, nUnready,
                   monV, rp, bad1, bad2, bad2h, bad6, sentFor, calledOffH>>

\* @code src/main/turn-resume.ts:769-774 the `retry` command lands: stock starts the retried run (agent_start), or has nothing to retry
RetryTaken(t) ==
    /\ pc = "idle" /\ retryIn[t]
    /\ retryIn' = [retryIn EXCEPT ![t] = FALSE]
    /\ \/ /\ run[t] = "idle" /\ ready /\ nStarts < MaxStarts
          /\ run' = [run EXCEPT ![t] = "running"]
          /\ last' = [last EXCEPT ![t] = 0]
          /\ stopped' = [stopped EXCEPT ![t] = FALSE]
          /\ userRun' = [userRun EXCEPT ![t] = FALSE]
          /\ nStarts' = nStarts + 1
          /\ UNCHANGED <<own, attempts>>
       \/ /\ own' = [own EXCEPT ![t] = FALSE]      \* turn-resume.ts:693-696: nothing started, the chain is over
          /\ attempts' = [attempts EXCEPT ![t] = 0]
          /\ UNCHANGED <<run, last, stopped, userRun, nStarts>>
    /\ pc' = "s_watch" /\ ct' = t
    /\ UNCHANGED <<kindOf, sg, awaiting, ready, nO, store, waiting, waitFor, probing, psg, armO, armSg, armAtt, armId,
                   planning, cancels, judged, runWait, runFor, fireId, nCancels, nUnready, monV, rp, histV>>

\* Environment, not code: the tab's omp goes to sleep / restarts; a flush must wait for it (whenReady).
Unready ==
    /\ pc = "idle" /\ ready /\ nUnready < 1 /\ \A t \in Tabs : run[t] = "idle"     \* a run cannot be live on an omp that is not up
    /\ ready' = FALSE /\ nUnready' = nUnready + 1
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, awaiting, userRun, nStarts, nO, retryIn, store,
                   waiting, waitFor, probing, psg, armO, armSg, armAtt, armId, planning, cancels, attempts, own,
                   judged, runWait, runFor, fireId, nCancels, monV, ctlV, histV>>

\* @code src/main/turn-resume.ts:378-398 whenReady: the sidecar's status becomes ready; its resolution is a microtask, so every #run waiting on it continues in this same macrotask
\* @code src/main/turn-resume.ts:760-766 #run after whenReady: a cancelled continuation sends nothing, else the `retry` goes out
\* @code src/main/turn-resume.ts:769-774 send("retry")
Boot ==
    /\ pc = "idle" /\ ~ready
    /\ ready' = TRUE
    /\ LET go == {t \in Tabs : runWait[t] >= 0 /\ cancels[t] = runWait[t]}
           abort == {t \in Tabs : runWait[t] >= 0 /\ cancels[t] # runWait[t]}
       IN /\ runWait' = [t \in Tabs |-> -1]
          /\ retryIn' = [t \in Tabs |-> IF t \in go THEN TRUE ELSE retryIn[t]]
          /\ sentFor' = sentFor \cup {runFor[t] : t \in go}
          /\ bad1' = (bad1 \/ \E t \in go : UserLive(t))
          /\ bad2' = (bad2 \/ \E t \in go : runFor[t] \in calledOff)
          /\ bad2h' = (bad2h \/ \E t \in go : runFor[t] \in calledOffH)
          /\ own' = [t \in Tabs |-> IF t \in abort THEN FALSE ELSE own[t]]
          /\ attempts' = [t \in Tabs |-> IF t \in abort THEN 0 ELSE attempts[t]]
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, awaiting, userRun, nStarts, nO, store,
                   waiting, waitFor, probing, psg, armO, armSg, armAtt, armId, planning, cancels, judged, runFor, fireId,
                   nCancels, nUnready, monV, ctlV, bad6, calledOff, calledOffH>>

----------------------------------------------------------------------------
\* ===== sync(): the synchronous judge chain for the tab `ct` =====

\* @code src/main/turn-resume.ts:654-664 #watchScheduledRetry: a user run ends the chain; an armed retry that no longer holds is dropped
S_Watch ==
    /\ pc = "s_watch"
    /\ LET t == ct
           newUser == run[t] = "running" /\ last[t] = 0 /\ ~own[t]
           dropA == armO[t] # 0 /\ (newUser \/ ~HoldsArm(t))
       IN /\ cancels' = [cancels EXCEPT ![t] = IF dropA THEN cancels[t] + 1 ELSE cancels[t]]
          /\ armO' = [armO EXCEPT ![t] = IF dropA THEN 0 ELSE armO[t]]
          /\ attempts' = [attempts EXCEPT ![t] = IF dropA \/ newUser THEN 0 ELSE attempts[t]]
    /\ pc' = "s_newrun"
    /\ UNCHANGED <<poolV, awaiting, waiting, waitFor, probing, psg, armSg, armAtt, armId, planning, own, judged, runWait, runFor,
                   fireId, nCancels, nUnready, monV, ct, rp, histV>>

\* @code src/main/turn-resume.ts:502-512 a run that is neither the held one nor still ending is the user's new prompt: dropWait; Stop ends the probe
\* @code src/main/turn-resume.ts:878-887 #dropWait
S_NewRun ==
    /\ pc = "s_newrun"
    /\ LET t == ct
           userRunWhileHeld == run[t] = "running" /\ last[t] = 0 /\ (waiting[t] \/ probing[t] # 0)
           stopWhileProbing == stopped[t] /\ probing[t] # 0
           drop == userRunWhileHeld \/ stopWhileProbing
       IN /\ cancels' = [cancels EXCEPT ![t] = IF drop THEN cancels[t] + 1 ELSE cancels[t]]
          /\ waiting' = [waiting EXCEPT ![t] = IF drop THEN FALSE ELSE waiting[t]]
          /\ probing' = [probing EXCEPT ![t] = IF drop THEN 0 ELSE probing[t]]
          /\ own' = [own EXCEPT ![t] = IF drop THEN FALSE ELSE own[t]]
          /\ armO' = [armO EXCEPT ![t] = IF drop THEN 0 ELSE armO[t]]
          /\ awaiting' = [awaiting EXCEPT ![t] = IF drop THEN FALSE ELSE awaiting[t]]
    /\ pc' = "s_judge"
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, retryIn, store, waitFor, psg, armSg, armAtt,
                   armId, planning, attempts, judged, runWait, runFor, fireId, nCancels, nUnready, monV, ct, rp, histV>>

\* @code src/main/turn-resume.ts:517-540 #judge: the run's final outcome decides: hold, probe the lookup, or plan a scheduled retry
\* @code src/main/turn-resume.ts:548-557 #verifyNetwork: show the wait, ask ConnectivityMonitor.verify (one probe per host, shared)
\* @code src/main/turn-resume.ts:617-632 #planRetry: transient failures await stock `retry.enabled` before arming
\* @code src/main/turn-resume.ts:736-740 #hold
S_Judge ==
    /\ pc = "s_judge"
    /\ LET t == ct
           o == last[t]
       IN \/ /\ (o = 0 \/ o \in judged)                         \* nothing new to judge
                /\ pc' = "s_marker"
                /\ UNCHANGED <<resV, awaiting, monV>>
          \/ /\ o # 0 /\ o \notin judged
                /\ judged' = judged \cup {o}
                /\ own' = [own EXCEPT ![t] = FALSE]
                /\ pc' = "s_marker"
                /\ \/ /\ awaiting[t]                             \* the wait already held it
                         /\ UNCHANGED <<waiting, waitFor, probing, psg, planning, attempts, awaiting, monV>>
                   \/ /\ ~awaiting[t] /\ kindOf[o] = "fatal"
                         /\ attempts' = [attempts EXCEPT ![t] = 0]
                         /\ UNCHANGED <<waiting, waitFor, probing, psg, planning, awaiting, monV>>
                   \/ /\ ~awaiting[t] /\ IsNet(o) /\ ~online      \* offline: the connection wait owns a network failure
                         /\ waiting' = [waiting EXCEPT ![t] = TRUE]
                         /\ waitFor' = [waitFor EXCEPT ![t] = o]
                         /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
                         /\ UNCHANGED <<probing, psg, planning, attempts, monV>>
                   \/ /\ ~awaiting[t] /\ kindOf[o] = "dns" /\ online   \* a failed lookup while the link is up: probe it
                         /\ probing' = [probing EXCEPT ![t] = o]
                         /\ psg' = [psg EXCEPT ![t] = sg[t]]
                         /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
                         /\ vN' = (IF vN = 0 THEN 1 ELSE vN)
                         /\ vLink0' = (IF vN = 0 THEN link ELSE vLink0)
                         /\ vW' = vW \cup {<<t, o>>}
                         /\ UNCHANGED <<waiting, waitFor, planning, attempts, online, recovering, probingM, timer, vRes, link,
                                        defOK, hostOK, aLink, flaps>>
                   \/ /\ ~awaiting[t] /\ kindOf[o] \in {"net", "transient"} /\ (online \/ kindOf[o] = "transient")
                         /\ UNCHANGED <<waiting, waitFor, probing, psg, awaiting, monV>>
                         /\ IF attempts[t] >= MaxAttempts \/ ~MayRetry(t, o)
                               THEN UNCHANGED <<planning, attempts>>
                               ELSE /\ planning' = planning \cup {<<t, o, cancels[t], attempts[t]>>}
                                    /\ UNCHANGED attempts
    /\ UNCHANGED <<poolV, armO, armSg, armAtt, armId, cancels, runWait, runFor, fireId, nCancels, nUnready, ct, rp, histV>>

\* @code src/main/turn-resume.ts:470-476 sync(): deriveMarkers writes the marker file (awaitingConnection wins, then Stop, then running)
S_Marker ==
    /\ pc = "s_marker"
    /\ store' = [store EXCEPT ![ct] =
                   IF awaiting[ct] THEN "network" ELSE IF stopped[ct] THEN "none"
                   ELSE IF run[ct] = "running" THEN "running" ELSE "none"]
    /\ pc' = "idle"
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, awaiting, userRun, ready, nStarts, nO, retryIn, resV, monV, ct, rp, histV>>

----------------------------------------------------------------------------
\* ===== TurnResume continuations =====

\* @code src/main/turn-resume.ts:557-580 the probe answered: Stop/Cancel/new run/session change ended it, else hold (unreachable) or plan a retry
VerifyThen(t, o, reachable) ==
    /\ pc = "idle" /\ <<t, o, reachable>> \in vRes
    /\ vRes' = vRes \ {<<t, o, reachable>>}
    /\ LET holds == last[t] = o /\ ~stopped[t] /\ sg[t] = psg[t]
       IN \/ /\ probing[t] # o                                  \* whoever ended this probe also cleared its row
                /\ UNCHANGED <<resV, awaiting, ctlV, histV, planning>>
          \/ /\ probing[t] = o /\ holds /\ ~reachable
                /\ probing' = [probing EXCEPT ![t] = 0]
                /\ waiting' = [waiting EXCEPT ![t] = TRUE]
                /\ waitFor' = [waitFor EXCEPT ![t] = o]
                /\ pc' = (IF online THEN "flush" ELSE "s_watch")      \* #hold flushes at once when online; then sync()
                /\ ct' = t
                /\ rp' = (IF online THEN "s_watch" ELSE "idle")
                /\ UNCHANGED <<awaiting, planning, histV, psg, armO, armSg, armAtt, armId, cancels, attempts, own, judged,
                               runWait, runFor, fireId, nCancels, nUnready>>
          \/ /\ probing[t] = o /\ (~holds \/ reachable)
                /\ probing' = [probing EXCEPT ![t] = 0]
                /\ awaiting' = [awaiting EXCEPT ![t] = FALSE]
                /\ pc' = "s_watch" /\ ct' = t
                /\ planning' = (IF holds /\ kindOf[o] # "fatal" /\ attempts[t] < MaxAttempts
                                  THEN planning \cup {<<t, o, cancels[t], attempts[t]>>} ELSE planning)
                /\ UNCHANGED <<waiting, waitFor, psg, armO, armSg, armAtt, armId, cancels, attempts, own, judged,
                               runWait, runFor, fireId, nCancels, nUnready, rp, histV>>
    /\ UNCHANGED <<poolV, vN, vLink0, vW, online, recovering, probingM, timer, link, defOK, hostOK, aLink, flaps>>

\* @code src/main/turn-resume.ts:626-631 #planRetry's continuation after `await #stockRetryOn`; #arm shows the row and starts the timer
PlanResume(t, o, gen, used) ==
    /\ pc = "idle" /\ <<t, o, gen, used>> \in planning
    /\ planning' = planning \ {<<t, o, gen, used>>}
    /\ IF cancels[t] # gen \/ armO[t] # 0 \/ ~MayRetry(t, o)
             THEN UNCHANGED <<armO, armSg, armAtt, armId>>
             ELSE /\ armO' = [armO EXCEPT ![t] = o]
                  /\ armSg' = [armSg EXCEPT ![t] = sg[t]]
                  /\ armAtt' = [armAtt EXCEPT ![t] = used + 1]
                  /\ armId' = [armId EXCEPT ![t] = armId[t] + 1]
    /\ UNCHANGED <<poolV, awaiting, waiting, waitFor, probing, psg, cancels, attempts, own, judged, runWait, runFor, fireId,
                   nCancels, nUnready, monV, ctlV, histV>>

\* @code src/main/turn-resume.ts:675-682 #fire: the timer ran; re-check everything before asking stock's retry setting
FireStart(t) ==
    /\ pc = "idle" /\ armO[t] # 0 /\ fireId[t] < 0
    /\ IF run[t] = "idle" /\ HoldsArm(t)
          THEN /\ fireId' = [fireId EXCEPT ![t] = armId[t]]
               /\ UNCHANGED <<cancels, armO, attempts>>
          ELSE /\ cancels' = [cancels EXCEPT ![t] = cancels[t] + 1]       \* #dropScheduled
               /\ armO' = [armO EXCEPT ![t] = 0]
               /\ attempts' = [attempts EXCEPT ![t] = 0]
               /\ UNCHANGED fireId
    /\ UNCHANGED <<poolV, awaiting, waiting, waitFor, probing, psg, armSg, armAtt, armId, planning, own, judged, runWait, runFor,
                   nCancels, nUnready, monV, ctlV, histV>>

\* @code src/main/turn-resume.ts:681-697 #fire after `await #stockRetryOn`: re-check, release the row, then hold (offline) or run
\* @code src/main/turn-resume.ts:736-740 #hold (NOTE: #fire does not call sync() afterwards)
FireResume(t) ==
    /\ pc = "idle" /\ fireId[t] >= 0
    /\ fireId' = [fireId EXCEPT ![t] = -1]
    /\ IF armO[t] # 0 /\ armId[t] = fireId[t] /\ run[t] = "idle" /\ HoldsArm(t)
          THEN /\ attempts' = [attempts EXCEPT ![t] = armAtt[t]]
               /\ own' = [own EXCEPT ![t] = TRUE]
               /\ armO' = [armO EXCEPT ![t] = 0]                         \* #releaseScheduled
               /\ cancels' = cancels
               /\ IF ~online
                     THEN /\ waiting' = [waiting EXCEPT ![t] = TRUE]
                          /\ waitFor' = [waitFor EXCEPT ![t] = armO[t]]
                          /\ awaiting' = [awaiting EXCEPT ![t] = TRUE]
                          /\ UNCHANGED <<runWait, runFor, retryIn, sentFor, bad1, bad2, bad2h>>
                          /\ IF FireSyncs THEN pc' = "s_watch" /\ ct' = t /\ rp' = rp ELSE UNCHANGED ctlV
                     ELSE /\ UNCHANGED <<waiting, waitFor, awaiting, ctlV>>
                          /\ \/ /\ ready                                  \* whenReady is a microtask: send in the same macrotask
                                   /\ retryIn' = [retryIn EXCEPT ![t] = TRUE]
                                   /\ sentFor' = sentFor \cup {armO[t]}
                                   /\ bad1' = (bad1 \/ UserLive(t))
                                   /\ bad2' = (bad2 \/ armO[t] \in calledOff)
                                   /\ bad2h' = (bad2h \/ armO[t] \in calledOffH)
                                   /\ UNCHANGED <<runWait, runFor>>
                             \/ /\ ~ready
                                   /\ runWait' = [runWait EXCEPT ![t] = cancels[t]]
                                   /\ runFor' = [runFor EXCEPT ![t] = armO[t]]
                                   /\ UNCHANGED <<retryIn, sentFor, bad1, bad2, bad2h>>
          ELSE /\ IF armO[t] # 0 /\ armId[t] = fireId[t]
                     THEN /\ cancels' = [cancels EXCEPT ![t] = cancels[t] + 1]    \* #dropScheduled
                          /\ armO' = [armO EXCEPT ![t] = 0]
                          /\ attempts' = [attempts EXCEPT ![t] = 0]
                     ELSE UNCHANGED <<cancels, armO, attempts>>
               /\ UNCHANGED <<own, waiting, waitFor, awaiting, runWait, runFor, retryIn, sentFor, bad1, bad2, bad2h, ctlV>>
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, store, probing, psg, armSg, armAtt, armId,
                   planning, judged, nCancels, nUnready, monV, bad6, calledOff, calledOffH>>

\* @code src/main/turn-resume.ts:743-754 flush(): every held tab leaves the wait and runs its continuation
\* @code src/main/turn-resume.ts:756-774 #run: capture the cancel generation; with a ready sidecar the `retry` goes out in the same macrotask
FlushStep ==
    /\ pc = "flush"
    /\ pc' = rp /\ rp' = "idle"
    /\ IF ~online
          THEN UNCHANGED <<waiting, awaiting, runWait, runFor, retryIn, sentFor, bad1, bad2, bad2h>>
          ELSE /\ waiting' = [t \in Tabs |-> FALSE]
               /\ awaiting' = [t \in Tabs |-> IF waiting[t] THEN FALSE ELSE awaiting[t]]
               /\ runWait' = [t \in Tabs |-> IF waiting[t] /\ ~ready THEN cancels[t] ELSE runWait[t]]
               /\ runFor' = [t \in Tabs |-> IF waiting[t] /\ ~ready THEN waitFor[t] ELSE runFor[t]]
               /\ retryIn' = [t \in Tabs |-> IF waiting[t] /\ ready THEN TRUE ELSE retryIn[t]]
               /\ sentFor' = sentFor \cup {waitFor[t] : t \in {u \in Tabs : waiting[u] /\ ready}}
               /\ bad1' = (bad1 \/ \E t \in Tabs : waiting[t] /\ ready /\ UserLive(t))
               /\ bad2' = (bad2 \/ \E t \in Tabs : waiting[t] /\ ready /\ waitFor[t] \in calledOff)
               /\ bad2h' = (bad2h \/ \E t \in Tabs : waiting[t] /\ ready /\ waitFor[t] \in calledOffH)
    /\ UNCHANGED <<run, last, kindOf, stopped, sg, userRun, ready, nStarts, nO, store, waitFor, probing, psg, armO, armSg, armAtt, armId, planning, cancels, attempts, own, judged,
                   fireId, nCancels, nUnready, monV, ct, bad6, calledOff, calledOffH>>

----------------------------------------------------------------------------
\* ===== ConnectivityMonitor =====

\* @code src/main/connectivity.ts:127-138 #check: the probe answered; unreachable takes the state offline and starts the recovery loop
\* @code src/main/connectivity.ts:140-146 #reachable: the default way out or the host answers
MProbeDone ==
    /\ pc = "idle" /\ vN > 0
    /\ LET reach == vLink0 /\ (defOK \/ hostOK)
           result == online /\ reach
           goOff == online /\ ~reach /\ ~recovering
       IN /\ vRes' = vRes \cup {<<w[1], w[2], result>> : w \in vW}
          /\ recovering' = (recovering \/ goOff)
          /\ online' = (online /\ ~goOff)
          /\ timer' = (timer \/ (goOff /\ ~probingM))
          /\ bad6' = (bad6 \/ (goOff /\ vLink0 /\ (defOK \/ hostOK)))
    /\ vW' = {} /\ vN' = 0
    /\ UNCHANGED <<poolV, resV, probingM, vLink0, link, defOK, hostOK, aLink, flaps, ctlV, bad1, bad2, bad2h, sentFor, calledOff, calledOffH>>

\* @code src/main/connectivity.ts:159-165 #attempt starts: one recovery probe at a time
TimerFire ==
    /\ pc = "idle" /\ timer /\ ~probingM
    /\ timer' = FALSE /\ probingM' = TRUE /\ aLink' = link
    /\ UNCHANGED <<poolV, resV, online, recovering, vN, vLink0, vW, vRes, link, defOK, hostOK, flaps, ctlV, histV>>

\* @code src/main/connectivity.ts:166-176 #attempt resolves: reachable ends the recovery and the state goes online; else try again in 2 s
\* @code src/main/connectivity.ts:148-152 #set(online): `changed` runs turnResume.connectivityChanged() = flush()
AttemptDone ==
    /\ pc = "idle" /\ probingM
    /\ probingM' = FALSE
    /\ IF ~recovering
          THEN UNCHANGED <<online, recovering, timer, pc, rp>>
          ELSE IF aLink /\ (defOK \/ hostOK)
                  THEN /\ recovering' = FALSE /\ online' = TRUE /\ pc' = "flush" /\ rp' = "idle"
                       /\ UNCHANGED timer
                  ELSE /\ timer' = TRUE
                       /\ UNCHANGED <<online, recovering, pc, rp>>
    /\ UNCHANGED <<poolV, resV, vN, vLink0, vW, vRes, link, defOK, hostOK, aLink, flaps, ct, histV>>

\* @code src/main/connectivity.ts:74-82 report(true): while recovering the probe decides, else the state goes online at once
ReportOnline ==
    /\ pc = "idle" /\ ~link
    /\ link' = TRUE
    /\ IF recovering
          THEN /\ IF probingM THEN UNCHANGED <<probingM, timer, aLink>>
                 ELSE /\ probingM' = TRUE /\ timer' = FALSE /\ aLink' = TRUE
               /\ UNCHANGED <<online, pc, rp>>
          ELSE /\ online' = TRUE
               /\ IF online THEN UNCHANGED <<pc, rp>> ELSE /\ pc' = "flush" /\ rp' = "idle"
               /\ UNCHANGED <<probingM, timer, aLink>>
    /\ UNCHANGED <<poolV, resV, recovering, vN, vLink0, vW, vRes, defOK, hostOK, flaps, ct, histV>>

\* @code src/main/connectivity.ts:74-77 report(false): the state goes offline (net.isOnline() poll or a window's `offline` event)
LinkDown ==
    /\ pc = "idle" /\ link /\ flaps < MaxFlaps
    /\ link' = FALSE /\ online' = FALSE /\ flaps' = flaps + 1
    /\ UNCHANGED <<poolV, resV, recovering, probingM, timer, vN, vLink0, vW, vRes, defOK, hostOK, aLink, ctlV, histV>>

\* Environment, not code: the default way out or the failed host stops answering / starts answering.
DefDown == pc = "idle" /\ defOK /\ flaps < MaxFlaps /\ defOK' = FALSE /\ flaps' = flaps + 1
           /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, hostOK, aLink, ctlV, histV>>
HostDown == pc = "idle" /\ hostOK /\ flaps < MaxFlaps /\ hostOK' = FALSE /\ flaps' = flaps + 1
            /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, aLink, ctlV, histV>>
DefUp == pc = "idle" /\ ~defOK /\ defOK' = TRUE
         /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, hostOK, aLink, flaps, ctlV, histV>>
HostUp == pc = "idle" /\ ~hostOK /\ hostOK' = TRUE
          /\ UNCHANGED <<poolV, resV, online, recovering, probingM, timer, vN, vLink0, vW, vRes, link, defOK, aLink, flaps, ctlV, histV>>

----------------------------------------------------------------------------
SyncStep == S_Watch \/ S_NewRun \/ S_Judge \/ S_Marker
EnvStep == Unready \/ Boot \/ LinkDown \/ DefDown \/ HostDown \/ DefUp \/ HostUp

\* Nothing in flight and nobody waiting: the model may stop here. Any other state with no enabled action is a stuck wait (TLC deadlock).
Quiescent ==
    /\ pc = "idle" /\ planning = {} /\ vRes = {} /\ vN = 0
    /\ \A t \in Tabs : ~awaiting[t] /\ ~waiting[t] /\ probing[t] = 0 /\ runWait[t] < 0 /\ fireId[t] < 0 /\ ~retryIn[t]
Terminated == Quiescent /\ UNCHANGED vars

Next == \/ \E t \in Tabs, k \in Kinds : EndRun(t, k)
        \/ \E t \in Tabs : UserPrompt(t)
        \/ \E t \in Tabs : Settle(t)
        \/ \E t \in Tabs : UserStop(t)
        \/ \E t \in Tabs : SessionChange(t)
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
              \/ (\E t \in Tabs, o \in Os, r \in BOOLEAN : VerifyThen(t, o, r))
              \/ (\E t \in Tabs, o \in Os, g \in Gens, u \in 0..MaxAttempts : PlanResume(t, o, g, u))
              \/ (\E t \in Tabs : FireStart(t) \/ FireResume(t) \/ RetryTaken(t))
MonitorSys == MProbeDone \/ TimerFire \/ AttemptDone

\* Strong fairness, one term per component: the runtime always eventually runs what is queued (timers fire, promises
\* settle, the omp boots). These actions are enabled only while no synchronous region (`pc`) is running, so they are
\* enabled intermittently, which weak fairness would not cover. The network eventually coming back (ReportOnline,
\* DefUp, HostUp) is an ASSUMPTION (SCOPE.md A-heal), not a fact about the code.
Fairness ==
    /\ SF_vars(SyncStep) /\ SF_vars(ResumeSys) /\ SF_vars(MonitorSys) /\ SF_vars(Boot)
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

\* Beyond the stated properties (added by the verifier, reported separately): a session/branch change while a wait HOLDS does not retry the failed turn.
NoRetryAfterSessionChangeWhileHeld == ~bad2h

\* Sanity (must FAIL): the interesting states are reachable.
NeverWaits == \A t \in Tabs : ~waiting[t]
NeverRetries == sentFor = {}
NeverArmed == \A t \in Tabs : armO[t] = 0
NeverProbing == \A t \in Tabs : probing[t] = 0
=============================================================================
