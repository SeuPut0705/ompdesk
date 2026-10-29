---------------------------- MODULE CheckoutClaims ----------------------------
(***************************************************************************)
(* Shared-checkout claims: which session owns a file it changed and nobody *)
(* committed. One file F, one owning session A (its main agent and a       *)
(* subagent share A's ledger), one peer B that only reads what main tells  *)
(* it, and main's coordinator, whose pass is four steps split by awaits.   *)
(*                                                                         *)
(* A's ledger (resources/gui-bridge/modes/checkout-claims.ts ClaimBook) is *)
(* the state machine: a call's hook claims F with a fresh stamp, its      *)
(* result settles it, an agent's run end settles that agent's calls, a     *)
(* retire main sends drops a claim git no longer lists, a restart restores *)
(* the journal under a new instance. Main (src/main/checkout-peers.ts)     *)
(* reads A's status, asks git, judges, retires and tells B.                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Owners,       \* A's agents: the main agent and a subagent
    MaxCalls,     \* tool calls A's agents make in a behaviour
    MaxSeq,       \* bound on the ledger's stamp counter
    MaxRestarts,  \* omp restarts of A (update, relaunch)
    MaxWorld      \* commits and B's own writes of F

Kinds == {"file", "shell"}
NoCall == [id |-> 0, owner |-> "none", kind |-> "file", st |-> 0, earlier |-> 0]

VARIABLES
    \* A's bridge: the ledger, for the one file F
    stamp,     \* F's claim stamp; 0 = A holds no claim on F
    seq,       \* the ledger's stamp counter (a new omp process starts at 0)
    inst,      \* the omp process load (`instance`)
    calls,     \* calls the ledger holds pending (not reported back): [id, owner, kind, st, earlier]
    running,   \* ids of calls the tool is really executing (a call stock refused after the hook never runs)
    landed,    \* ids of calls whose bytes landed
    nextId,
    \* the world
    dirty,     \* git lists F
    aWrote,    \* history: a write of A's landed since F was last committed
    world,     \* commits and B writes so far (bound)
    restarts,
    \* main's coordinator
    phase,     \* "idle" | "git" | "judge" | "retire" | "send"
    known,     \* the status this pass judges: [held, st, pending, inst]
    cache,     \* main's remembered answer (#statuses)
    listing,   \* "dirty" | "clean" | "fail": what git said this pass
    committed, \* #committed: claims the last good listing found committed
    proposal,  \* the retire this pass sent: [inst, st], or none
    inflight,  \* retires A's bridge has not handled yet
    view,      \* this pass's verdict: F is A's
    viewKey,   \* the claim (<<inst, st>>) that verdict rests on
    \* B and history
    bview,     \* what B was last told: F is A's
    bkey,      \* the claim B's view rests on
    shown,     \* ids of A's calls that were running when B was told F is A's
    released   \* claims (<<inst, st>>) main judged committed

vars == <<stamp, seq, inst, calls, running, landed, nextId, dirty, aWrote, world, restarts, phase, known, cache,
          listing, committed, proposal, inflight, view, viewKey, bview, bkey, shown, released>>
ledgerVars == <<stamp, seq, inst, calls, running, nextId>>
mainVars == <<phase, known, cache, listing, committed, proposal, view, viewKey>>
bVars == <<bview, bkey, shown, released>>

NoKey == <<0, 0>>
NoStatus == [held |-> FALSE, st |-> 0, pending |-> FALSE, inst |-> 0, fresh |-> FALSE]
NoProposal == [inst |-> 0, st |-> 0]

Init ==
    /\ stamp = 0 /\ seq = 0 /\ inst = 1 /\ calls = {} /\ running = {} /\ landed = {} /\ nextId = 1
    /\ dirty = FALSE /\ aWrote = FALSE /\ world = 0 /\ restarts = 0
    /\ phase = "idle" /\ known = NoStatus /\ cache = NoStatus /\ listing = "fail"
    /\ committed = {} /\ proposal = NoProposal /\ inflight = {}
    /\ view = FALSE /\ viewKey = NoKey
    /\ bview = FALSE /\ bkey = NoKey /\ shown = {} /\ released = {}

Writing == calls # {}

\* ---------------------------------------------------------------- A's ledger

\* @code resources/gui-bridge/modes/checkout-claims.ts:104-120 ClaimBook.begin: the hook claims F before the tool runs; the claim it took over is remembered
Start(o, k, runs) ==
    /\ nextId <= MaxCalls /\ seq < MaxSeq
    /\ \A c \in calls : c.owner # o
    /\ calls' = calls \cup {[id |-> nextId, owner |-> o, kind |-> k, st |-> seq + 1, earlier |-> stamp]}
    /\ running' = IF runs THEN running \cup {nextId} ELSE running
    /\ stamp' = seq + 1 /\ seq' = seq + 1 /\ nextId' = nextId + 1
    /\ UNCHANGED <<inst, dirty, aWrote, landed, world, restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED <<inflight>> /\ UNCHANGED bVars

\* The tool's bytes land (environment: the command or file tool writes F).
Land(id) ==
    /\ id \in running
    /\ dirty' = TRUE /\ aWrote' = TRUE /\ landed' = landed \cup {id}
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<world, restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED <<inflight>> /\ UNCHANGED bVars

\* The call wrote: F's stamp moves on (`#confirm`), so a retire main judged from a read taken while it ran matches nothing.
Confirmed(s, q) == IF s # 0 THEN <<q + 1, q + 1>> ELSE <<s, q>>
\* The call wrote nothing: F goes back to the claim it took over, unless a later call changed F (`#revert`).
Reverted(s, c) == IF s = c.st THEN c.earlier ELSE s

\* @code resources/gui-bridge/modes/checkout-claims.ts:133-152 ClaimBook.end: tool_result settles the call (a failed file tool wrote nothing)
End(c, ok) ==
    /\ c \in calls /\ c.id \in running
    \* A file tool that failed wrote nothing.
    /\ (~ok /\ c.kind = "file") => c.id \notin landed
    /\ calls' = calls \ {c} /\ running' = running \ {c.id}
    /\ IF ~ok /\ c.kind = "file"
         THEN stamp' = Reverted(stamp, c) /\ seq' = seq
         ELSE LET r == Confirmed(stamp, seq) IN stamp' = r[1] /\ seq' = r[2]
    /\ UNCHANGED <<inst, nextId, dirty, aWrote, landed, world, restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED <<inflight>> /\ UNCHANGED bVars

\* @code resources/gui-bridge/modes/checkout-claims.ts:180-193 ClaimBook.agentEnded: agent_end settles that agent's calls only; stock ends a run once its calls ran, so those left never ran
AgentEnd(o) ==
    /\ \E c \in calls : c.owner = o
    /\ \A c \in calls : c.owner = o => c.id \notin running
    /\ LET mine == {c \in calls : c.owner = o}
           c == CHOOSE x \in mine : TRUE
       IN /\ calls' = calls \ mine
          /\ IF c.kind = "file"
               THEN stamp' = Reverted(stamp, c) /\ seq' = seq
               ELSE LET r == Confirmed(stamp, seq) IN stamp' = r[1] /\ seq' = r[2]
    /\ UNCHANGED <<inst, running, nextId, dirty, aWrote, landed, world, restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED <<inflight>> /\ UNCHANGED bVars

\* @code resources/gui-bridge/modes/checkout-claims.ts:201-214 ClaimBook.retire: drops F only for this load's stamp, never while a call writes it; a running call that took over that claim reverts to none
BridgeRetire(m) ==
    /\ m \in inflight
    /\ inflight' = inflight \ {m}
    /\ IF m.inst = inst /\ stamp = m.st /\ ~Writing
         THEN stamp' = 0
         ELSE UNCHANGED stamp
    /\ calls' = IF m.inst = inst
                  THEN {[c EXCEPT !.earlier = IF c.earlier = m.st THEN 0 ELSE c.earlier] : c \in calls}
                  ELSE calls
    /\ UNCHANGED <<seq, inst, running, nextId, dirty, aWrote, landed, world, restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED bVars

\* @code resources/gui-bridge/modes/checkout-peers.ts:147-198 install: session_shutdown journals the claims; the next load restores them under a new instance, stamps from 1
Restart ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ calls' = {} /\ running' = {} /\ inflight' = {}
    /\ inst' = inst + 1
    /\ IF stamp # 0 THEN stamp' = 1 /\ seq' = 1 ELSE stamp' = 0 /\ seq' = 0
    /\ UNCHANGED <<nextId, dirty, aWrote, landed, world>> /\ UNCHANGED mainVars /\ UNCHANGED bVars

\* ---------------------------------------------------------------- the world

\* Someone commits F (the person in a terminal, B taking a file both changed).
Commit ==
    /\ world < MaxWorld /\ dirty
    /\ world' = world + 1 /\ dirty' = FALSE /\ aWrote' = FALSE /\ UNCHANGED landed
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED <<inflight>> /\ UNCHANGED bVars

\* B changes F itself (an edit the guard lets through).
BWrite ==
    /\ world < MaxWorld /\ ~dirty
    /\ world' = world + 1 /\ dirty' = TRUE
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<aWrote, landed, restarts>> /\ UNCHANGED mainVars
    /\ UNCHANGED <<inflight>> /\ UNCHANGED bVars

\* ---------------------------------------------------------------- main's pass

LedgerStatus == [held |-> stamp # 0, st |-> stamp, pending |-> Writing, inst |-> inst, fresh |-> TRUE]

\* @code src/main/checkout-peers.ts:316-323 #statusOf: A's answer, or the last one when its bridge does not answer in time
PassStatus ==
    /\ phase = "idle"
    /\ \/ /\ inflight = {}   \* the bridge answers its requests in order
          /\ known' = LedgerStatus /\ cache' = LedgerStatus
       \/ /\ known' = [cache EXCEPT !.fresh = FALSE] /\ UNCHANGED cache
    /\ phase' = "git"
    /\ UNCHANGED <<listing, committed, proposal, view, viewKey>>
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<dirty, aWrote, landed, world, restarts, inflight>> /\ UNCHANGED bVars

\* @code src/main/checkout-peers.ts:174-190 #pass: git status of the claimed paths, or a failure
PassGit ==
    /\ phase = "git"
    /\ \/ listing' = IF dirty THEN "dirty" ELSE "clean"
       \/ listing' = "fail"
    /\ phase' = "judge"
    /\ UNCHANGED <<known, cache, committed, proposal, view, viewKey>>
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<dirty, aWrote, landed, world, restarts, inflight>> /\ UNCHANGED bVars

\* @code resources/gui-bridge/modes/checkout-claims.ts:350-358 judgeClaim: kept, or committed (released and retired)
Verdict(k, l, before) ==
    IF k.pending THEN "keep"
    ELSE IF ~k.held THEN "none"
    \* Judged committed before, on this very claim (load and stamp): it stays committed whatever git says now.
    ELSE IF <<k.inst, k.st>> \in before THEN "committed"
    \* An answer older than this pass may miss a write started since: it never releases.
    ELSE IF ~k.fresh THEN "keep"
    ELSE IF l = "clean" THEN "committed"
    ELSE "keep"

\* @code src/main/checkout-peers.ts:191-230 #pass: the judgment, synchronous after git answered
PassJudge ==
    /\ phase = "judge"
    /\ LET v == Verdict(known, listing, committed)
           key == <<known.inst, known.st>>
       IN /\ view' = (v = "keep")
          /\ viewKey' = IF v = "keep" THEN key ELSE NoKey
          /\ committed' = IF v = "committed" THEN {key} ELSE {}
          /\ IF v = "committed"
               THEN /\ proposal' = [inst |-> known.inst, st |-> known.st]
                    /\ inflight' = inflight \cup {[inst |-> known.inst, st |-> known.st]}
                    /\ released' = released \cup {key}
                    /\ phase' = "retire"
               ELSE /\ proposal' = NoProposal /\ UNCHANGED <<inflight, released>>
                    /\ phase' = "send"
    /\ UNCHANGED <<known, cache, listing>>
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<dirty, aWrote, landed, world, restarts>>
    /\ UNCHANGED <<bview, bkey, shown>>

\* @code src/main/checkout-peers.ts:326-338 #retire: the bridge answers its claims after the retire, which main keeps; no answer in time keeps what main had
PassRetired ==
    /\ phase = "retire"
    /\ \/ /\ proposal \notin inflight /\ proposal.inst = inst
          /\ cache' = LedgerStatus
       \/ UNCHANGED cache
    /\ phase' = "send"
    /\ UNCHANGED <<known, listing, committed, proposal, view, viewKey>>
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<dirty, aWrote, landed, world, restarts, inflight>> /\ UNCHANGED bVars

\* @code src/main/checkout-peers.ts:345-359 #send: B is told, unless its bridge does not answer
PassSend ==
    /\ phase = "send"
    /\ \/ /\ bview' = view /\ bkey' = viewKey
          /\ shown' = IF view THEN shown \cup running ELSE shown
       \/ UNCHANGED <<bview, bkey, shown>>
    /\ phase' = "idle"
    /\ UNCHANGED <<known, cache, listing, committed, proposal, view, viewKey, released>>
    /\ UNCHANGED ledgerVars /\ UNCHANGED <<dirty, aWrote, landed, world, restarts, inflight>>

Next ==
    \/ \E o \in Owners, k \in Kinds, runs \in BOOLEAN : Start(o, k, runs)
    \/ \E id \in running : Land(id)
    \/ \E c \in calls, ok \in BOOLEAN : End(c, ok)
    \/ \E o \in Owners : AgentEnd(o)
    \/ \E m \in inflight : BridgeRetire(m)
    \/ Restart \/ Commit \/ BWrite
    \/ PassStatus \/ PassGit \/ PassJudge \/ PassRetired \/ PassSend

Spec == Init /\ [][Next]_vars

\* ======================= FROZEN PROPERTIES (Properties.md) =======================

TypeOK ==
    /\ stamp \in 0..MaxSeq /\ seq \in 0..MaxSeq
    /\ phase \in {"idle", "git", "judge", "retire", "send"}
    /\ listing \in {"dirty", "clean", "fail"}
    /\ bview \in BOOLEAN /\ view \in BOOLEAN

\* I1: once B was told F is A's while A's call wrote it, B keeps being told so until that call reports back.
NoEarlyRelease == \A id \in running : id \in shown => bview

\* I2a: a write of A's that nobody committed is always A's claim (never released, never lost).
NoLostClaim == aWrote => stamp # 0

\* I2b: a claim main judged committed is nobody's again: no later verdict of main's rests on it ...
NoStaleReturn == view => viewKey \notin released

\* I2c: ... and A's ledger lets go of it once no call writes F and main's retire was handled.
CommittedIsNobodys ==
    (stamp # 0 /\ <<inst, stamp>> \in released) => (calls # {} \/ [inst |-> inst, st |-> stamp] \in inflight)

\* I3: an agent's run end settles only its own calls: every write still running is held pending.
RunningIsPending == \A id \in running : \E c \in calls : c.id = id

\* ===================================================================================

\* Sanity (must FAIL): B can be told F is A's while A writes, and main can judge a claim committed.
NeverShownWhileWriting == ~(bview /\ \E id \in running : id \in shown)
NeverReleased == released = {}

StateBound == seq <= MaxSeq
=============================================================================
