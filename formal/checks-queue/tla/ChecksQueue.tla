---------------------------- MODULE ChecksQueue ----------------------------
(*
 * OMPdesk's own merge queue for one base branch of one repository (lane `land`, check control P3):
 * native/ompdesk/crates/core/src/checks/queue.rs.
 *
 * Branches wait in a line. The queue takes a batch (the oldest waiting entry and the later ones of its goal), builds
 * the batch once on top of the base tip it last read, and has the check run on exactly that commit. Green: the base
 * is fast-forwarded to that commit. Red: the queue bisects over prefixes of the batch, lands every prefix it saw
 * green, and fails the entry whose addition turned a green prefix red. What it learned is kept per base tip and
 * entries (`memo`), so a combination already known red is never built again.
 *
 * A commit is modeled as its content: the sequence of what is on it (landed entries and other people's pushes).
 * Building `entries` on `tip` is `tip \o entries`; a push is a fast-forward exactly when the base is a prefix of it.
 *
 * What runs beside the queue: the check's result arrives later, also for a trial the queue dropped meanwhile; anyone
 * may push to the base at any time (a person, an agent, another computer's queue); an entry may be withdrawn at any
 * time; the push and the queue learning how it went are two steps (a crash between them is the same order).
 *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    N,           \* entries 1..N, numbered in arrival order
    Goal,        \* entry -> the goal its branch works for (a batch is of one goal)
    BatchSize,   \* at most this many entries in a batch
    MaxMoves,    \* other people's pushes to the base (bound)
    MaxRemoves   \* withdrawals (bound)

Entries == 1..N

GoalsAlternate == [e \in Entries |-> e % 2]
GoalsSame == [e \in Entries |-> 0]

VARIABLES
    bad,       \* the truth the queue does not know: entries whose change fails the check
    main,      \* the base branch on the remote: what is on it, oldest first
    st,        \* entry -> "out" | "waiting" | "flight" | "landed" | "failed" | "removed"
    line,      \* the waiting entries, oldest first
    flight,    \* the batch being worked on, in order
    tip,       \* the base tip the queue last read
    memo,      \* what the queue knows: <<tip, entries, "green" | "red">>
    trial,     \* what the queue waits for: [stage: "idle" | "test" | "land", len: prefix of the flight, commit]
    runs,      \* commits a check run is under way for (also of trials dropped since)
    moves,     \* other people's pushes so far (bound)
    removes,   \* withdrawals so far (bound)
    ciGreen,   \* ghost: commits the check reported green
    ciRed,     \* ghost: commits the check reported red
    pushed,    \* ghost: commits the queue pushed to the base
    failedOn   \* ghost: for each entry the queue failed, the commit it held red

vars == <<bad, main, st, line, flight, tip, memo, trial, runs, moves, removes, ciGreen, ciRed, pushed, failedOn>>

Range(s) == {s[i] : i \in 1..Len(s)}
Least(a, b) == IF a < b THEN a ELSE b
MaxOf(S) == CHOOSE x \in S : \A y \in S : y <= x
MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y
Prefix(s, k) == SubSeq(s, 1, Least(k, Len(s)))
After(s, k) == SubSeq(s, Least(k, Len(s)) + 1, Len(s))
IsPrefix(s, t) == Len(s) <= Len(t) /\ SubSeq(t, 1, Len(s)) = s
Without(s, e) == SelectSeq(s, LAMBDA x : x # e)
Index(s, e) == CHOOSE i \in 1..Len(s) : s[i] = e

Idle == [stage |-> "idle", len |-> 0, commit |-> <<>>]

\* The check itself: red exactly when the commit holds a bad entry.
Passes(c) == Range(c) \cap bad = {}

Init ==
    /\ bad \in SUBSET Entries
    /\ main = <<>>
    /\ st = [e \in Entries |-> "out"]
    /\ line = <<>>
    /\ flight = <<>>
    /\ tip = <<>>
    /\ memo = {}
    /\ trial = Idle
    /\ runs = {}
    /\ moves = 0
    /\ removes = 0
    /\ ciGreen = {}
    /\ ciRed = {}
    /\ pushed = {}
    /\ failedOn = {}

\* A branch joins the line.
\* @code native/ompdesk/crates/core/src/checks/queue.rs:451-483 LandQueue::enqueue a branch joins the line
Enqueue(e) ==
    /\ st[e] = "out"
    /\ \A d \in 1..(e - 1) : st[d] # "out"
    /\ st' = [st EXCEPT ![e] = "waiting"]
    /\ line' = Append(line, e)
    /\ UNCHANGED <<bad, main, flight, tip, memo, trial, runs, moves, removes, ciGreen, ciRed, pushed, failedOn>>

\* The entries the queue is pushing to the base right now: too late to withdraw.
Landing(e) == trial.stage = "land" /\ Index(flight, e) <= trial.len

\* A branch is withdrawn. Out of the flight it ends the trial only when the trial's commit holds it.
\* @code native/ompdesk/crates/core/src/checks/queue.rs:486-498 LandQueue::remove
\* @code native/ompdesk/crates/core/src/checks/queue.rs:438-447 LandQueue::leave_flight refused while landing; drops the trial that holds the entry
Remove(e) ==
    /\ removes < MaxRemoves
    /\ removes' = removes + 1
    /\ \/ /\ st[e] = "waiting"
          /\ line' = Without(line, e)
          /\ UNCHANGED <<flight, trial>>
       \/ /\ st[e] = "flight"
          /\ ~Landing(e)
          /\ flight' = Without(flight, e)
          /\ trial' = IF trial.stage = "test" /\ Index(flight, e) <= trial.len THEN Idle ELSE trial
          /\ UNCHANGED line
    /\ st' = [st EXCEPT ![e] = "removed"]
    /\ UNCHANGED <<bad, main, tip, memo, runs, moves, ciGreen, ciRed, pushed, failedOn>>

\* The next batch: the oldest waiting entry and the later ones of its goal, oldest first. (When: abstracted, any time.)
\* @code native/ompdesk/crates/core/src/checks/queue.rs:332-354 LandQueue::form
Form ==
    /\ flight = <<>>
    /\ trial.stage = "idle"
    /\ line # <<>>
    /\ LET group == SelectSeq(line, LAMBDA x : Goal[x] = Goal[Head(line)])
           take == Prefix(group, BatchSize)
       IN  /\ flight' = take
           /\ line' = SelectSeq(line, LAMBDA x : x \notin Range(take))
           /\ st' = [e \in Entries |-> IF e \in Range(take) THEN "flight" ELSE st[e]]
    /\ UNCHANGED <<bad, main, tip, memo, trial, runs, moves, removes, ciGreen, ciRed, pushed, failedOn>>

Known(k, v) == <<tip, Prefix(flight, k), v>> \in memo

\* What the queue does next with its flight, from what it knows: land the longest prefix known green; else fail the
\* first entry when it alone is known red; else test the whole flight, or the middle of the shortest prefix known red.
\* @code native/ompdesk/crates/core/src/checks/queue.rs:358-383 LandQueue::next what is known decides: land, fail or test
\* @code native/ompdesk/crates/core/src/checks/queue.rs:386-435 LandQueue::advance
Step ==
    /\ trial.stage = "idle"
    /\ flight # <<>>
    /\ LET n == Len(flight)
           r == MinOf({n + 1} \cup {k \in 1..n : Known(k, "red")})
           g == MaxOf({0} \cup {k \in 1..n : Known(k, "green")})
       IN  IF g >= 1
           THEN /\ trial' = [stage |-> "land", len |-> g, commit |-> tip \o Prefix(flight, g)]
                /\ UNCHANGED <<st, flight, runs, failedOn>>
           ELSE IF r = 1
           THEN /\ st' = [st EXCEPT ![flight[1]] = "failed"]
                /\ failedOn' = failedOn \cup {tip \o <<flight[1]>>}
                /\ flight' = Tail(flight)
                /\ UNCHANGED <<trial, runs>>
           ELSE LET k == IF r = n + 1 THEN n ELSE r \div 2
                    c == tip \o Prefix(flight, k)
                IN  /\ trial' = [stage |-> "test", len |-> k, commit |-> c]
                    /\ runs' = runs \cup {c}
                    /\ UNCHANGED <<st, flight, failedOn>>
    /\ UNCHANGED <<bad, main, line, tip, memo, moves, removes, ciGreen, ciRed, pushed>>

\* A check run ends. The queue takes its result only for the commit it is testing now.
\* @code native/ompdesk/crates/core/src/checks/queue.rs:566-598 LandQueue::verdict taken only for the commit under test
RunDone(c) ==
    /\ c \in runs
    /\ runs' = runs \ {c}
    /\ ciGreen' = IF Passes(c) THEN ciGreen \cup {c} ELSE ciGreen
    /\ ciRed' = IF Passes(c) THEN ciRed ELSE ciRed \cup {c}
    /\ IF trial.stage = "test" /\ trial.commit = c
       THEN /\ memo' = memo \cup {<<tip, Prefix(flight, trial.len), IF Passes(c) THEN "green" ELSE "red">>}
            /\ trial' = Idle
       ELSE UNCHANGED <<memo, trial>>
    /\ UNCHANGED <<bad, main, st, line, flight, tip, moves, removes, pushed, failedOn>>

\* The push of the tested commit to the base: git takes it only as a fast-forward, in one step.
Push ==
    /\ trial.stage = "land"
    /\ IsPrefix(main, trial.commit) /\ main # trial.commit
    /\ main' = trial.commit
    /\ pushed' = pushed \cup {trial.commit}
    /\ UNCHANGED <<bad, st, line, flight, tip, memo, trial, runs, moves, removes, ciGreen, ciRed, failedOn>>

\* The queue reads that the base holds the commit: its entries have landed. What it knew about longer combinations
\* stays true on the new tip only when the base is exactly that commit.
\* @code native/ompdesk/crates/core/src/checks/queue.rs:625-661 LandQueue::landed
Landed ==
    /\ trial.stage = "land" /\ IsPrefix(trial.commit, main)
    /\ LET k == trial.len
           done == Prefix(flight, k)
       IN  /\ st' = [e \in Entries |-> IF e \in Range(done) THEN "landed" ELSE st[e]]
           /\ flight' = After(flight, k)
           /\ memo' = IF main = trial.commit
                      THEN {<<main, After(m[2], k), m[3]>> :
                                m \in {x \in memo : x[1] = tip /\ Len(x[2]) > k /\ Prefix(x[2], k) = done}}
                      ELSE {}
    /\ tip' = main
    /\ trial' = Idle
    /\ UNCHANGED <<bad, main, line, runs, moves, removes, ciGreen, ciRed, pushed, failedOn>>

\* The push was refused: the base moved on. Nothing the queue knew holds on the new tip.
\* @code native/ompdesk/crates/core/src/checks/queue.rs:664-673 LandQueue::moved
Moved ==
    /\ trial.stage = "land"
    /\ ~IsPrefix(main, trial.commit)
    /\ ~IsPrefix(trial.commit, main)
    /\ trial' = Idle
    /\ memo' = {}
    /\ tip' = main
    /\ UNCHANGED <<bad, main, st, line, flight, runs, moves, removes, ciGreen, ciRed, pushed, failedOn>>

\* The queue reads a base tip it did not know (not while it pushes: that push's own answer decides).
\* @code native/ompdesk/crates/core/src/checks/queue.rs:694-704 LandQueue::base_read
SeeBase ==
    /\ tip # main
    /\ trial.stage # "land"
    /\ tip' = main
    /\ memo' = {}
    /\ trial' = Idle
    /\ UNCHANGED <<bad, main, st, line, flight, runs, moves, removes, ciGreen, ciRed, pushed, failedOn>>

\* Someone else pushes to the base.
OutsidePush ==
    /\ moves < MaxMoves
    /\ moves' = moves + 1
    /\ main' = Append(main, N + 1 + moves)
    /\ UNCHANGED <<bad, st, line, flight, tip, memo, trial, runs, removes, ciGreen, ciRed, pushed, failedOn>>

QueueNext == Form \/ Step \/ (\E c \in runs : RunDone(c)) \/ Push \/ Landed \/ Moved \/ SeeBase

Next == QueueNext \/ (\E e \in Entries : Enqueue(e) \/ Remove(e)) \/ OutsidePush

Spec == Init /\ [][Next]_vars

FairSpec == Spec /\ WF_vars(QueueNext)

(* ---- BEGIN FROZEN PROPERTIES (formal/checks-queue/Properties.md) ---- *)

TypeOK ==
    /\ bad \subseteq Entries
    /\ main \in Seq(1..(N + MaxMoves))
    /\ st \in [Entries -> {"out", "waiting", "flight", "landed", "failed", "removed"}]
    /\ Range(line) = {e \in Entries : st[e] = "waiting"}
    /\ Range(flight) = {e \in Entries : st[e] = "flight"}
    /\ Len(flight) <= BatchSize
    /\ trial.stage \in {"idle", "test", "land"}
    /\ trial.stage # "idle" => trial.len \in 1..Len(flight) /\ trial.commit = tip \o Prefix(flight, trial.len)
    /\ trial.stage = "test" => trial.commit \in runs
    /\ \A m \in memo : m[3] \in {"green", "red"}
    /\ moves \in 0..MaxMoves
    /\ removes \in 0..MaxRemoves

\* The base only ever receives, from the queue, a commit the check reported green as exactly that commit.
OnlyTestedLands == pushed \subseteq ciGreen

\* An entry is failed only for a commit the check reported red: the tip it was failed on plus that entry alone.
OnlyTestedRedFails == failedOn \subseteq ciRed

\* With a truthful check, nothing that fails it reaches the base.
NoBadOnMain == Range(main) \cap bad = {}

\* Nothing lands twice.
LandsOnce == \A i, j \in 1..Len(main) : main[i] = main[j] => i = j

\* Entries of one goal land in the order they arrived.
LandInOrder ==
    \A i, j \in 1..Len(main) :
        (i < j /\ main[i] \in Entries /\ main[j] \in Entries /\ Goal[main[i]] = Goal[main[j]]) => main[i] < main[j]

\* An entry that was withdrawn or failed, or still waits, is not on the base.
WithdrawnNeverLands == \A e \in Entries : st[e] \in {"out", "waiting", "removed", "failed"} => e \notin Range(main)

\* An entry the queue calls landed is on the base.
LandedIsOnMain == \A e \in Entries : st[e] = "landed" => e \in Range(main)

\* The base is never rewritten: every change of it keeps what was on it.
NeverForced == [][IsPrefix(main, main')]_main

\* The queue never sits on work: once the world stops interfering, the line and the flight empty.
Drains == <>[](line = <<>> /\ flight = <<>>)

(* ---- END FROZEN PROPERTIES ---- *)

\* Sanity: each must be violated, or the model cannot do the thing it is about.
NeverLands == Range(main) \cap Entries = {}
NeverFails == \A e \in Entries : st[e] # "failed"
NeverBisects == ~(trial.stage = "test" /\ trial.len < Len(flight))
NeverLandsPart == ~(trial.stage = "land" /\ trial.len < Len(flight))
NeverTestsStale == ~(trial.stage = "test" /\ tip # main)

=============================================================================
