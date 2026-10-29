---------------------------- MODULE ToolchainLock ----------------------------
(* The formal skill's install lock: withLock in                                 *)
(* resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/       *)
(* toolchain.ts. Waiters (Procs, all on this computer) race for a lock folder   *)
(* that a planted holder left behind, untouched for longer than staleMs: "D", a *)
(* holder on this computer whose pid is gone, or "R", a holder on ANOTHER       *)
(* computer (its pid cannot be asked; it may wake and release at any time).     *)
(* Each code step between two file-system calls is one action, so every         *)
(* interleaving of mkdir, read, stat, kill(0), rm and write is explored.        *)
(*                                                                              *)
(* Planted: which holders may have left the lock ("D", "R" or both); the liveness  *)
(*   run of 3 waiters takes one.                                                *)
(*                                                                              *)
(* Switches (a switch at its old value is an earlier version of the code that   *)
(* the matrix must show failing):                                               *)
(* GoneIsAbandoned: the code before 30 Oct 2026 (first fix): a lock that was    *)
(*   gone while judged counted as abandoned, and takeOver then re-checked       *)
(*   existsSync, so it removed a fresh lock another waiter had just made.       *)
(* TrustFirstRead: the other half of that code: a pid found dead condemned      *)
(*   whatever lock was there by then, even a new waiter's.                      *)
(* GuardedAcq = FALSE: the code before the second fix: plain acquire and        *)
(*   release did not take the .takeover guard, so a takeover that judged a lock *)
(*   stale and then deleted it could delete the fresh lock that the holder's    *)
(*   release and another waiter's acquire had left in between.                  *)
(* IdentityOnStale = FALSE: the stale branch (idle > staleMs) was not tied to   *)
(*   the owner re-read, so an old mtime condemned a lock whose owner changed.   *)
(* LocalStale = TRUE: the code before the second fix: staleness condemned a     *)
(*   live holder on this computer too (a laptop asleep past staleMs); now only  *)
(*   a lock whose holder cannot be asked (another computer, or no readable      *)
(*   owner) goes stale.                                                         *)
(* Freeze: a live holder on this computer may sleep past staleMs in its work.   *)
(* SleepMake: a process between mkdir and the owner write may sleep past        *)
(*   staleMs, leaving a half-made folder that looks abandoned.                  *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Procs, Planted, GoneIsAbandoned, TrustFirstRead, GuardedAcq, IdentityOnStale, LocalStale, Freeze, SleepMake

\* The waiters are interchangeable: safety-only runs may use this symmetry (never with Termination).
ProcSymmetry == Permutations(Procs)

Dead == "D"
Remote == "R"
None == "none"
Owners == Procs \cup {Dead, Remote, None}

VARIABLES
    lockExists,   \* the .lock-<name> folder
    lockOwner,    \* who owner.json names (None: folder made, owner not written yet)
    stale,        \* the lock's owner file (else folder) has not been touched for more than staleMs
    guard,        \* the .lock-<name>.takeover folder
    pc,           \* where each process is
    ctx,          \* which guarded section a process is in: "main" none, "ac" acquire, "tk" takeover, "rl" release
    seenOwner,    \* judge: the owner read first
    seenTouched,  \* judge: touched() found the lock
    seenStale,    \* judge: the mtime touched() returned makes the lock stale for this kind of holder
    seenDead,     \* judge: pidAlive(seenOwner) was false
    confirmed,    \* judge: the owner read again after kill(0) is still seenOwner
    tookOver,     \* history: live holders on this computer whose lock was removed by someone else while they worked
    rpc,          \* the remote holder R: asleep, then releasing, then gone
    rg            \* R holds the guard (while it releases)

vars == <<lockExists, lockOwner, stale, guard, pc, ctx, seenOwner, seenTouched, seenStale, seenDead, confirmed,
          tookOver, rpc, rg>>

PCs == {"acq_peek", "acq_guard", "acq_mkdir", "acq_write", "fail_rm", "fail_unguard", "failed",
        "j_owner", "j_touch", "j_alive", "j_confirm", "j_decide",
        "tk_guard", "tk_rm", "tk_unguard_ok", "tk_unguard_fail",
        "cs", "rl_guard", "rel_mine", "rel_rm", "rel_end", "done", "exited"}

RPCs == {"asleep", "r_guard", "r_mine", "r_rm", "r_end", "gone"}

TypeOK ==
    /\ lockExists \in BOOLEAN
    /\ lockOwner \in Owners
    /\ stale \in BOOLEAN
    /\ guard \in BOOLEAN
    /\ pc \in [Procs -> PCs]
    /\ ctx \in [Procs -> {"main", "ac", "tk", "rl"}]
    /\ seenOwner \in [Procs -> Owners]
    /\ seenTouched \in [Procs -> BOOLEAN]
    /\ seenStale \in [Procs -> BOOLEAN]
    /\ seenDead \in [Procs -> BOOLEAN]
    /\ confirmed \in [Procs -> BOOLEAN]
    /\ tookOver \subseteq Procs
    /\ rpc \in RPCs
    /\ rg \in BOOLEAN

Init ==
    /\ lockExists = TRUE /\ lockOwner \in Planted /\ stale = TRUE /\ guard = FALSE
    /\ pc = [p \in Procs |-> IF GuardedAcq THEN "acq_peek" ELSE "acq_mkdir"]
    /\ ctx = [p \in Procs |-> "main"]
    /\ seenOwner = [p \in Procs |-> None]
    /\ seenTouched = [p \in Procs |-> FALSE]
    /\ seenStale = [p \in Procs |-> FALSE]
    /\ seenDead = [p \in Procs |-> FALSE]
    /\ confirmed = [p \in Procs |-> FALSE]
    /\ tookOver = {}
    /\ rpc = IF lockOwner = Remote THEN "asleep" ELSE "gone"
    /\ rg = FALSE

\* What readOwner sees now.
OwnerNow == IF lockExists THEN lockOwner ELSE None
\* pidAlive is false: the planted local holder, or a process that has exited. R is on another computer: unknown.
DeadNow(o) == o = Dead \/ (o \in Procs /\ pc[o] = "exited")

Goto(p, where) == pc' = [pc EXCEPT ![p] = where]
Locals == <<seenOwner, seenTouched, seenStale, seenDead, confirmed>>
RVars == <<rpc, rg>>

\* Where a loop restarts: the guarded code looks, then takes the guard.
LoopStart == IF GuardedAcq THEN "acq_peek" ELSE "acq_mkdir"

\* The live holder on this computer whose work a removal of the lock ends.
Victim == IF lockExists /\ lockOwner \in Procs /\ pc[lockOwner] = "cs" THEN {lockOwner} ELSE {}

\* ---- acquire() --------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:598 acquire: existsSync(lock) first, so a waiter polling a held lock does not take the guard
AcqPeek(p) ==
    /\ pc[p] = "acq_peek"
    /\ Goto(p, IF lockExists THEN "j_owner" ELSE "acq_guard")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:543-555 acquire: tryGuard, mkdirSync(guard); EEXIST returns false (the 30 s stale guard is out of scope)
AcqGuardOk(p) ==
    /\ pc[p] = "acq_guard" /\ ~guard
    /\ guard' = TRUE /\ ctx' = [ctx EXCEPT ![p] = "ac"] /\ Goto(p, "acq_mkdir")
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

AcqGuardBusy(p) ==
    /\ pc[p] = "acq_guard" /\ guard
    /\ Goto(p, "j_owner")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

AcqGuard(p) == AcqGuardOk(p) \/ AcqGuardBusy(p)

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:579-586 makeLock: mkdirSync(lock); EEXIST returns false
AcqMkdir(p) ==
    /\ pc[p] = "acq_mkdir"
    /\ IF ~lockExists
       THEN /\ lockExists' = TRUE /\ lockOwner' = None /\ stale' = FALSE /\ Goto(p, "acq_write")
            /\ UNCHANGED <<guard, ctx>>
       ELSE /\ UNCHANGED <<lockExists, lockOwner, stale>>
            /\ IF ctx[p] = "tk" THEN Goto(p, "tk_unguard_fail") ELSE Goto(p, "j_owner")
            \* the acquire's guard is let go as the false returns
            /\ IF ctx[p] = "ac" THEN guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] ELSE UNCHANGED <<guard, ctx>>
    /\ UNCHANGED <<tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:587-593 makeLock: writeFileSync(owner.json) into whatever folder is there now
AcqWrite(p) ==
    /\ pc[p] = "acq_write"
    /\ IF lockExists
       THEN /\ lockOwner' = p /\ stale' = FALSE
            /\ Goto(p, IF ctx[p] = "main" THEN "cs" ELSE "tk_unguard_ok")
       ELSE /\ UNCHANGED <<lockOwner, stale>> /\ Goto(p, "fail_rm")
    /\ UNCHANGED <<lockExists, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:589-592 the write failed (ENOENT): rmSync(lock), then throw
FailRm(p) ==
    /\ pc[p] = "fail_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None /\ tookOver' = tookOver \cup Victim /\ UNCHANGED stale
    /\ Goto(p, IF ctx[p] = "main" THEN "failed" ELSE "fail_unguard")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:642-644 the error leaves acquire / takeOver: finally removes the guard
FailUnguard(p) ==
    /\ pc[p] = "fail_unguard"
    /\ guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] /\ Goto(p, "failed")
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* ---- judge() ----------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:617 judge: readOwner(owner.json)
JOwner(p) ==
    /\ pc[p] = "j_owner"
    /\ seenOwner' = [seenOwner EXCEPT ![p] = OwnerNow]
    /\ Goto(p, "j_touch")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, seenTouched, seenStale, seenDead, confirmed, tookOver>>
    /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:618-620 judge: touched() stats owner.json, else the folder; null = gone; idle = now - mtime. Stale counts only for a holder that cannot be asked (another computer, no readable owner) unless LocalStale
JTouch(p) ==
    /\ pc[p] = "j_touch"
    /\ seenTouched' = [seenTouched EXCEPT ![p] = lockExists]
    /\ seenStale' = [seenStale EXCEPT ![p] = lockExists /\ stale /\ (LocalStale \/ seenOwner[p] \in {Remote, None})]
    /\ Goto(p, "j_alive")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, seenOwner, seenDead, confirmed, tookOver>>
    /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:621-622 judge: this computer's holder and !pidAlive(owner.pid) (kill 0)
JAlive(p) ==
    /\ pc[p] = "j_alive"
    /\ seenDead' = [seenDead EXCEPT ![p] = DeadNow(seenOwner[p])]
    /\ Goto(p, "j_confirm")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, seenOwner, seenTouched, seenStale, confirmed, tookOver>>
    /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:623-624 judge: the owner read again must be the same record (pid, start, token); a change cancels both reasons
JConfirm(p) ==
    /\ pc[p] = "j_confirm"
    /\ confirmed' = [confirmed EXCEPT ![p] = TrustFirstRead \/ OwnerNow = seenOwner[p]]
    /\ Goto(p, "j_decide")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, seenOwner, seenTouched, seenStale, seenDead, tookOver>>
    /\ UNCHANGED RVars

Abandoned(p) ==
    IF GoneIsAbandoned
    THEN (seenDead[p] /\ confirmed[p]) \/ ~seenTouched[p]
    ELSE seenTouched[p] /\ IF IdentityOnStale
                           THEN confirmed[p] /\ (seenDead[p] \/ seenStale[p])
                           ELSE (seenDead[p] /\ confirmed[p]) \/ seenStale[p]

\* What takeOver checks for "no lock": the code before the first fix asked existsSync now, the fix uses judge's own stat.
TakeoverSeesNoLock(p) == IF GoneIsAbandoned THEN ~lockExists ELSE ~seenTouched[p]

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:625 judge: abandoned = dead || (not this computer's && idle > staleMs), after the identity check
\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:654-656 main loop: an abandoned lock goes to takeOver, else poll
\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:630-638 takeOver, inside the guard: gone -> makeLock, not abandoned -> give up, else remove
JDecide(p) ==
    /\ pc[p] = "j_decide"
    /\ IF ctx[p] = "main"
       THEN Goto(p, IF Abandoned(p) THEN "tk_guard" ELSE LoopStart)
       ELSE Goto(p, IF TakeoverSeesNoLock(p) THEN "acq_mkdir"
                    ELSE IF ~Abandoned(p) THEN "tk_unguard_fail"
                    ELSE "tk_rm")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* ---- takeOver() -------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:543-555 takeOver: tryGuard, mkdirSync(guard); EEXIST returns false (the 30 s stale guard is out of scope)
TkGuardOk(p) ==
    /\ pc[p] = "tk_guard" /\ ~guard
    /\ guard' = TRUE /\ ctx' = [ctx EXCEPT ![p] = "tk"] /\ Goto(p, "j_owner")
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

TkGuardBusy(p) ==
    /\ pc[p] = "tk_guard" /\ guard
    /\ Goto(p, LoopStart)
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

TkGuard(p) == TkGuardOk(p) \/ TkGuardBusy(p)

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:638 rmSync(lock) of the lock judged abandoned
TkRm(p) ==
    /\ pc[p] = "tk_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None /\ tookOver' = tookOver \cup Victim /\ UNCHANGED stale
    /\ Goto(p, "acq_mkdir")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:639-644 makeLock returned true; finally removes the guard (acquire: the same)
TkUnguardOk(p) ==
    /\ pc[p] = "tk_unguard_ok"
    /\ guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] /\ Goto(p, "cs")
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:639-644 takeOver returned false; finally removes the guard, the loop polls again
TkUnguardFail(p) ==
    /\ pc[p] = "tk_unguard_fail"
    /\ guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] /\ Goto(p, LoopStart)
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* ---- the work, the sleeping holder and release() ----------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:700 the critical section: work(signal)
Work(p) ==
    /\ pc[p] = "cs" /\ Goto(p, IF GuardedAcq THEN "rl_guard" ELSE "rel_mine")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* Environment (this computer sleeps): a live holder on this computer stops touching its lock for longer than staleMs.
\* Also a process between mkdir and the owner write, whose folder then looks abandoned.
Sleep(p) ==
    /\ \/ /\ Freeze /\ pc[p] = "cs" /\ lockExists /\ lockOwner = p
       \/ /\ SleepMake /\ pc[p] = "acq_write" /\ lockExists /\ lockOwner = None
    /\ stale' = TRUE
    /\ UNCHANGED <<lockExists, lockOwner, guard, pc, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:560-572 release: underGuardSync waits for the guard (blocking spin, a few ms)
RlGuard(p) ==
    /\ pc[p] = "rl_guard" /\ ~guard
    /\ guard' = TRUE /\ ctx' = [ctx EXCEPT ![p] = "rl"] /\ Goto(p, "rel_mine")
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:525-528 release: mine() reads owner.json and compares pid, host, token
RelMine(p) ==
    /\ pc[p] = "rel_mine"
    /\ Goto(p, IF OwnerNow = p THEN "rel_rm" ELSE "rel_end")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:575 release: rmSync(lock)
RelRm(p) ==
    /\ pc[p] = "rel_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None /\ tookOver' = tookOver \cup Victim /\ UNCHANGED stale
    /\ Goto(p, "rel_end")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:573-577 release: the guard is removed as underGuardSync returns
RelEnd(p) ==
    /\ pc[p] = "rel_end"
    /\ IF ctx[p] = "rl" THEN guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] ELSE UNCHANGED <<guard, ctx>>
    /\ Goto(p, "done")
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* Environment, not code: the process exits after withLock returned or threw; from now on kill(pid, 0) fails.
Exit(p) ==
    /\ pc[p] = "done" /\ Goto(p, "exited")
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED RVars

\* ---- the holder on another computer (environment) ---------------------------

\* R's computer wakes and R finishes: its release (the same code, running over there). Before the guard existed it
\* read the owner and removed the folder in two steps.
ROut ==
    /\ rpc = "asleep" /\ rpc' = (IF GuardedAcq THEN "r_guard" ELSE "r_mine") /\ UNCHANGED rg
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, pc, ctx, tookOver>> /\ UNCHANGED Locals

RGuard ==
    /\ rpc = "r_guard" /\ ~guard
    /\ guard' = TRUE /\ rg' = TRUE /\ rpc' = "r_mine"
    /\ UNCHANGED <<lockExists, lockOwner, stale, pc, ctx, tookOver>> /\ UNCHANGED Locals

RMine ==
    /\ rpc = "r_mine"
    /\ rpc' = (IF OwnerNow = Remote THEN "r_rm" ELSE "r_end") /\ UNCHANGED rg
    /\ UNCHANGED <<lockExists, lockOwner, stale, guard, pc, ctx, tookOver>> /\ UNCHANGED Locals

RRm ==
    /\ rpc = "r_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None /\ rpc' = "r_end" /\ UNCHANGED <<rg, stale, tookOver>>
    /\ UNCHANGED <<guard, pc, ctx>> /\ UNCHANGED Locals

REnd ==
    /\ rpc = "r_end"
    /\ IF rg THEN guard' = FALSE /\ rg' = FALSE ELSE UNCHANGED <<guard, rg>>
    /\ rpc' = "gone"
    /\ UNCHANGED <<lockExists, lockOwner, stale, pc, ctx, tookOver>> /\ UNCHANGED Locals

RStep == ROut \/ RGuard \/ RMine \/ RRm \/ REnd

Step(p) ==
    \/ AcqPeek(p) \/ AcqGuard(p) \/ AcqMkdir(p) \/ AcqWrite(p) \/ FailRm(p) \/ FailUnguard(p)
    \/ JOwner(p) \/ JTouch(p) \/ JAlive(p) \/ JConfirm(p) \/ JDecide(p)
    \/ TkGuard(p) \/ TkRm(p) \/ TkUnguardOk(p) \/ TkUnguardFail(p)
    \/ Work(p) \/ RlGuard(p) \/ RelMine(p) \/ RelRm(p) \/ RelEnd(p) \/ Exit(p)

\* Sleeping is an environment step, outside weak fairness: a holder may sleep, never has to.
Finished == /\ \A p \in Procs : pc[p] \in {"exited", "failed"}
            /\ rpc \in {"asleep", "gone"}
Next == (\E p \in Procs : Step(p) \/ Sleep(p)) \/ RStep \/ (Finished /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Step(p)) /\ SF_vars(RlGuard(p))
        /\ WF_vars(RStep) /\ SF_vars(RGuard)

\* ==== FROZEN PROPERTIES (Properties.md) ====================================
\* P1: at most one process runs the work at a time.
MutualExclusion == Cardinality({p \in Procs : pc[p] = "cs"}) <= 1
\* P2: no waiter fails because another removed the folder it was writing into.
NoFailure == \A p \in Procs : pc[p] # "failed"
\* P3: every waiter gets the lock once and finishes.
Termination == <>(\A p \in Procs : pc[p] = "exited")
\* P4: a live holder on this computer never loses its lock to a takeover, however long it slept.
LiveHolderKept == tookOver = {}
\* ==== END FROZEN PROPERTIES ================================================

\* Sanity (must FAIL): somebody does get the lock.
NeverHeld == \A p \in Procs : pc[p] # "cs"
=============================================================================
