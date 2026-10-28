--------------------------- MODULE SessionListing ---------------------------
(* Model of how a paired device's session list follows the host's listing:   *)
(* a row says `heldOnHost` (a tab on the host holds the session) and         *)
(* `openedBySession` (who opened it). No journal moves when a tab opens,     *)
(* closes or changes session, so the host re-announces by comparing a        *)
(* snapshot (`#listingSnapshot`), and the device reads again (debounced).    *)
(* Code: src/main/remote/host-services.ts (listingChanged, sessions.list,    *)
(* sessionsChanged), src/main/sidecar-pool.ts (window tabs, every take and   *)
(* let-go of a session file: onSessionFilesChanged), src/main/index.ts       *)
(* (sessionOpeners, the hooks), src/renderer/stores/session-list.ts          *)
(* (refresh, reconcile/sameRow).                                             *)
(*                                                                           *)
(* Granularity: one action per synchronous block (one event handler or       *)
(* timer). The host-to-device channel is one ordered queue per device        *)
(* carrying replies and events (assumption A1, CORRESPONDENCE.md).           *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Devices, Sessions, WinTabs, HostTabs, Opens, ClosedPair, MaxChanges, MaxTicks, MaxCh,
          Ordered             \* TRUE: a device gets the host's replies and events in the order the host sent them; FALSE: any order (the code does not enforce one)

NoS == "none"
Tabs == WinTabs \cup HostTabs
Files == Sessions \cup {NoS}
\* "No listing yet" (the snapshot before the first sessions.list; the rows before the first read). A record, so TLC can compare it.
Unk == [held |-> {"?"}, op |-> {}]
\* TLC config files cannot write tuples: the opener relation and the closed-child record are given by these operators
\* (cfg: `Opens <- OpensMC`, `ClosedPair <- ClosedPairMC`).
OpensMC == {<<"h1", "w1">>}
ClosedPairMC == <<"s2", "s1">>

VARIABLES
    file,       \* the session file each tab holds (NoS = none yet / closed)
    pendReg,    \* window tabs whose file was unregistered by a session-id change and awaits the `session` identity
    rec,        \* a closed-child record (AGENT_CLOSED_CHILDREN_PREF) names ClosedPair as an opener relation
    snap,       \* host: #listingSnapshot (Unk until the first sessions.list answers)
    evTimer,    \* host: the debounced SESSIONS_CHANGED timer is pending
    req,        \* device -> host: a sessions.list request is in the host's `await sessionIndex.list`
    ch,         \* host -> device: ordered replies and events
    view,       \* device: the rows it shows (held set and openers), Unk before the first read
    inFlight, queued, deb,   \* device feed: one read in flight, one queued, the 350 ms debounce pending
    nChanges, nTicks

vars == <<file, pendReg, rec, snap, evTimer, req, ch, view, inFlight, queued, deb, nChanges, nTicks>>

Held(f) == {f[t] : t \in {u \in Tabs : f[u] # NoS}}
\* host-services.ts #listing(): who opened each session = the opener tab's session file (`Opens` = pairs <<child tab, opener tab>>),
\* plus the closed-child record of index.ts sessionOpeners().
Openers(f, r) ==
    {<<f[x[1]], f[x[2]]>> : x \in {y \in Opens : f[y[1]] # NoS /\ f[y[2]] # NoS /\ f[y[1]] # f[y[2]]}}
    \cup (IF r THEN {ClosedPair} ELSE {})
Listing(f, r) == [held |-> Held(f), op |-> Openers(f, r)]

Msgs == [kind : {"reply"}, l : [held : SUBSET Sessions, op : SUBSET (Sessions \X Sessions)]] \cup [kind : {"event"}]

TypeOK ==
    /\ file \in [Tabs -> Files]
    /\ pendReg \subseteq WinTabs /\ rec \in BOOLEAN
    /\ evTimer \in BOOLEAN /\ req \in [Devices -> BOOLEAN] /\ ch \in [Devices -> Seq(Msgs)]
    /\ inFlight \in [Devices -> BOOLEAN] /\ queued \in [Devices -> BOOLEAN] /\ deb \in [Devices -> BOOLEAN]

Init ==
    /\ file = [t \in Tabs |-> NoS] /\ pendReg = {} /\ rec = FALSE
    /\ snap = Unk /\ evTimer = FALSE
    /\ req = [d \in Devices |-> TRUE]                  \* retain() => refresh(true): the first read is out
    /\ ch = [d \in Devices |-> <<>>] /\ view = [d \in Devices |-> Unk]
    /\ inFlight = [d \in Devices |-> TRUE] /\ queued = [d \in Devices |-> FALSE] /\ deb = [d \in Devices |-> FALSE]
    /\ nChanges = 0 /\ nTicks = 0

\* host-services.ts listingChanged(): re-announce only when the listing differs from the last snapshot
Announce(f2, r2) ==
    IF snap # Unk /\ Listing(f2, r2) # snap
       THEN snap' = Listing(f2, r2) /\ evTimer' = TRUE
       ELSE UNCHANGED <<snap, evTimer>>

----------------------------------------------------------------------------
\* ===== the host's tabs change: each handler ends by calling listingChanged() in the same synchronous block =====

\* @code src/main/remote/host-services.ts:1589-1615 #createTab: the device's tab holds its session now; listingChanged()
\* @code src/main/sidecar-pool.ts:657 a window tab acquired a session; #notifyWindowTabsChanged -> listingChanged
\* @code src/main/sidecar-pool.ts:2058-2066 #registerSessionFile: a file taken calls onSessionFilesChanged -> listingChanged
Open(t, s) ==
    /\ file[t] = NoS /\ t \notin pendReg /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = s] IN file' = f2 /\ Announce(f2, rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<pendReg, rec, req, ch, view, inFlight, queued, deb, nTicks>>

\* @code src/main/remote/host-services.ts:2237-2265 #closeTab ... listingChanged()
\* @code src/main/sidecar-pool.ts:1799-1800 #releaseEntry; #notifyWindowTabsChanged -> listingChanged
Close(t) ==
    /\ (file[t] # NoS \/ t \in pendReg) /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = NoS] IN file' = f2 /\ Announce(f2, rec)
    /\ pendReg' = pendReg \ {t}
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<rec, req, ch, view, inFlight, queued, deb, nTicks>>

\* @code src/main/remote/host-services.ts:1674-1681 'session' handler: tab.sessionFile = identity.sessionFile; listingChanged() when it changed
\* @code src/main/sidecar-pool.ts:980-994 'session' handler of a window tab: register the file, notify when it changed
Switch(t, s) ==
    /\ file[t] # NoS /\ file[t] # s /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = s] IN file' = f2 /\ Announce(f2, rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<pendReg, rec, req, ch, view, inFlight, queued, deb, nTicks>>

\* @code src/main/sidecar-pool.ts:958-970 sessionInfoUpdate with another sessionId unregisters the file (entry.sessionFile = undefined)
\* @code src/main/sidecar-pool.ts:2068-2073 #unregisterSessionFile: the let-go calls onSessionFilesChanged
\* @code src/main/index.ts:1014-1016 onSessionFilesChanged -> hostServices.listingChanged()
IdChange(t) ==
    /\ t \in WinTabs /\ file[t] # NoS /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = NoS]
       IN /\ file' = f2 /\ pendReg' = pendReg \cup {t}
          /\ Announce(f2, rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<rec, req, ch, view, inFlight, queued, deb, nTicks>>

\* @code src/main/sidecar-pool.ts:980-994 the `session` identity arrives (get_state, heartbeat): register the file and notify
Reregister(t, s) ==
    /\ t \in pendReg
    /\ LET f2 == [file EXCEPT ![t] = s] IN file' = f2 /\ Announce(f2, rec)
    /\ pendReg' = pendReg \ {t}
    /\ UNCHANGED <<rec, req, ch, view, inFlight, queued, deb, nChanges, nTicks>>

\* @code src/main/index.ts:900-909 sessionOpeners(): the closed-child record (AGENT_CLOSED_CHILDREN_PREF) appears or goes
\* @code src/main/ipc.ts:1265 the pref changed: hostedTabs.listingChanged()
Record ==
    /\ nChanges < MaxChanges
    /\ rec' = ~rec
    /\ Announce(file, ~rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<file, pendReg, req, ch, view, inFlight, queued, deb, nTicks>>

\* @code src/main/remote/host-services.ts:1254-1261 sessionsChanged(): the session index moved (a journal write) or a child's review changed
Tick ==
    /\ nTicks < MaxTicks
    /\ evTimer' = TRUE /\ nTicks' = nTicks + 1
    /\ UNCHANGED <<file, pendReg, rec, snap, req, ch, view, inFlight, queued, deb, nChanges>>

----------------------------------------------------------------------------
\* ===== the host answers and announces =====

\* @code src/main/remote/host-services.ts:996-1011 sessions.list: after `await sessionIndex.list`, read #listing(), record the snapshot and build the rows, in one block
Compute(d) ==
    /\ req[d] /\ Len(ch[d]) < MaxCh
    /\ req' = [req EXCEPT ![d] = FALSE]
    /\ ch' = [ch EXCEPT ![d] = Append(ch[d], [kind |-> "reply", l |-> Listing(file, rec)])]
    /\ snap' = Listing(file, rec)
    /\ UNCHANGED <<file, pendReg, rec, evTimer, view, inFlight, queued, deb, nChanges, nTicks>>

\* @code src/main/remote/host-services.ts:1254-1261 the sessionsChanged() timer fires: every connected device hears SESSIONS_CHANGED
Emit ==
    /\ evTimer /\ \A d \in Devices : Len(ch[d]) < MaxCh
    /\ evTimer' = FALSE
    /\ ch' = [d \in Devices |-> Append(ch[d], [kind |-> "event"])]
    /\ UNCHANGED <<file, pendReg, rec, snap, req, view, inFlight, queued, deb, nChanges, nTicks>>

----------------------------------------------------------------------------
\* ===== the device =====

\* refresh(): one read in flight; a refresh asked for meanwhile runs once after it
Refresh(d) ==
    IF inFlight[d]
       THEN /\ queued' = [queued EXCEPT ![d] = TRUE]
            /\ UNCHANGED <<inFlight, req>>
       ELSE /\ inFlight' = [inFlight EXCEPT ![d] = TRUE]
            /\ req' = [req EXCEPT ![d] = TRUE]
            /\ UNCHANGED queued

\* @code src/renderer/stores/session-list.ts:129-137 the reply lands: reconcile(state.sessions, list) keeps the rows it shows only when sameRow
\* @code src/renderer/stores/session-list.ts:168-174 .finally: inFlight = false; a queued refresh runs now
DeliverReply(d, i) ==
    /\ i <= Len(ch[d]) /\ ch[d][i].kind = "reply" /\ (Ordered => i = 1)
    /\ ch' = [ch EXCEPT ![d] = SubSeq(ch[d], 1, i - 1) \o SubSeq(ch[d], i + 1, Len(ch[d]))]
    /\ view' = [view EXCEPT ![d] = ch[d][i].l]
    /\ IF queued[d]
          THEN /\ queued' = [queued EXCEPT ![d] = FALSE]
               /\ inFlight' = [inFlight EXCEPT ![d] = TRUE]       \* refresh() right after
               /\ req' = [req EXCEPT ![d] = TRUE]
          ELSE /\ inFlight' = [inFlight EXCEPT ![d] = FALSE]
               /\ UNCHANGED <<queued, req>>
    /\ UNCHANGED <<file, pendReg, rec, snap, evTimer, deb, nChanges, nTicks>>

\* @code src/renderer/stores/session-list.ts:180-185 onSessionsChanged: (re)start the 350 ms debounce
DeliverEvent(d, i) ==
    /\ i <= Len(ch[d]) /\ ch[d][i].kind = "event" /\ (Ordered => i = 1)
    /\ ch' = [ch EXCEPT ![d] = SubSeq(ch[d], 1, i - 1) \o SubSeq(ch[d], i + 1, Len(ch[d]))]
    /\ deb' = [deb EXCEPT ![d] = TRUE]
    /\ UNCHANGED <<file, pendReg, rec, snap, evTimer, req, view, inFlight, queued, nChanges, nTicks>>

\* @code src/renderer/stores/session-list.ts:184 the debounce fires: refresh()
\* @code src/renderer/stores/session-list.ts:119-126 refresh(): in flight => queued, else read
DebFire(d) ==
    /\ deb[d]
    /\ deb' = [deb EXCEPT ![d] = FALSE]
    /\ Refresh(d)
    /\ UNCHANGED <<file, pendReg, rec, snap, evTimer, ch, view, nChanges, nTicks>>

----------------------------------------------------------------------------
Quiescent ==
    /\ pendReg = {} /\ ~evTimer
    /\ \A d \in Devices : ~req[d] /\ ch[d] = <<>> /\ ~inFlight[d] /\ ~queued[d] /\ ~deb[d]
Terminated == Quiescent /\ UNCHANGED vars

Next == \/ \E t \in Tabs, s \in Sessions : Open(t, s) \/ Switch(t, s)
        \/ \E t \in Tabs : Close(t)
        \/ \E t \in WinTabs : IdChange(t)
        \/ \E t \in WinTabs, s \in Sessions : Reregister(t, s)
        \/ Record
        \/ Tick
        \/ \E d \in Devices : Compute(d) \/ DebFire(d)
        \/ \E d \in Devices, i \in 1..MaxCh : DeliverReply(d, i) \/ DeliverEvent(d, i)
        \/ Emit
        \/ Terminated

Spec == Init /\ [][Next]_vars /\ WF_vars(Emit)
        /\ \A d \in Devices : WF_vars(Compute(d)) /\ WF_vars(DebFire(d))
              /\ WF_vars(\E i \in 1..MaxCh : DeliverReply(d, i)) /\ WF_vars(\E i \in 1..MaxCh : DeliverEvent(d, i))
        /\ \A t \in WinTabs, s \in Sessions : WF_vars(Reregister(t, s))

----------------------------------------------------------------------------
\* ===== Properties (protocol level, frozen: formal/session-listing/Properties.md) =====

\* Once events settle, each device's rows say what the host's tabs hold (heldOnHost) ...
HeldConverges == Quiescent => \A d \in Devices : view[d] # Unk /\ view[d].held = Held(file)
\* ... and who opened what (openedBySession).
OpenersConverge == Quiescent => \A d \in Devices : view[d] # Unk /\ view[d].op = Openers(file, rec)

\* Sanity (must FAIL): a device can end up showing a session as held, and an opener row can exist.
NeverHeld == \A d \in Devices : view[d] = Unk \/ view[d].held = {}
NeverOpener == \A d \in Devices : view[d] = Unk \/ view[d].op = {}
=============================================================================
