------------------------------ MODULE JobLease ------------------------------
(* Adapted from opum-ai/proof-skills (MIT, Opum AI), pattern JobLease.       *)
(* Code: src/worker.ts runJob. Workers claim one job row with a lease and a  *)
(* fencing token, work, then commit. A lease can expire while its holder     *)
(* still works (a GC pause, a slow call), and another worker then reclaims.  *)
(* UseFencing = TRUE is the code as written: commit is a compare-and-set on  *)
(* the claim token. FALSE models the version without the token check.        *)
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, UseFencing, MaxClaims
None == "none"
VARIABLES owner, token, expired, jobDone, wpc, wtok, commits
vars == <<owner, token, expired, jobDone, wpc, wtok, commits>>

TypeOK ==
    /\ owner \in Workers \cup {None}
    /\ token \in 0..MaxClaims
    /\ expired \in BOOLEAN
    /\ jobDone \in BOOLEAN
    /\ wpc \in [Workers -> {"idle", "working", "done", "aborted"}]
    /\ wtok \in [Workers -> 0..MaxClaims]
    /\ commits \subseteq Workers

Init ==
    /\ owner = None /\ token = 0 /\ expired = FALSE /\ jobDone = FALSE
    /\ wpc = [w \in Workers |-> "idle"] /\ wtok = [w \in Workers |-> 0]
    /\ commits = {}

\* @code src/worker.ts:12-13 db.claim: one atomic UPDATE that takes a free or expired job and bumps the token
Claim(w) ==
    /\ wpc[w] = "idle" /\ ~jobDone /\ token < MaxClaims
    /\ (owner = None \/ expired)
    /\ owner' = w /\ token' = token + 1 /\ expired' = FALSE
    /\ wtok' = [wtok EXCEPT ![w] = token + 1]
    /\ wpc' = [wpc EXCEPT ![w] = "working"]
    /\ UNCHANGED <<jobDone, commits>>

\* Environment, not code: time passes or the holder pauses past lease_until, at any moment.
Expire ==
    /\ owner # None /\ ~expired /\ ~jobDone
    /\ expired' = TRUE
    /\ UNCHANGED <<owner, token, jobDone, wpc, wtok, commits>>

\* @code src/worker.ts:17-19 db.commit changed one row: the token still matched, the job is done
Commit(w) ==
    /\ wpc[w] = "working"
    /\ UseFencing => wtok[w] = token
    /\ commits' = commits \cup {w} /\ jobDone' = TRUE
    /\ wpc' = [wpc EXCEPT ![w] = "done"]
    /\ UNCHANGED <<owner, token, expired, wtok>>

\* @code src/worker.ts:17-18 db.commit changed no row: another worker took the lease, outcome "lost"
Abort(w) ==
    /\ wpc[w] = "working" /\ UseFencing /\ wtok[w] # token
    /\ wpc' = [wpc EXCEPT ![w] = "aborted"]
    /\ UNCHANGED <<owner, token, expired, jobDone, wtok, commits>>

Step == Expire \/ \E w \in Workers : Claim(w) \/ Commit(w) \/ Abort(w)
Next == Step \/ (jobDone /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars /\ \A w \in Workers : WF_vars(Commit(w)) /\ WF_vars(Abort(w))

----------------------------------------------------------------------------
\* Safety: the job is committed by at most one worker.
SingleCommit == Cardinality(commits) <= 1
\* Liveness: once someone holds a valid claim, the job gets done.
ClaimedEventuallyDone == (owner # None) ~> jobDone

\* Sanity (must FAIL): a reclaim after an expiry is reachable.
NoReclaim == token <= 1
=============================================================================
