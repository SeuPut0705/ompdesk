--------------------------- MODULE SessionProcesses ---------------------------
(*
 * Which tags' processes OMPdesk ends, and when (src/main/session-processes.ts).
 *
 * Every tab's omp is spawned with the tab's tag in its environment; what it starts inherits the tag. The registry
 * keeps each tag in a file with the session it belongs to. A tab that closes has its tag's processes ended; a quit
 * ends nothing; the next launch ends the tags whose session did not come back, and a tab that comes back on a session
 * takes the tag the last launch left for it over.
 *
 * The core's `procs.end` is one request in flight (`inflight`): it kills every process of its tags whatever the
 * registry thinks of them by the time it runs, so a tag handed to a tab while its end is in flight would take the
 * tab's omp down.
 *)
EXTENDS Naturals, FiniteSets

CONSTANTS Sessions, Tags, MaxLaunches

None == "none"

VARIABLES
    app,       \* "up" | "down"
    quitting,  \* a quit was approved: tabs are torn down, nothing is ended
    swept,     \* this launch's sweep ran
    launches,  \* launches so far (bound)
    tab,       \* session -> "closed" | "asleep" (restored, omp not started) | "started"
    held,      \* session -> the tag its started tab holds, or None
    state,     \* tag -> "free" | "live" | "left" | "ending"  (the registry's entry; every non-free one is in the file)
    sess,      \* tag -> the session its entry names, or None
    used,      \* tags ever made (a tag is never made twice)
    saved,     \* the saved layout: sessions whose tab comes back at the next launch
    keep,      \* what this launch's sweep keeps (the layout it restored)
    inflight,  \* tags the core is ending right now
    alive,     \* tags some running process carries
    mayEnd,    \* ghost: tags whose tab was closed outside a quit, or whose session did not come back, not taken over since
    failed,    \* ghost: an end failed in this launch
    tookOver,  \* ghost: a tab took a left tag over
    retry      \* tags whose end left something running: tried once more later in this launch

vars == <<app, quitting, swept, launches, tab, held, state, sess, used, saved, keep, inflight, alive, mayEnd, failed, tookOver, retry>>

TypeOK ==
    /\ app \in {"up", "down"}
    /\ quitting \in BOOLEAN
    /\ swept \in BOOLEAN
    /\ launches \in 0 .. MaxLaunches
    /\ tab \in [Sessions -> {"closed", "asleep", "started"}]
    /\ held \in [Sessions -> Tags \cup {None}]
    /\ state \in [Tags -> {"free", "live", "left", "ending"}]
    /\ sess \in [Tags -> Sessions \cup {None}]
    /\ used \subseteq Tags
    /\ saved \subseteq Sessions
    /\ keep \subseteq Sessions
    /\ inflight \subseteq Tags
    /\ alive \subseteq Tags
    /\ mayEnd \subseteq Tags

Init ==
    /\ app = "up"
    /\ quitting = FALSE
    /\ swept = TRUE
    /\ launches = 1
    /\ tab = [s \in Sessions |-> "closed"]
    /\ held = [s \in Sessions |-> None]
    /\ state = [t \in Tags |-> "free"]
    /\ sess = [t \in Tags |-> None]
    /\ used = {}
    /\ saved = {}
    /\ keep = {}
    /\ inflight = {}
    /\ alive = {}
    /\ mayEnd = {}
    /\ failed = FALSE
    /\ tookOver = FALSE
    /\ retry = {}

Open == {s \in Sessions : tab[s] # "closed"}

\* The tags the last launch left for a session, not yet taken over.
\* @code src/main/session-processes.ts:325-331 #left: only an entry in state left
LeftOf(s) == {t \in Tags : state[t] = "left" /\ sess[t] = s}

\* A quit is underway: a tab's close ends nothing.
\* @code src/main/session-processes.ts:262-266 close: frozen
Frozen == quitting

\* What the launch's sweep ends: what the last launch left for a session that did not come back.
\* @code src/main/session-processes.ts:284-306 sweep
SweepTargets == {t \in Tags : state[t] = "left" /\ sess[t] \notin keep}

\* An end that failed, or that left something running, keeps its tag for the next launch.
\* @code src/main/session-processes.ts:345-364 #endEntry: a failed end, or one that left something, puts the entry back as left
AfterFailedEnd == "left"

\* The registry marks `tags` as ending and asks the core.
End(tags) ==
    /\ state' = [t \in Tags |-> IF t \in tags THEN "ending" ELSE state[t]]
    /\ inflight' = inflight \cup tags

\* A tab's first omp starts: it takes over a tag the last launch left for its session, else gets a new one.
\* @code src/main/session-processes.ts:233-244 open
Start(s) ==
    /\ app = "up" /\ ~quitting
    /\ tab[s] \in {"closed", "asleep"}
    /\ \/ /\ LeftOf(s) # {}
          /\ \E t \in LeftOf(s) :
                /\ state' = [state EXCEPT ![t] = "live"]
                /\ held' = [held EXCEPT ![s] = t]
                /\ mayEnd' = mayEnd \ {t}
          /\ tookOver' = TRUE
          /\ UNCHANGED <<sess, used>>
       \/ /\ LeftOf(s) = {}
          /\ \E t \in Tags \ used :
                /\ state' = [state EXCEPT ![t] = "live"]
                /\ sess' = [sess EXCEPT ![t] = s]
                /\ used' = used \cup {t}
                /\ held' = [held EXCEPT ![s] = t]
          /\ UNCHANGED <<mayEnd, tookOver>>
    /\ tab' = [tab EXCEPT ![s] = "started"]
    /\ UNCHANGED <<app, quitting, swept, launches, saved, keep, inflight, alive, failed, retry>>

\* The tab's omp, or anything under it, starts a process: it carries the tab's tag from then on.
Spawn(s) ==
    /\ app = "up"
    /\ tab[s] = "started"
    /\ alive' = alive \cup {held[s]}
    /\ UNCHANGED <<app, quitting, swept, launches, tab, held, state, sess, used, saved, keep, inflight, mayEnd, failed, tookOver, retry>>

\* A tab goes away: the person or an agent closes it, its window closes, or (while quitting) the quit tears it down.
\* Its own tag and what the last launch left for its session end, unless a quit is underway.
\* @code src/main/session-processes.ts:262-266 close
\* @code src/main/session-processes.ts:274-277 sessionReleased
\* @code native/ompdesk/crates/core/src/sidecar/lane.rs:2046-2053 Lane::dispose: stops the omp; the lane tells main once every omp it stopped has exited (`sidecar.disposed`)
\* @code native/ompdesk/crates/core/src/sidecar/lane.rs:2057-2069 Lane::when_all_exited: the close follows the omp's exit (main closes the tag on the event)
Dispose(s) ==
    /\ app = "up"
    /\ tab[s] # "closed"
    /\ LET tags == (IF tab[s] = "started" THEN {held[s]} ELSE {}) \cup LeftOf(s)
       IN IF Frozen
          THEN UNCHANGED <<state, inflight, mayEnd>>
          ELSE /\ End(tags)
               /\ mayEnd' = IF quitting THEN mayEnd ELSE mayEnd \cup tags
    /\ tab' = [tab EXCEPT ![s] = "closed"]
    /\ held' = [held EXCEPT ![s] = None]
    /\ UNCHANGED <<app, quitting, swept, launches, sess, used, saved, keep, alive, failed, tookOver, retry>>

\* The core ended every process of the tag and answered: the registry forgets the tag.
\* @code src/main/session-processes.ts:365-366 #endEntry: the entry goes once the core answered that nothing is left
EndOk(t) ==
    /\ app = "up"
    /\ t \in inflight
    /\ inflight' = inflight \ {t}
    /\ alive' = alive \ {t}
    /\ state' = [state EXCEPT ![t] = IF state[t] = "ending" THEN "free" ELSE state[t]]
    /\ UNCHANGED <<app, quitting, swept, launches, tab, held, sess, used, saved, keep, mayEnd, failed, tookOver, retry>>

\* The core could not answer (it is restarting, the request timed out), or answered that something still runs (stock's
\* worker and what it started, a process that survived the kill): the tag is not forgotten.
EndFail(t) ==
    /\ app = "up"
    /\ t \in inflight
    /\ inflight' = inflight \ {t}
    /\ state' = [state EXCEPT ![t] = IF state[t] = "ending" THEN AfterFailedEnd ELSE state[t]]
    /\ failed' = TRUE
    /\ \E again \in BOOLEAN : retry' = IF again THEN retry \cup {t} ELSE retry
    /\ UNCHANGED <<app, quitting, swept, launches, tab, held, sess, used, saved, keep, alive, mayEnd, tookOver>>

\* The retry's timer fires: the tag is ended again only if nothing took it over meanwhile.
\* @code src/main/session-processes.ts:358-363 #endEntry: the retry looks at the entry's state again
RetryEnds(t) == state[t] = "left"

Retry(t) ==
    /\ app = "up" /\ ~quitting
    /\ t \in retry
    /\ retry' = retry \ {t}
    /\ IF RetryEnds(t) THEN End({t}) ELSE UNCHANGED <<state, inflight>>
    /\ UNCHANGED <<app, quitting, swept, launches, tab, held, sess, used, saved, keep, alive, mayEnd, failed, tookOver>>

\* A quit is approved: the layout is no longer saved, and the teardown that follows closes every tab.
\* @code src/main/index.ts:931-934 frozen: quitApproved
QuitBegin ==
    /\ app = "up" /\ ~quitting
    /\ quitting' = TRUE
    /\ saved' = Open
    /\ UNCHANGED <<app, swept, launches, tab, held, state, sess, used, keep, inflight, alive, mayEnd, failed, tookOver, retry>>

\* The app is gone: after its teardown, or at any moment (a crash, a forced quit). The core dies with it, so an end in
\* flight is lost; the processes stay.
Down ==
    /\ app = "up"
    /\ quitting => Open = {}
    /\ app' = "down"
    /\ saved' = IF quitting THEN saved ELSE Open
    /\ quitting' = FALSE
    /\ tab' = [s \in Sessions |-> "closed"]
    /\ held' = [s \in Sessions |-> None]
    /\ inflight' = {}
    /\ retry' = {}
    /\ UNCHANGED <<swept, launches, state, sess, used, keep, alive, mayEnd, failed, tookOver>>

\* The next launch: every tag in the file is one the last launch left, and the saved tabs come back asleep.
\* @code src/main/session-processes.ts:224 constructor: every record read is left
Boot ==
    /\ app = "down"
    /\ launches < MaxLaunches
    /\ app' = "up"
    /\ launches' = launches + 1
    /\ swept' = FALSE
    /\ failed' = FALSE
    /\ state' = [t \in Tags |-> IF state[t] = "free" THEN "free" ELSE "left"]
    /\ tab' = [s \in Sessions |-> IF s \in saved THEN "asleep" ELSE "closed"]
    /\ keep' = saved
    /\ mayEnd' = mayEnd \cup {t \in Tags : state[t] # "free" /\ sess[t] \notin saved}
    /\ UNCHANGED <<quitting, held, sess, used, saved, inflight, alive, tookOver, retry>>

\* The launch's sweep.
\* @code src/main/index.ts:2498-2513 keep: the restored layouts and the markers; sweep after the tabs exist
Sweep ==
    /\ app = "up" /\ ~swept /\ ~quitting
    /\ swept' = TRUE
    /\ End(SweepTargets)
    /\ UNCHANGED <<app, quitting, launches, tab, held, sess, used, saved, keep, alive, mayEnd, failed, tookOver, retry>>

Next ==
    \/ \E s \in Sessions : Start(s) \/ Spawn(s) \/ Dispose(s)
    \/ \E t \in Tags : EndOk(t) \/ EndFail(t) \/ Retry(t)
    \/ QuitBegin \/ Down \/ Boot \/ Sweep

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------------------------------------------------------
\* PROPERTIES (frozen: formal/session-processes/Properties.md)
\* ---------------------------------------------------------------------------------------------------------------

\* Only a tag whose tab was closed outside a quit, or whose session did not come back, is ever ended.
OnlyGoneTagsEnd == inflight \subseteq mayEnd

\* An open tab never has its processes ended: neither the tag its started tab holds, nor what the last launch left
\* for a restored tab that has not started yet.
OpenTabsKeepTheirProcesses ==
    \A s \in Sessions :
        /\ tab[s] = "started" => (held[s] \notin inflight /\ state[held[s]] = "live")
        /\ tab[s] = "asleep" => \A t \in Tags : (sess[t] = s /\ state[t] # "free") => t \notin inflight

\* Nothing piles up: at rest in a launch where no end failed, every tag in the file belongs to an open tab.
NoLeakAtRest ==
    (app = "up" /\ swept /\ ~quitting /\ inflight = {} /\ ~failed) =>
        \A t \in Tags :
            state[t] # "free" =>
                \/ state[t] = "live" /\ \E s \in Sessions : tab[s] = "started" /\ held[s] = t
                \/ state[t] = "left" /\ tab[sess[t]] # "closed"

\* A tag with running processes is never forgotten: the file still names it, so a later close or launch can end them.
NoForgottenTag == \A t \in alive : state[t] # "free"

\* Sanity (must be violated).
NeverEnds == inflight = {}
NeverTakesOver == ~tookOver

=============================================================================
