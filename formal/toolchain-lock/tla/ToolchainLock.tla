---------------------------- MODULE ToolchainLock ----------------------------
(* The formal skill's install lock: withLock in                                 *)
(* resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/       *)
(* toolchain.ts. Waiters race for a lock folder that a dead process left        *)
(* behind (the planted owner "D"). Each code step between two file-system       *)
(* calls is one action, so every interleaving of mkdir, read, stat, kill(0),    *)
(* rm and write is explored.                                                    *)
(*                                                                              *)
(* GoneIsAbandoned = TRUE is the code before the fix of 30 Oct 2026: a lock     *)
(* that was gone while judged counted as abandoned (touched() gave 0), and the  *)
(* takeover then re-checked existsSync, so it removed a fresh lock another      *)
(* waiter had just made. TrustFirstRead = TRUE is the other half of that code:  *)
(* a pid found dead condemned whatever lock was there by then, even when the    *)
(* owner read before it had released and a new waiter held the folder.         *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Procs, GoneIsAbandoned, TrustFirstRead

\* The waiters are interchangeable: safety-only runs may use this symmetry (never with Termination).
ProcSymmetry == Permutations(Procs)

Dead == "D"
None == "none"
Owners == Procs \cup {Dead, None}

VARIABLES
    lockExists,   \* the .lock-<name> folder
    lockOwner,    \* who owner.json names (None: folder made, owner not written yet)
    guard,        \* the .lock-<name>.takeover folder
    pc,           \* where each process is
    ctx,          \* "tk" while this process holds the guard
    seenOwner,    \* judge: the owner read first
    seenTouched,  \* judge: touched() found the lock
    seenDead,     \* judge: pidAlive(seenOwner) was false
    confirmed     \* judge: the owner read again after kill(0) is still seenOwner

vars == <<lockExists, lockOwner, guard, pc, ctx, seenOwner, seenTouched, seenDead, confirmed>>

PCs == {"acq_mkdir", "acq_write", "fail_rm", "fail_unguard", "failed",
        "j_owner", "j_touch", "j_alive", "j_confirm", "j_decide",
        "tk_guard", "tk_rm", "tk_unguard_ok", "tk_unguard_fail",
        "cs", "rel_mine", "rel_rm", "done", "exited"}

TypeOK ==
    /\ lockExists \in BOOLEAN
    /\ lockOwner \in Owners
    /\ guard \in BOOLEAN
    /\ pc \in [Procs -> PCs]
    /\ ctx \in [Procs -> {"main", "tk"}]
    /\ seenOwner \in [Procs -> Owners]
    /\ seenTouched \in [Procs -> BOOLEAN]
    /\ seenDead \in [Procs -> BOOLEAN]
    /\ confirmed \in [Procs -> BOOLEAN]

Init ==
    /\ lockExists = TRUE /\ lockOwner = Dead /\ guard = FALSE
    /\ pc = [p \in Procs |-> "acq_mkdir"]
    /\ ctx = [p \in Procs |-> "main"]
    /\ seenOwner = [p \in Procs |-> None]
    /\ seenTouched = [p \in Procs |-> FALSE]
    /\ seenDead = [p \in Procs |-> FALSE]
    /\ confirmed = [p \in Procs |-> FALSE]

\* What readOwner sees now.
OwnerNow == IF lockExists THEN lockOwner ELSE None
\* pidAlive is false: the planted holder, or a process that has exited.
DeadNow(o) == o = Dead \/ (o \in Procs /\ pc[o] = "exited")

Goto(p, where) == pc' = [pc EXCEPT ![p] = where]
Locals == <<seenOwner, seenTouched, seenDead, confirmed>>

\* ---- acquire() --------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:517-524 acquire: mkdirSync(lock); EEXIST returns false
AcqMkdir(p) ==
    /\ pc[p] = "acq_mkdir"
    /\ IF ~lockExists
       THEN /\ lockExists' = TRUE /\ lockOwner' = None /\ Goto(p, "acq_write")
       ELSE /\ UNCHANGED <<lockExists, lockOwner>>
            /\ Goto(p, IF ctx[p] = "tk" THEN "tk_unguard_fail" ELSE "j_owner")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:525-531 acquire: writeFileSync(owner.json) into whatever folder is there now
AcqWrite(p) ==
    /\ pc[p] = "acq_write"
    /\ IF lockExists
       THEN /\ lockOwner' = p
            /\ Goto(p, IF ctx[p] = "tk" THEN "tk_unguard_ok" ELSE "cs")
       ELSE /\ UNCHANGED lockOwner /\ Goto(p, "fail_rm")
    /\ UNCHANGED <<lockExists, guard, ctx>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:527-529 the write failed (ENOENT): rmSync(lock), then throw
FailRm(p) ==
    /\ pc[p] = "fail_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None
    /\ Goto(p, IF ctx[p] = "tk" THEN "fail_unguard" ELSE "failed")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:575-579 takeOver's finally removes the guard as the error leaves
FailUnguard(p) ==
    /\ pc[p] = "fail_unguard"
    /\ guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] /\ Goto(p, "failed")
    /\ UNCHANGED <<lockExists, lockOwner>> /\ UNCHANGED Locals

\* ---- judge() ----------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:541 judge: readOwner(owner.json)
JOwner(p) ==
    /\ pc[p] = "j_owner"
    /\ seenOwner' = [seenOwner EXCEPT ![p] = OwnerNow]
    /\ Goto(p, "j_touch")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx, seenTouched, seenDead, confirmed>>

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:542-543 judge: touched() stats owner.json, else the folder; null = gone
JTouch(p) ==
    /\ pc[p] = "j_touch"
    /\ seenTouched' = [seenTouched EXCEPT ![p] = lockExists]
    /\ Goto(p, "j_alive")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx, seenOwner, seenDead, confirmed>>

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:545 judge: !pidAlive(owner.pid) (kill 0)
JAlive(p) ==
    /\ pc[p] = "j_alive"
    /\ seenDead' = [seenDead EXCEPT ![p] = DeadNow(seenOwner[p])]
    /\ Goto(p, "j_confirm")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx, seenOwner, seenTouched, confirmed>>

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:546-550 judge: the owner read again must be the same record (pid, start, token)
JConfirm(p) ==
    /\ pc[p] = "j_confirm"
    /\ confirmed' = [confirmed EXCEPT ![p] = TrustFirstRead \/ OwnerNow = seenOwner[p]]
    /\ Goto(p, "j_decide")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx, seenOwner, seenTouched, seenDead>>

Abandoned(p) ==
    IF GoneIsAbandoned
    THEN (seenDead[p] /\ confirmed[p]) \/ ~seenTouched[p]
    ELSE seenTouched[p] /\ seenDead[p] /\ confirmed[p]

\* What takeOver checks for "no lock": the code before the fix asked existsSync now, the fix uses judge's own stat.
TakeoverSeesNoLock(p) == IF GoneIsAbandoned THEN ~lockExists ELSE ~seenTouched[p]

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:589-591 main loop: an abandoned lock goes to takeOver, else poll
\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:565-567 takeOver, inside the guard: gone -> acquire, not abandoned -> give up, else remove
JDecide(p) ==
    /\ pc[p] = "j_decide"
    /\ IF ctx[p] = "main"
       THEN Goto(p, IF Abandoned(p) THEN "tk_guard" ELSE "acq_mkdir")
       ELSE Goto(p, IF TakeoverSeesNoLock(p) THEN "acq_mkdir"
                    ELSE IF ~Abandoned(p) THEN "tk_unguard_fail"
                    ELSE "tk_rm")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx>> /\ UNCHANGED Locals

\* ---- takeOver() -------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:554-563 mkdirSync(guard); EEXIST returns false (the 30 s stale guard is out of scope)
TkGuard(p) ==
    /\ pc[p] = "tk_guard"
    /\ IF ~guard
       THEN /\ guard' = TRUE /\ ctx' = [ctx EXCEPT ![p] = "tk"] /\ Goto(p, "j_owner")
       ELSE /\ UNCHANGED <<guard, ctx>> /\ Goto(p, "acq_mkdir")
    /\ UNCHANGED <<lockExists, lockOwner>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:573 rmSync(lock) of the lock judged abandoned
TkRm(p) ==
    /\ pc[p] = "tk_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None
    /\ Goto(p, "acq_mkdir")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:574-579 acquire returned true; finally removes the guard
TkUnguardOk(p) ==
    /\ pc[p] = "tk_unguard_ok"
    /\ guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] /\ Goto(p, "cs")
    /\ UNCHANGED <<lockExists, lockOwner>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:577-579 takeOver returned false; finally removes the guard, the loop polls again
