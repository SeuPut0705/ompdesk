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
(* GuardedAcq = FALSE: the code before the second fix: acquire did not take the *)
(*   .takeover guard, so a half-made folder (its maker asleep before the owner  *)
(*   write) could be taken over and then written into.                          *)
(* GuardedRel = FALSE: the same for release (a local holder's and the remote    *)
(*   holder R's): a release is its owner check followed by a delete; a takeover *)
(*   that judged the lock stale could land between them or before the delete.   *)
(* IdentityOnStale = FALSE: the stale branch (idle > staleMs) was not tied to   *)
(*   the owner re-read, so an old mtime condemned a lock whose owner changed.   *)
(* LocalStale = TRUE: the code before the second fix: staleness condemned a     *)
(*   live holder on this computer too (a laptop asleep past staleMs); now only  *)
(*   a lock whose holder cannot be asked (another computer, or no readable      *)
(*   owner) goes stale.                                                         *)
(* Freeze: a live holder on this computer may sleep past staleMs in its work.   *)
(* SleepMake: a process between mkdir and the owner write may sleep past        *)
(*   staleMs, leaving a half-made folder that looks abandoned.                  *)
(*                                                                              *)
(* The guard itself (30 Oct 2026): it names its holder (gown, a token in the    *)
(* folder). A holder may stall past 30 s under it (Stalls: how many stalls the  *)
(* run may hold; asleep, SIGSTOP), after which the guard is stale: its holder's *)
(* own checks fail and a reclaimer may remove it.                               *)
(* Reclaim: "none" (nobody reclaims), "identity" (the code: the folder that was *)
(*   judged stale is moved aside, compared by its token and deleted; one that   *)
(*   is not the judged one is put back), "name" (the code before: stat, then    *)
(*   delete the name, whatever guard it names by then).                         *)
(* Recheck: "atomic" (the code: right before each destructive call the holder   *)
(*   checks that the guard still holds its token and is not stale), "gap" (the  *)
(*   check is the previous step: a stall between check and call is explored),   *)
(*   "off" (no check).                                                          *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Procs, Planted, GoneIsAbandoned, TrustFirstRead, GuardedAcq, GuardedRel, IdentityOnStale, LocalStale,
          Freeze, SleepMake, Stalls, Reclaim, Recheck

\* The waiters are interchangeable: safety-only runs may use this symmetry (never with Termination).
ProcSymmetry == Permutations(Procs)

Dead == "D"
Remote == "R"
None == "none"
Owners == Procs \cup {Dead, Remote, None}
Holders == Procs \cup {Remote, None}

VARIABLES
    lockExists,   \* the .lock-<name> folder
    lockOwner,    \* who owner.json names (None: folder made, owner not written yet)
    stale,        \* the lock's owner file (else folder) has not been touched for more than staleMs
    gown,         \* the .lock-<name>.takeover folder: who its token names (None: no such folder)
    gstalled,     \* the guard that exists was taken more than 30 s ago and not released (its holder stalled)
    pc,           \* where each process is
    ctx,          \* which guarded section a process is in: "main" none, "ac" acquire, "tk" takeover, "rl" release
    chk,          \* "gap" mode: the guard check a process made at the step before its destructive call
    seenOwner,    \* judge: the owner read first
    seenTouched,  \* judge: touched() found the lock
    seenStale,    \* judge: the mtime touched() returned makes the lock stale for this kind of holder
    seenDead,     \* judge: pidAlive(seenOwner) was false
    confirmed,    \* judge: the owner read again after kill(0) is still seenOwner
    tookOver,     \* history: live holders on this computer whose lock was removed by someone else while they worked
    rpc,          \* the remote holder R: asleep, then releasing, then gone
    rg,           \* R holds the guard (while it releases)
    stalls,       \* how many guard holders have stalled so far
    qpc,          \* the guard reclaimer: idle, judged a stale guard, done
    guardBroken   \* history: a reclaimer removed a guard whose holder had not stalled

vars == <<lockExists, lockOwner, stale, gown, gstalled, pc, ctx, chk, seenOwner, seenTouched, seenStale, seenDead,
          confirmed, tookOver, rpc, rg, stalls, qpc, guardBroken>>

PCs == {"acq_peek", "acq_guard", "acq_mkdir", "acq_write", "fail_rm", "fail_unguard", "failed",
        "j_owner", "j_touch", "j_alive", "j_confirm", "j_decide",
        "tk_guard", "tk_rm", "tk_unguard_ok", "tk_unguard_fail",
        "cs", "rl_guard", "rel_mine", "rel_rm", "rel_lost", "rel_end", "done", "exited"}

RPCs == {"asleep", "r_guard", "r_mine", "r_rm", "r_end", "gone"}

TypeOK ==
    /\ lockExists \in BOOLEAN
    /\ lockOwner \in Owners
    /\ stale \in BOOLEAN
    /\ gown \in Holders
    /\ gstalled \in BOOLEAN
    /\ pc \in [Procs -> PCs]
    /\ ctx \in [Procs -> {"main", "ac", "tk", "rl"}]
    /\ chk \in [Procs -> BOOLEAN]
    /\ seenOwner \in [Procs -> Owners]
    /\ seenTouched \in [Procs -> BOOLEAN]
    /\ seenStale \in [Procs -> BOOLEAN]
    /\ seenDead \in [Procs -> BOOLEAN]
    /\ confirmed \in [Procs -> BOOLEAN]
    /\ tookOver \subseteq Procs
    /\ rpc \in RPCs
    /\ rg \in BOOLEAN
    /\ stalls \in Nat
    /\ qpc \in {"q_idle", "q_judged", "q_done"}
    /\ guardBroken \in BOOLEAN

Init ==
    /\ lockExists = TRUE /\ lockOwner \in Planted /\ stale = TRUE /\ gown = None /\ gstalled = FALSE
    /\ pc = [p \in Procs |-> IF GuardedAcq THEN "acq_peek" ELSE "acq_mkdir"]
    /\ ctx = [p \in Procs |-> "main"]
    /\ chk = [p \in Procs |-> TRUE]
    /\ seenOwner = [p \in Procs |-> None]
    /\ seenTouched = [p \in Procs |-> FALSE]
    /\ seenStale = [p \in Procs |-> FALSE]
    /\ seenDead = [p \in Procs |-> FALSE]
    /\ confirmed = [p \in Procs |-> FALSE]
    /\ tookOver = {}
    /\ rpc = IF lockOwner = Remote THEN "asleep" ELSE "gone"
    /\ rg = FALSE
    /\ stalls = 0 /\ qpc = "q_idle" /\ guardBroken = FALSE

\* What readOwner sees now.
OwnerNow == IF lockExists THEN lockOwner ELSE None
\* pidAlive is false: the planted local holder, or a process that has exited. R is on another computer: unknown.
DeadNow(o) == o = Dead \/ (o \in Procs /\ pc[o] = "exited")

Goto(p, where) == pc' = [pc EXCEPT ![p] = where]
Locals == <<seenOwner, seenTouched, seenStale, seenDead, confirmed>>
GVars == <<gown, gstalled>>
RVars == <<rpc, rg>>
XVars == <<stalls, qpc, guardBroken>>
Ext == <<rpc, rg, stalls, qpc, guardBroken>>

\* Where a loop restarts: the guarded code looks, then takes the guard.
LoopStart == IF GuardedAcq THEN "acq_peek" ELSE "acq_mkdir"

\* The live holder on this computer whose work a removal of the lock ends.
Victim == IF lockExists /\ lockOwner \in Procs /\ pc[lockOwner] = "cs" THEN {lockOwner} ELSE {}

\* ---- the guard: its token, the holder's check, the release -------------------

\* guardStillMine(): the guard folder holds this process's token and was not taken more than a third of 30 s ago.
Holds(p) == gown = p /\ ~gstalled
\* A process that took no guard (an old-code variant) has nothing to check.
Seen(p) == ctx[p] = "main" \/ Holds(p)
ChkVal(p) == IF Recheck = "gap" THEN Seen(p) ELSE TRUE
\* The verdict before a destructive call: now ("atomic"), the previous step's ("gap"), or none ("off").
Ok(p) == ctx[p] = "main" \/ Recheck = "off" \/ (IF Recheck = "gap" THEN chk[p] ELSE Holds(p))
\* unguard(): the folder is removed only while it holds the caller's token.
Unguard(p) == IF gown = p THEN gown' = None /\ gstalled' = FALSE ELSE UNCHANGED GVars
BackToMain(p) == ctx' = [ctx EXCEPT ![p] = "main"]

\* ---- acquire() --------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:716 acquire: existsSync(lock) first, so a waiter polling a held lock does not take the guard
AcqPeek(p) ==
    /\ pc[p] = "acq_peek"
    /\ Goto(p, IF lockExists THEN "j_owner" ELSE "acq_guard")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:627-646 acquire: tryGuard, mkdirSync(guard), then its token; EEXIST returns false (a stale guard is reclaimed by Q)
AcqGuardOk(p) ==
    /\ pc[p] = "acq_guard" /\ gown = None
    /\ gown' = p /\ UNCHANGED gstalled /\ ctx' = [ctx EXCEPT ![p] = "ac"] /\ Goto(p, "acq_mkdir")
    /\ chk' = [chk EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<lockExists, lockOwner, stale, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

AcqGuardBusy(p) ==
    /\ pc[p] = "acq_guard" /\ gown # None
    /\ Goto(p, "j_owner")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

AcqGuard(p) == AcqGuardOk(p) \/ AcqGuardBusy(p)

\* makeLock returned false: acquire's guard is let go as the false returns; a takeover's `finally` does it a step later.
AbortMake(p) ==
    IF ctx[p] = "tk"
    THEN /\ Goto(p, "tk_unguard_fail") /\ UNCHANGED <<GVars, ctx>>
    ELSE /\ Goto(p, "j_owner")
         /\ IF ctx[p] = "ac" THEN Unguard(p) /\ BackToMain(p) ELSE UNCHANGED <<GVars, ctx>>

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:693-701 makeLock: the guard check, then mkdirSync(lock); EEXIST returns false
AcqMkdir(p) ==
    /\ pc[p] = "acq_mkdir"
    /\ IF ~Ok(p)
       THEN /\ UNCHANGED <<lockExists, lockOwner, stale, chk>> /\ AbortMake(p)
       ELSE IF ~lockExists
            THEN /\ lockExists' = TRUE /\ lockOwner' = None /\ stale' = FALSE /\ Goto(p, "acq_write")
                 /\ chk' = [chk EXCEPT ![p] = ChkVal(p)] /\ UNCHANGED <<GVars, ctx>>
            ELSE /\ UNCHANGED <<lockExists, lockOwner, stale, chk>> /\ AbortMake(p)
    /\ UNCHANGED <<tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:704-711 makeLock: the guard check, then writeFileSync(owner.json) into whatever folder is there now
AcqWrite(p) ==
    /\ pc[p] = "acq_write"
    /\ IF ~Ok(p)
       THEN \* stalled since the mkdir: the folder is left as it is (ownerless, abandoned after staleMs)
            /\ UNCHANGED <<lockExists, lockOwner, stale>> /\ AbortMake(p)
       ELSE IF lockExists
            THEN /\ lockOwner' = p /\ stale' = FALSE
                 /\ Goto(p, IF ctx[p] = "main" THEN "cs" ELSE "tk_unguard_ok")
                 /\ UNCHANGED <<lockExists, GVars, ctx>>
            ELSE /\ UNCHANGED <<lockOwner, stale>> /\ Goto(p, "fail_rm") /\ UNCHANGED <<lockExists, GVars, ctx>>
    /\ UNCHANGED <<chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:707-710 the write failed (ENOENT): rmSync(lock) only while the guard is still held, then throw
FailRm(p) ==
    /\ pc[p] = "fail_rm"
    /\ IF Ok(p)
       THEN lockExists' = FALSE /\ lockOwner' = None /\ tookOver' = tookOver \cup Victim
       ELSE UNCHANGED <<lockExists, lockOwner, tookOver>>
    /\ UNCHANGED stale
    /\ Goto(p, IF ctx[p] = "main" THEN "failed" ELSE "fail_unguard")
    /\ UNCHANGED <<GVars, ctx, chk>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:720-722 acquire: the error leaves makeLock, finally unguards (only a guard that still holds this token)
\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:759-762 takeOver: the error leaves it, finally unguards the same way
FailUnguard(p) ==
    /\ pc[p] = "fail_unguard"
    /\ Unguard(p) /\ BackToMain(p) /\ Goto(p, "failed")
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* ---- judge() ----------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:735 judge: readOwner(owner.json)
JOwner(p) ==
    /\ pc[p] = "j_owner"
    /\ seenOwner' = [seenOwner EXCEPT ![p] = OwnerNow]
    /\ Goto(p, "j_touch")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, seenTouched, seenStale, seenDead, confirmed, tookOver>>
    /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:736-738 judge: touched() stats owner.json, else the folder; null = gone; idle = now - mtime. Stale counts only for a holder that cannot be asked (another computer, no readable owner) unless LocalStale
JTouch(p) ==
    /\ pc[p] = "j_touch"
    /\ seenTouched' = [seenTouched EXCEPT ![p] = lockExists]
    /\ seenStale' = [seenStale EXCEPT ![p] = lockExists /\ stale /\ (LocalStale \/ seenOwner[p] \in {Remote, None})]
    /\ Goto(p, "j_alive")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, seenOwner, seenDead, confirmed, tookOver>>
    /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:739-740 judge: this computer's holder and !pidAlive(owner.pid) (kill 0)
JAlive(p) ==
    /\ pc[p] = "j_alive"
    /\ seenDead' = [seenDead EXCEPT ![p] = DeadNow(seenOwner[p])]
    /\ Goto(p, "j_confirm")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, seenOwner, seenTouched, seenStale, confirmed, tookOver>>
    /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:741-742 judge: the owner read again must be the same record (pid, start, token); a change cancels both reasons
JConfirm(p) ==
    /\ pc[p] = "j_confirm"
    /\ confirmed' = [confirmed EXCEPT ![p] = TrustFirstRead \/ OwnerNow = seenOwner[p]]
    /\ Goto(p, "j_decide")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, seenOwner, seenTouched, seenStale, seenDead, tookOver>>
    /\ UNCHANGED Ext

Abandoned(p) ==
    IF GoneIsAbandoned
    THEN (seenDead[p] /\ confirmed[p]) \/ ~seenTouched[p]
    ELSE seenTouched[p] /\ IF IdentityOnStale
                           THEN confirmed[p] /\ (seenDead[p] \/ seenStale[p])
                           ELSE (seenDead[p] /\ confirmed[p]) \/ seenStale[p]

\* What takeOver checks for "no lock": the code before the first fix asked existsSync now, the fix uses judge's own stat.
TakeoverSeesNoLock(p) == IF GoneIsAbandoned THEN ~lockExists ELSE ~seenTouched[p]

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:743 judge: abandoned = dead || (not this computer's && idle > staleMs), after the identity check
\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:775-777 main loop: an abandoned lock goes to takeOver, else poll
\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:750-753 takeOver, inside the guard: gone -> makeLock, not abandoned -> give up, else the guard check ("gap": taken here)
JDecide(p) ==
    /\ pc[p] = "j_decide"
    /\ IF ctx[p] = "main"
       THEN Goto(p, IF Abandoned(p) THEN "tk_guard" ELSE LoopStart)
       ELSE Goto(p, IF TakeoverSeesNoLock(p) THEN "acq_mkdir"
                    ELSE IF ~Abandoned(p) THEN "tk_unguard_fail"
                    ELSE "tk_rm")
    /\ chk' = [chk EXCEPT ![p] = ChkVal(p)]
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* ---- takeOver() -------------------------------------------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:746 takeOver: tryGuard, mkdirSync(guard) and its token; EEXIST returns false (a stale guard is reclaimed by Q)
TkGuardOk(p) ==
    /\ pc[p] = "tk_guard" /\ gown = None
    /\ gown' = p /\ UNCHANGED gstalled /\ ctx' = [ctx EXCEPT ![p] = "tk"] /\ Goto(p, "j_owner")
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

TkGuardBusy(p) ==
    /\ pc[p] = "tk_guard" /\ gown # None
    /\ Goto(p, LoopStart)
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

TkGuard(p) == TkGuardOk(p) \/ TkGuardBusy(p)

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:753-757 takeOver: the guard check, then rmSync(lock) of the lock judged abandoned ("atomic": the check is this step; "gap": it was JDecide's)
TkRm(p) ==
    /\ pc[p] = "tk_rm"
    /\ IF Ok(p)
       THEN /\ lockExists' = FALSE /\ lockOwner' = None /\ tookOver' = tookOver \cup Victim
            /\ Goto(p, "acq_mkdir") /\ chk' = [chk EXCEPT ![p] = ChkVal(p)]
       ELSE /\ UNCHANGED <<lockExists, lockOwner, tookOver, chk>> /\ Goto(p, "tk_unguard_fail")
    /\ UNCHANGED stale
    /\ UNCHANGED <<GVars, ctx>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:758-762 makeLock returned true; finally removes the guard (acquire: the same)
TkUnguardOk(p) ==
    /\ pc[p] = "tk_unguard_ok"
    /\ Unguard(p) /\ BackToMain(p) /\ Goto(p, "cs")
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:761-762 takeOver returned false; finally removes the guard, the loop polls again
TkUnguardFail(p) ==
    /\ pc[p] = "tk_unguard_fail"
    /\ Unguard(p) /\ BackToMain(p) /\ Goto(p, LoopStart)
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* ---- the work, the sleeping holder and release() ----------------------------

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:823 the critical section: work(signal)
Work(p) ==
    /\ pc[p] = "cs" /\ Goto(p, IF GuardedRel THEN "rl_guard" ELSE "rel_mine")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* Environment (this computer sleeps): a live holder on this computer stops touching its lock for longer than staleMs.
\* Also a process between mkdir and the owner write, whose folder then looks abandoned.
Sleep(p) ==
    /\ \/ /\ Freeze /\ pc[p] = "cs" /\ lockExists /\ lockOwner = p
       \/ /\ SleepMake /\ pc[p] = "acq_write" /\ lockExists /\ lockOwner = None
    /\ stale' = TRUE
    /\ UNCHANGED <<lockExists, lockOwner, GVars, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:666-672 releaseLock: underGuardSync takes the guard (blocking spin, a few ms)
RlGuard(p) ==
    /\ pc[p] = "rl_guard" /\ gown = None
    /\ gown' = p /\ UNCHANGED gstalled /\ ctx' = [ctx EXCEPT ![p] = "rl"] /\ Goto(p, "rel_mine")
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:683 releaseLock: mine() reads owner.json and compares pid, host, token
RelMine(p) ==
    /\ pc[p] = "rel_mine"
    /\ Goto(p, IF OwnerNow = p THEN "rel_rm" ELSE "rel_end")
    /\ chk' = [chk EXCEPT ![p] = ChkVal(p)]
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:684-685 releaseLock: the guard check, then rmSync(lock); a lost guard sends the release round again
RelRm(p) ==
    /\ pc[p] = "rel_rm"
    /\ IF Ok(p)
       THEN /\ lockExists' = FALSE /\ lockOwner' = None /\ tookOver' = tookOver \cup Victim /\ Goto(p, "rel_end")
       ELSE /\ UNCHANGED <<lockExists, lockOwner, tookOver>> /\ Goto(p, "rel_lost")
    /\ UNCHANGED stale
    /\ UNCHANGED <<GVars, ctx, chk>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:680-690 releaseLock: the guard was lost: unguard (identity) and try again (3 times in the code; unbounded here)
RelLost(p) ==
    /\ pc[p] = "rel_lost"
    /\ Unguard(p) /\ BackToMain(p) /\ Goto(p, "rl_guard")
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:673-677 underGuardSync: the guard is removed as the body returns (only while it holds this token)
RelEnd(p) ==
    /\ pc[p] = "rel_end"
    /\ IF ctx[p] = "rl" THEN Unguard(p) /\ BackToMain(p) ELSE UNCHANGED <<GVars, ctx>>
    /\ Goto(p, "done")
    /\ UNCHANGED <<lockExists, lockOwner, stale, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* Environment, not code: the process exits after withLock returned or threw; from now on kill(pid, 0) fails.
Exit(p) ==
    /\ pc[p] = "done" /\ Goto(p, "exited")
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* ---- the holder on another computer (environment) ---------------------------

\* R's computer wakes and R finishes: its release (the same code, running over there). Before the guard existed it
\* read the owner and removed the folder in two steps.
ROut ==
    /\ rpc = "asleep" /\ rpc' = (IF GuardedRel THEN "r_guard" ELSE "r_mine") /\ UNCHANGED rg
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED XVars

RGuard ==
    /\ rpc = "r_guard" /\ gown = None
    /\ gown' = Remote /\ UNCHANGED gstalled /\ rg' = TRUE /\ rpc' = "r_mine"
    /\ UNCHANGED <<lockExists, lockOwner, stale, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED XVars

RMine ==
    /\ rpc = "r_mine"
    /\ rpc' = (IF OwnerNow = Remote THEN "r_rm" ELSE "r_end") /\ UNCHANGED rg
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED XVars

\* R checks its guard as the code does (always "atomic" here); without a guard (old code) there is nothing to check.
ROk == ~rg \/ Recheck = "off" \/ (gown = Remote /\ ~gstalled)

RRm ==
    /\ rpc = "r_rm"
    /\ IF ROk THEN lockExists' = FALSE /\ lockOwner' = None ELSE UNCHANGED <<lockExists, lockOwner>>
    /\ rpc' = "r_end" /\ UNCHANGED <<rg, stale, tookOver>>
    /\ UNCHANGED <<GVars, pc, ctx, chk>> /\ UNCHANGED Locals /\ UNCHANGED XVars

REnd ==
    /\ rpc = "r_end"
    /\ IF rg THEN (IF gown = Remote THEN gown' = None /\ gstalled' = FALSE ELSE UNCHANGED GVars) /\ rg' = FALSE
             ELSE UNCHANGED <<GVars, rg>>
    /\ rpc' = "gone"
    /\ UNCHANGED <<lockExists, lockOwner, stale, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED XVars

RStep == ROut \/ RGuard \/ RMine \/ RRm \/ REnd

\* ---- stalls and the guard reclaimer (environment) ---------------------------

\* The holder of the guard stalls (its computer sleeps, the process is stopped) for more than 30 s. From now on the
\* guard is stale: its holder's own checks fail, and a reclaimer may remove it.
Stall ==
    /\ stalls < Stalls /\ gown # None /\ ~gstalled
    /\ gstalled' = TRUE /\ stalls' = stalls + 1
    /\ UNCHANGED <<lockExists, lockOwner, stale, gown, pc, ctx, chk, tookOver, qpc, guardBroken>>
    /\ UNCHANGED Locals /\ UNCHANGED RVars

\* Time passes over a folder that was left without an owner (a holder that stalled between mkdir and the owner write
\* gave its step up): after staleMs it is abandoned.
AgeUp ==
    /\ Stalls > 0 /\ lockExists /\ lockOwner = None /\ ~stale
    /\ stale' = TRUE
    /\ UNCHANGED <<lockExists, lockOwner, GVars, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals /\ UNCHANGED Ext

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:613-620 reclaimStaleGuard: token read, then stat: a guard older than 30 s is judged stale
QJudge ==
    /\ Reclaim # "none" /\ qpc = "q_idle" /\ gown # None /\ gstalled
    /\ qpc' = "q_judged"
    /\ UNCHANGED <<lockExists, lockOwner, stale, GVars, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals
    /\ UNCHANGED <<rpc, rg, stalls, guardBroken>>

\* @code resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/toolchain.ts:586-611 takeGuardAside: by identity the exact folder judged is moved aside, its token compared, and it is deleted (a guard that is not the one judged is put back: the window of those calls is not modeled); "name" deletes whatever guard the name holds by now
QReclaim ==
    /\ qpc = "q_judged"
    /\ qpc' = "q_done"
    /\ IF Reclaim = "name"
       THEN IF gown # None
            THEN /\ gown' = None /\ gstalled' = FALSE /\ guardBroken' = (guardBroken \/ ~gstalled)
            ELSE UNCHANGED <<GVars, guardBroken>>
       ELSE /\ IF gown # None /\ gstalled THEN gown' = None /\ gstalled' = FALSE ELSE UNCHANGED GVars
            /\ UNCHANGED guardBroken
    /\ UNCHANGED <<lockExists, lockOwner, stale, pc, ctx, chk, tookOver>> /\ UNCHANGED Locals
    /\ UNCHANGED <<rpc, rg, stalls>>

Step(p) ==
    \/ AcqPeek(p) \/ AcqGuard(p) \/ AcqMkdir(p) \/ AcqWrite(p) \/ FailRm(p) \/ FailUnguard(p)
    \/ JOwner(p) \/ JTouch(p) \/ JAlive(p) \/ JConfirm(p) \/ JDecide(p)
    \/ TkGuard(p) \/ TkRm(p) \/ TkUnguardOk(p) \/ TkUnguardFail(p)
    \/ Work(p) \/ RlGuard(p) \/ RelMine(p) \/ RelRm(p) \/ RelLost(p) \/ RelEnd(p) \/ Exit(p)

\* Sleeping is an environment step, outside weak fairness: a holder may sleep, never has to.
Finished == /\ \A p \in Procs : pc[p] \in {"exited", "failed"}
            /\ rpc \in {"asleep", "gone"}
Next == (\E p \in Procs : Step(p) \/ Sleep(p)) \/ RStep \/ Stall \/ AgeUp \/ QJudge \/ QReclaim \/ (Finished /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars /\ \A p \in Procs : WF_vars(Step(p)) /\ SF_vars(RlGuard(p))
        /\ WF_vars(RStep) /\ SF_vars(RGuard) /\ WF_vars(AgeUp)

\* ==== FROZEN PROPERTIES (Properties.md) ====================================
\* P1: at most one process runs the work at a time.
MutualExclusion == Cardinality({p \in Procs : pc[p] = "cs"}) <= 1
\* P2: no waiter fails because another removed the folder it was writing into.
NoFailure == \A p \in Procs : pc[p] # "failed"
\* P3: every waiter gets the lock once and finishes.
Termination == <>(\A p \in Procs : pc[p] = "exited")
\* P4: a live holder on this computer never loses its lock to a takeover, however long it slept.
LiveHolderKept == tookOver = {}
\* P5: nobody removes a guard whose holder has not stalled (a guard that is stale for 30 s may be reclaimed, no other).
GuardKept == ~guardBroken
\* ==== END FROZEN PROPERTIES ================================================

\* Sanity (must FAIL): somebody does get the lock.
NeverHeld == \A p \in Procs : pc[p] # "cs"
=============================================================================
