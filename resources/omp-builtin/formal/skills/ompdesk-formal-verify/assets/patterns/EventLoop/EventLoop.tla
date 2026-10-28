\* Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.
---------------------------- MODULE EventLoop -----------------------------
(* Pattern: a single-threaded event loop (JavaScript, Python asyncio).        *)
(* Code shape:  a handler reads state, awaits something, then writes state.   *)
(*  - A macrotask (event handler, timer, a resume after real I/O) starts only *)
(*    when the loop is idle: `busy = FALSE`.                                  *)
(*  - A synchronous region plus every await that only waits on a microtask    *)
(*    (an already-resolved promise, a promise a handler resolves in the same  *)
(*    turn) is ONE loop turn: nobody else runs inside it. It is still modeled *)
(*    as several pc micro-steps, so an invariant can be checked after each    *)
(*    one, and the only states where it must hold are the ones at rest.       *)
(*  - An await that really yields (I/O, setTimeout, a message from another    *)
(*    process) ends the turn: other macrotasks run before the resume.         *)
(* AwaitYields = FALSE models the already-resolved await (must pass);         *)
(* TRUE models the real yield (the lost update).                              *)
EXTENDS Naturals, FiniteSets

CONSTANTS Tasks,       \* set of model values, e.g. {t1, t2}
          AwaitYields  \* BOOLEAN: does the await between the read and the write end the loop turn?

VARIABLES counter, ledger, snap, pc, busy
vars == <<counter, ledger, snap, pc, busy>>

TypeOK ==
    /\ counter \in 0..Cardinality(Tasks)
    /\ ledger \in 0..Cardinality(Tasks)
    /\ snap \in [Tasks -> 0..Cardinality(Tasks)]
    /\ pc \in [Tasks -> {"new", "awaiting", "parked", "write", "ledger", "done"}]
    /\ busy \in BOOLEAN

Init ==
    /\ counter = 0
    /\ ledger = 0
    /\ snap = [t \in Tasks |-> 0]
    /\ pc = [t \in Tasks |-> "new"]
    /\ busy = FALSE

\* @code app/loop.ts:20-22 handler start (a macrotask): const seen = state.counter
Start(t) ==
    /\ pc[t] = "new"
    /\ ~busy
    /\ snap' = [snap EXCEPT ![t] = counter]
    /\ pc' = [pc EXCEPT ![t] = "awaiting"]
    /\ busy' = TRUE
    /\ UNCHANGED <<counter, ledger>>

\* @code app/loop.ts:23 await resolvedPromise: microtask only, the same loop turn continues
AwaitMicro(t) ==
    /\ pc[t] = "awaiting"
    /\ ~AwaitYields
    /\ pc' = [pc EXCEPT ![t] = "write"]
    /\ UNCHANGED <<counter, ledger, snap, busy>>

\* @code app/loop.ts:23 await fetchRemote(): the turn ends, other macrotasks may run
AwaitYield(t) ==
    /\ pc[t] = "awaiting"
    /\ AwaitYields
    /\ pc' = [pc EXCEPT ![t] = "parked"]
    /\ busy' = FALSE
    /\ UNCHANGED <<counter, ledger, snap>>

\* @code app/loop.ts:23 resume after the real I/O (a macrotask again)
Resume(t) ==
    /\ pc[t] = "parked"
    /\ ~busy
    /\ pc' = [pc EXCEPT ![t] = "write"]
    /\ busy' = TRUE
    /\ UNCHANGED <<counter, ledger, snap>>

\* @code app/loop.ts:24 state.counter = seen + 1   (first half of the synchronous tail)
WriteCounter(t) ==
    /\ pc[t] = "write"
    /\ counter' = snap[t] + 1
    /\ pc' = [pc EXCEPT ![t] = "ledger"]
    /\ UNCHANGED <<ledger, snap, busy>>

\* @code app/loop.ts:25 state.ledger = state.counter   (second half; the turn ends here)
WriteLedger(t) ==
    /\ pc[t] = "ledger"
    /\ ledger' = counter
    /\ pc' = [pc EXCEPT ![t] = "done"]
    /\ busy' = FALSE
    /\ UNCHANGED <<counter, snap>>

Step == \E t \in Tasks :
    Start(t) \/ AwaitMicro(t) \/ AwaitYield(t) \/ Resume(t) \/ WriteCounter(t) \/ WriteLedger(t)

\* Explicit termination so TLC's deadlock check stays on for real stuck states.
Terminated == (\A t \in Tasks : pc[t] = "done") /\ UNCHANGED vars

Next == Step \/ Terminated
Spec == Init /\ [][Next]_vars /\ WF_vars(Step)

----------------------------------------------------------------------------
NoLostUpdate == (\A t \in Tasks : pc[t] = "done") => counter = Cardinality(Tasks)

\* The pair (counter, ledger) is torn between WriteCounter and WriteLedger. That is fine inside a loop turn and wrong
\* at rest, where the next macrotask would read it: check it only when the loop is idle.
AtRestConsistent == ~busy => ledger = counter

AllFinish == <>(\A t \in Tasks : pc[t] = "done")

\* Sanity (must FAIL): proves the all-done state is reachable, so NoLostUpdate is not vacuous.
NeverAllDone == ~(\A t \in Tasks : pc[t] = "done")
=============================================================================