TkUnguardFail(p) ==
    /\ pc[p] = "tk_unguard_fail"
    /\ guard' = FALSE /\ ctx' = [ctx EXCEPT ![p] = "main"] /\ Goto(p, "acq_mkdir")
    /\ UNCHANGED <<lockExists, lockOwner>> /\ UNCHANGED Locals

\* ---- the work and release() -------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:616-620 the critical section: work()
Work(p) ==
    /\ pc[p] = "cs" /\ Goto(p, "rel_mine")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:501-506 release: mine() reads owner.json and compares pid, host, token
RelMine(p) ==
    /\ pc[p] = "rel_mine"
    /\ Goto(p, IF OwnerNow = p THEN "rel_rm" ELSE "done")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx>> /\ UNCHANGED Locals

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:506 release: rmSync(lock)
RelRm(p) ==
    /\ pc[p] = "rel_rm"
    /\ lockExists' = FALSE /\ lockOwner' = None /\ Goto(p, "done")
    /\ UNCHANGED <<guard, ctx>> /\ UNCHANGED Locals

\* Environment, not code: the process exits after withLock returned; from now on kill(pid, 0) fails.
Exit(p) ==
    /\ pc[p] = "done" /\ Goto(p, "exited")
    /\ UNCHANGED <<lockExists, lockOwner, guard, ctx>> /\ UNCHANGED Locals

Step(p) ==
    \/ AcqMkdir(p) \/ AcqWrite(p) \/ FailRm(p) \/ FailUnguard(p)
    \/ JOwner(p) \/ JTouch(p) \/ JAlive(p) \/ JConfirm(p) \/ JDecide(p)
    \/ TkGuard(p) \/ TkRm(p) \/ TkUnguardOk(p) \/ TkUnguardFail(p)
    \/ Work(p) \/ RelMine(p) \/ RelRm(p) \/ Exit(p)

Finished == \A p \in Procs : pc[p] \in {"exited", "failed"}
Next == (\E p \in Procs : Step(p)) \/ (Finished /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Step(p))

\* ==== FROZEN PROPERTIES (Properties.md) ====================================
\* P1: at most one process runs the work at a time.
MutualExclusion == Cardinality({p \in Procs : pc[p] = "cs"}) <= 1
\* P2: no waiter fails because another removed the folder it was writing into.
NoFailure == \A p \in Procs : pc[p] # "failed"
\* P3: every waiter gets the lock once and finishes.
Termination == <>(\A p \in Procs : pc[p] = "exited")
\* ==== END FROZEN PROPERTIES ================================================

\* Sanity (must FAIL): somebody does get the lock.
NeverHeld == \A p \in Procs : pc[p] # "cs"
=============================================================================
