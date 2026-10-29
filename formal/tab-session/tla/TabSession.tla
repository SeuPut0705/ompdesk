----------------------------- MODULE TabSession -----------------------------
(* Which session a tab's omp opens, across every spawn of that tab: the     *)
(* first start, a crash restart, a restart that names no session (machine   *)
(* setup, the desktop slot, an omp update), the person opening another      *)
(* stored session in it, and a move to another folder.                      *)
(* Code: src/main/sidecar.ts (SidecarManager: #spawn, #handleReady,         *)
(* #observeResponse, restart, #attemptRestart), src/main/omp-launch.ts      *)
(* (sessionOpen), src/main/sidecar-factory.ts (the ready status's           *)
(* get_state). One action per synchronous block of SidecarManager.          *)
(*                                                                          *)
(* Code variants (constants), so one spec checks the code before and after  *)
(* its fixes:                                                               *)
(*   OldCode        TRUE: up to a10eb6877^ (`#resumeSessionPath` cleared at *)
(*                  ready, never learned from get_state, cleared by a       *)
(*                  restart that names no session).                         *)
(*   ClearNewAt     "ready": `#isNew` cleared at ready (a10eb6877, finding  *)
(*                  F1); "session": cleared once get_state names it (now).  *)
(*   LearnsChange   FALSE: up to this model's second revision (an in-omp    *)
(*                  switch_session / new_session left #sessionPath on the   *)
(*                  old session until the next get_state, finding F2);      *)
(*                  TRUE: #observeResponse takes them from their response.  *)
EXTENDS Naturals, FiniteSets

CONSTANTS Stored,     \* stored sessions the tab may open (written)
          Others,     \* another written session in the folder: what stock's autoResume may reopen
          NewIds,     \* ids stock gives the new sessions it starts
          MaxSpawns,
          OldCode, ClearNewAt, LearnsChange

NoS == "none"
Sessions == Stored \cup Others \cup NewIds
Opens == [k : {"session"}, f : Sessions] \cup [k : {"new", "default"}]

VARIABLES
    path,      \* SidecarManager #sessionPath: the session the next spawn opens
    isNew,     \* SidecarManager #isNew: a new tab that has not had a session yet
    written,   \* session files stock has written (a new session's file comes at its first answer)
    proc,      \* the tab's omp: "none" (a spawn is due), "booting" (spawned, before `ready`), "ready"
    onOmp,     \* the session the running omp is on (NoS while none runs)
    lastOpen,  \* how the last spawn opened its session
    used,      \* new-session ids stock handed out
    spawns,
    shown,     \* ghost: the session the person sees the tab on (the pool's tab, from the same get_state; their own open)
    moved,     \* ghost: the person moved the tab to another folder and its omp has not named a session since
    named,     \* ghost: the tab's session is established: it started on a stored one, or an omp of the tab named it, or the person switched to one
    gated      \* ghost: the start gate (worktree-lifecycle.ts) already moved the new tab

vars == <<path, isNew, written, proc, onOmp, lastOpen, used, spawns, shown, moved, named, gated>>

\* @code src/main/omp-launch.ts:77-80 sessionOpen: a written session is reopened; a tab with a session stock never wrote, or a new tab, starts a new one; else omp's own choice
OpenOf(p, n, w) ==
    IF p # NoS /\ p \in w THEN [k |-> "session", f |-> p]
    ELSE IF n \/ p # NoS THEN [k |-> "new"]
    ELSE [k |-> "default"]

TypeOK ==
    /\ path \in Sessions \cup {NoS}
    /\ isNew \in BOOLEAN
    /\ written \subseteq Sessions
    /\ proc \in {"none", "booting", "ready"}
    /\ onOmp \in Sessions \cup {NoS}
    /\ lastOpen \in Opens \cup {[k |-> "none"]}
    /\ used \subseteq NewIds
    /\ spawns \in 0..MaxSpawns
    /\ shown \in Sessions \cup {NoS}
    /\ moved \in BOOLEAN
    /\ named \in BOOLEAN
    /\ gated \in BOOLEAN

\* A new tab (`fresh`: tab-spawn.ts, a new window) or a stored session opened in a tab (pool acquire, layout restore, a resume marker).
Init ==
    /\ \E start \in {NoS} \cup Stored :
         /\ path = start
         /\ isNew = (start = NoS)
         /\ shown = start
         /\ named = (start # NoS)
    /\ written = Stored \cup Others
    /\ proc = "none"
    /\ onOmp = NoS
    /\ lastOpen = [k |-> "none"]
    /\ used = {}
    /\ spawns = 0
    /\ moved = FALSE
    /\ gated = FALSE

\* @code src/main/sidecar.ts:636-650 #spawn builds the launch from sessionOpen({ path: #sessionPath, isNew: #isNew }); stock opens it
Spawn ==
    /\ proc = "none" /\ spawns < MaxSpawns
    /\ LET o == OpenOf(path, isNew, written) IN
         /\ lastOpen' = o
         /\ \/ /\ o.k = "session" /\ onOmp' = o.f /\ UNCHANGED used
            \/ /\ o.k = "new"
               /\ \E id \in NewIds \ used : onOmp' = id /\ used' = used \cup {id}
            \* No flag: stock's own `autoResume` (the person's config) may reopen the folder's most recent session, or start a new one.
            \/ /\ o.k = "default"
               /\ \/ \E s \in written : onOmp' = s /\ UNCHANGED used
                  \/ \E id \in NewIds \ used : onOmp' = id /\ used' = used \cup {id}
    /\ proc' = "booting"
    /\ spawns' = spawns + 1
    /\ UNCHANGED <<path, isNew, written, shown, moved, named, gated>>

\* @code src/main/sidecar.ts:945-950 #handleReady (the old code also cleared #resumeSessionPath here, a10eb6877 cleared #isNew)
Ready ==
    /\ proc = "booting"
    /\ proc' = "ready"
    /\ path' = IF OldCode THEN NoS ELSE path
    /\ isNew' = IF ClearNewAt = "ready" THEN FALSE ELSE isNew
    /\ UNCHANGED <<written, onOmp, lastOpen, used, spawns, shown, moved, named, gated>>

\* @code src/main/sidecar.ts:804-825 #observeResponse: the get_state the ready status sends (sidecar-factory.ts:233-246) names the session; the pool's tab learns it from the same answer
Observe ==
    /\ proc = "ready"
    /\ path' = IF OldCode THEN path ELSE onOmp
    /\ isNew' = IF ClearNewAt = "session" THEN FALSE ELSE isNew
    /\ shown' = onOmp
    /\ moved' = FALSE
    /\ named' = TRUE
    /\ UNCHANGED <<written, proc, onOmp, lastOpen, used, spawns, gated>>

\* Environment: a turn's first answer; stock writes the session's file.
Write ==
    /\ proc = "ready" /\ onOmp \notin written
    /\ written' = written \cup {onOmp}
    /\ UNCHANGED <<path, isNew, proc, onOmp, lastOpen, used, spawns, shown, moved, named, gated>>

\* @code src/main/sidecar.ts:755-779 the child's exit, then #attemptRestart (1039-1067) spawns again on the same state
Crash ==
    /\ proc \in {"booting", "ready"}
    /\ proc' = "none" /\ onOmp' = NoS
    /\ UNCHANGED <<path, isNew, written, lastOpen, used, spawns, shown, moved, named, gated>>

\* @code src/main/sidecar.ts:1364-1372 restart() with no session: machine setup's start, the desktop slot, an omp update (pool passes its tab's file), a manual Restart
Restart ==
    /\ proc' = "none" /\ onOmp' = NoS
    /\ path' = IF OldCode THEN NoS ELSE path
    /\ UNCHANGED <<isNew, written, lastOpen, used, spawns, shown, moved, named, gated>>

\* @code src/main/sidecar.ts:1364-1372 restart(undefined, f): the person opens a stored session in the tab
Open(f) ==
    /\ proc' = "none" /\ onOmp' = NoS
    /\ path' = f /\ shown' = f /\ moved' = FALSE
    /\ UNCHANGED <<isNew, written, lastOpen, used, spawns, named, gated>>

\* @code src/main/sidecar.ts:1364-1372 restart(cwd): the tab moves to another folder (ipc SIDECAR_SET_PROJECT)
Move ==
    /\ proc' = "none" /\ onOmp' = NoS
    /\ path' = NoS /\ shown' = NoS /\ moved' = TRUE
    /\ UNCHANGED <<isNew, written, lastOpen, used, spawns, named, gated>>

\* @code src/main/sidecar.ts:994-1004 the start gate (worktree-lifecycle.ts) between a new tab's first `ready` and its ready status: the tab's session begins in the worktree, a new one, so `#isNew = true; restart(cwd)`
GateMove ==
    /\ proc = "ready" /\ spawns = 1 /\ lastOpen.k = "new" /\ ~gated
    /\ proc' = "none" /\ onOmp' = NoS
    /\ path' = NoS /\ isNew' = TRUE /\ shown' = NoS /\ named' = FALSE /\ gated' = TRUE
    /\ UNCHANGED <<written, lastOpen, used, spawns, moved>>

\* @code src/main/sidecar.ts:826-842 switch_session inside the running omp (sidebar open in the same tab, `sessions.ts` local handler); its response names no file, the pool takes the requested one (ipc.ts:991-993)
Switch(f) ==
    /\ proc = "ready" /\ f # onOmp
    /\ onOmp' = f /\ shown' = f /\ named' = TRUE /\ moved' = FALSE
    /\ path' = IF LearnsChange THEN f ELSE path
    /\ isNew' = IF LearnsChange THEN FALSE ELSE isNew
    /\ UNCHANGED <<written, proc, lastOpen, used, spawns, gated>>

\* @code src/main/sidecar.ts:826-842 new_session inside the running omp (the composer's new session, /new); its file is unknown until the next get_state
NewSession ==
    /\ proc = "ready"
    /\ \E id \in NewIds \ used : onOmp' = id /\ used' = used \cup {id}
    /\ shown' = NoS /\ named' = FALSE /\ moved' = FALSE
    /\ path' = IF LearnsChange THEN NoS ELSE path
    /\ isNew' = IF LearnsChange THEN TRUE ELSE isNew
    /\ UNCHANGED <<written, proc, lastOpen, spawns, gated>>

Next ==
    \/ Spawn \/ Ready \/ Observe \/ Write \/ Crash \/ Restart \/ Move \/ GateMove \/ NewSession
    \/ \E f \in Stored : Open(f)
    \/ \E f \in Stored \cup Others : Switch(f)

Spec == Init /\ [][Next]_vars

\* FROZEN PROPERTIES
\* `--session` never names a file stock has not written (it exits "Session not found").
NoMissingSession == lastOpen.k = "session" => lastOpen.f \in written

\* Every spawn of a tab whose session stock has written opens that session.
KeepsSession == (proc = "booting" /\ shown # NoS /\ shown \in written) => onOmp = shown

\* No spawn puts the tab on another written session than the one it shows, unless the person moved it to another folder.
NeverAnother == (proc = "booting" /\ ~moved) => onOmp \in {shown} \cup NewIds

\* Added after freezing (review of 29 Oct 2026): a tab whose session was established and that the person moved to
\* another folder leaves the session there to omp (stock's autoResume), as the code did before this model: being new
\* is a creation contract (the comment once at #handleReady), not something a moved tab regains.
MoveLeavesChoice == (proc = "booting" /\ moved /\ named) => lastOpen.k = "default"
\* END FROZEN PROPERTIES

\* Sanity (must fail): a spawn can reopen a stored session.
NeverReopens == lastOpen.k # "session"
\* Sanity (must fail): a crash after the first answer is reachable.
NeverCrashAfterTurn == ~(proc = "none" /\ spawns > 0 /\ shown \in written \cap NewIds)
=============================================================================
