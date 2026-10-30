--------------------------- MODULE SessionListing ---------------------------
(* Model of how a paired device's session list follows the host's list.      *)
(*                                                                           *)
(* The host keeps ONE numbered copy of the list its devices get (rows: the   *)
(* journal's row plus `heldOnHost` / `openedBySession`); when it changes it  *)
(* sends every device what changed (a delta: base version, new version, rows *)
(* set or removed). The device computer keeps one numbered copy per host     *)
(* (HostSessionList), applies a delta of the version it holds, and reads the *)
(* host's whole list when it missed one; every window's feed does the same   *)
(* with the device computer's copy. No journal moves when a tab opens,       *)
(* closes or changes session, so the host also re-announces by comparing a   *)
(* snapshot (`#listingSnapshot`).                                            *)
(*                                                                           *)
(* Code: src/shared/session-list-delta.ts, src/main/session-list-share.ts,   *)
(* src/main/remote/host-services.ts (#deviceList, listingChanged,            *)
(* sessions.list, sessionsChanged), src/main/remote/host-session-list.ts,    *)
(* src/main/remote/devices.ts, src/main/sidecar-pool.ts (window tabs),       *)
(* src/main/index.ts (sessionOpeners, hooks), src/main/session-index.ts,     *)
(* src/renderer/stores/session-list.ts (the feed).                           *)
(*                                                                           *)
(* Granularity: one action per synchronous block (one event handler, timer   *)
(* or microtask chain). The host's read (`await sessionIndex.list`) is one   *)
(* block that samples the truth when it ends; the device computer's read of  *)
(* the host spans several blocks (request, reply), which is where a delta    *)
(* and a reply race. Assumptions: CORRESPONDENCE.md.                         *)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS Devices, Sessions, WinTabs, HostTabs, Opens, ClosedPair, Idx0,
          MaxChanges,   \* host tab changes (open, close, switch, id change, closed-child record)
          MaxIdx,       \* changes of the index's rows (a session appears, is written to or renamed, deleted, moved)
          MaxTicks,     \* sessionsChanged() calls that change no row
          MaxDrops,     \* link drops per device
          MaxForeign,   \* reads of the host's list by devices that are not modeled (their sessions.list calls stale() and reads)
          MaxJ,         \* how often a row's journal fields can change
          MaxCh,        \* messages in flight per queue
          LinkMode,     \* host -> device computer: "fifo" (one encrypted socket, counters in order: wire.ts), "gap"
          IpcMode,      \* device computer -> window: "free" (webContents.send and the invoke reply: no order between them), "gap", "fifo"
          Track         \* TRUE: keep the ghost `seen` (sanity runs only: it multiplies the states)

NoS == "none"
Tabs == WinTabs \cup HostTabs
Files == Sessions \cup {NoS}
Absent == -1            \* a session that does not exist yet
Gone == -2              \* a session that was deleted or moved away: never listed again
\* "No listing yet" (the snapshot before the first sessions.list). A record, so TLC can compare it.
Unk == [held |-> {"?"}, op |-> {}]
\* TLC config files cannot write tuples or functions: the opener relation, the closed-child record and the initial index
\* are given by these operators (cfg: `Opens <- OpensMC`, `ClosedPair <- ClosedPairMC`, `Idx0 <- IdxAllMC`).
OpensMC == {<<"h1", "w1">>}
OpensNoneMC == {}
ClosedPairMC == <<"s2", "s1">>
\* Devices are interchangeable (cfg: SYMMETRY DevSym; only for runs that check invariants).
DevSym == Permutations(Devices)
IdxAllMC == [s \in Sessions |-> 0]
IdxOneMC == [s \in Sessions |-> IF s = "s1" THEN 0 ELSE Absent]

\* A row as a device lists it: -1 = no row.
NoRow == [j |-> -1, h |-> FALSE, o |-> NoS]
\* "this row is as before" in a delta.
Same == [j |-> -2, h |-> FALSE, o |-> NoS]
NoRows == [s \in Sessions |-> NoRow]
\* What an answer must show after a device's request: a kind ("del", "mov", "ren"), the session and, for a rename, the journal state it needs.
NoNeed == <<"none", NoS, 0>>

VARIABLES
    \* ----- the host's truth -----
    file,       \* the session file each tab holds (NoS = none yet / closed)
    pendReg,    \* window tabs whose file was unregistered by a session-id change and awaits the `session` identity
    rec,        \* a closed-child record (AGENT_CLOSED_CHILDREN_PREF) names ClosedPair as an opener relation
    idx,        \* the index: per session Absent, Gone or the journal's state 0..MaxJ
    snap,       \* host: #listingSnapshot (Unk until the first read)
    evTimer,    \* host: the debounced sessionsChanged() timer is pending
    \* ----- the host's shared copy (#deviceList) -----
    hv, hrows,  \* its version (0 = no copy yet) and rows
    \* ----- the link between the host and each device computer -----
    up,         \* the device is connected
    lk,         \* host -> device computer: events (delta, bare) and replies
    rq,         \* device computer -> host: a sessions.list request the host has not handled yet
    \* ----- the device computer's copy of the host's list (HostSessionList) -----
    dv, drows,  \* its own version (0 = no copy yet) and rows (what windows read)
    dstale,     \* the next ask reads again (SessionListShare.stale)
    drd,        \* a read of the host is under way: "none", "clean", "dirty" (stale() came meanwhile)
    hver,       \* the host's version the copy holds (0 = none)
    ann,        \* the newest host version a change named while a read was under way (0 = none)
    goneD,      \* ghost: sessions this copy dropped after the host deleted them
    \* ----- the device computer -> window channel -----
    ip,         \* events (delta, bare) and answers (reply, err)
    \* ----- a window's feed -----
    fv, frows,  \* its numbered copy: the version it holds (0 = none) and rows
    fshow,      \* the rows it shows
    fin, fq, fann, fdeb, fret,   \* a read in flight, one queued, the version a change named meanwhile, the 350 ms debounce, a retry timer
    goneF,      \* ghost: sessions the feed's copy dropped after the host deleted them
    need, chk, bad,   \* ghost: what the ask after a device's delete, rename or move must show: waiting for an ask, on the ask under way, and whether an answer missed it
    post,       \* a device's delete or rename that main answered and the feed has not yet continued
    nChanges, nIdx, nTicks, nDrops, nForeign,
    seen        \* ghost (Track): what happened

tr == <<file, pendReg, rec, idx>>
an == <<snap, evTimer>>
hs == <<hv, hrows>>
lkv == <<up, lk, rq>>
hsl == <<dv, drows, dstale, drd, hver, ann, goneD>>
fd == <<fv, frows, fshow, fin, fq, fann, fdeb, fret, goneF, need, chk, bad>>
cn == <<nChanges, nIdx, nTicks, nDrops, nForeign>>
vars == <<tr, an, hs, lkv, hsl, ip, fd, post, cn, seen>>

\* Who asks for an index change: the host's own window, or a device (whose feed then continues after main answered).
Free(by) == IF by = "host" THEN TRUE ELSE post[by][1] = "none"

\* Ghost (Track): a branch of a guard was taken (sanity runs: each guard must be reachable).
Tag(d, t) == seen' = IF Track THEN [seen EXCEPT ![d] = @ \cup {t}] ELSE seen
\* A delta against another version than the copy holds, or no delta at all (a bare event): the feed reads again, debounced.
FeedGap(d) == fdeb' = [fdeb EXCEPT ![d] = TRUE]
\* A delta is applied only against the version the copy holds.
FeedBaseOk(h, b) == h = b
\* A change named a later version than the answer holds: read once more (olderSessionListVersion(answer.version, announced)).
FeedRaced(fa, v) == fa > 0 /\ v < fa
\* hostSessionsStale: the next ask reads the host, not the copy.
PostStale(st) == TRUE

----------------------------------------------------------------------------
\* ===== rows, deltas and the listing =====

Held(f) == {f[t] : t \in {u \in Tabs : f[u] # NoS}}
\* host-services.ts #listing(): who opened each session = the opener tab's session file (`Opens` = pairs <<child tab, opener tab>>),
\* plus the closed-child record of index.ts sessionOpeners().
Openers(f, r) ==
    {<<f[x[1]], f[x[2]]>> : x \in {y \in Opens : f[y[1]] # NoS /\ f[y[2]] # NoS /\ f[y[1]] # f[y[2]]}}
    \cup (IF r THEN {ClosedPair} ELSE {})
\* What listingSignature compares: the whole [held, openers] value.
Listing(f, r) == [held |-> Held(f), op |-> Openers(f, r)]
OpenerOf(s, f, r) ==
    LET ps == {p \in Openers(f, r) : p[1] = s} IN IF ps = {} THEN NoS ELSE (CHOOSE p \in ps : TRUE)[2]
Listed(i, s) == i[s] >= 0
\* host-services.ts #decorated(): a listed session's row says whether a tab holds it and who opened it.
Cell(s, f, r, i) == IF Listed(i, s) THEN [j |-> i[s], h |-> s \in Held(f), o |-> OpenerOf(s, f, r)] ELSE NoRow
Truth == [s \in Sessions |-> Cell(s, file, rec, idx)]
HeldRows(v) == {s \in Sessions : v[s] # NoRow /\ v[s].h}
OpenRows(v) == {<<s, v[s].o>> : s \in {u \in Sessions : v[u] # NoRow /\ v[u].o # NoS}}

\* session-list-delta.ts diffSessionList / applySessionListDelta: a delta says, per path, the new row, NoRow (removed) or Same.
Diff(a, b) == [s \in Sessions |-> IF a[s] = b[s] THEN Same ELSE b[s]]
Apply(rows, upd) == [s \in Sessions |-> IF upd[s] = Same THEN rows[s] ELSE upd[s]]
\* Ghost: the sessions a copy lists in `old` and no longer in `new` although the host deleted them (or moved them away).
Dropped(old, new) == {s \in Sessions : old[s] # NoRow /\ new[s] = NoRow /\ idx[s] = Gone}

DeltaMsg(b, v, u) == [kind |-> "delta", base |-> b, ver |-> v, upd |-> u]
BareMsg == [kind |-> "bare"]
ReplyMsg(v, r) == [kind |-> "reply", ver |-> v, rows |-> r]
ErrMsg == [kind |-> "err"]
IsEvent(m) == m.kind \in {"delta", "bare"}

Drop(q, i) == SubSeq(q, 1, i - 1) \o SubSeq(q, i + 1, Len(q))
\* Which message of a queue can arrive next. Events always arrive in the order they were sent. "fifo": a reply too. "gap": an
\* event may pass a reply, a reply waits for the events before it (a reply sent a moment after its rows were taken, a later
\* event leaving in that moment). "free": a reply may arrive at any position (two IPC paths, no order between them).
EvOk(q, i, mode) ==
    /\ i \in 1..Len(q) /\ IsEvent(q[i])
    /\ CASE mode = "fifo" -> i = 1
         [] OTHER -> \A k \in 1..(i - 1) : ~IsEvent(q[k])
RepOk(q, i, mode) ==
    /\ i \in 1..Len(q) /\ ~IsEvent(q[i])
    /\ CASE mode = "fifo" -> i = 1
         [] mode = "gap" -> \A k \in 1..(i - 1) : ~IsEvent(q[k])
         [] OTHER -> TRUE

TypeOK ==
    /\ file \in [Tabs -> Files] /\ pendReg \subseteq WinTabs /\ rec \in BOOLEAN
    /\ idx \in [Sessions -> -2..MaxJ]
    /\ evTimer \in BOOLEAN /\ up \in [Devices -> BOOLEAN] /\ rq \in [Devices -> BOOLEAN]
    /\ \A d \in Devices : Len(lk[d]) <= MaxCh /\ Len(ip[d]) <= MaxCh
    /\ drd \in [Devices -> {"none", "clean", "dirty"}]
    /\ dstale \in [Devices -> BOOLEAN] /\ fin \in [Devices -> BOOLEAN] /\ fq \in [Devices -> BOOLEAN]
    /\ fdeb \in [Devices -> BOOLEAN] /\ fret \in [Devices -> BOOLEAN]
    /\ goneD \in [Devices -> SUBSET Sessions] /\ goneF \in [Devices -> SUBSET Sessions]
    /\ bad \in [Devices -> BOOLEAN]

Init ==
    /\ file = [t \in Tabs |-> NoS] /\ pendReg = {} /\ rec = FALSE /\ idx = Idx0
    /\ snap = Unk /\ evTimer = FALSE
    /\ hv = 0 /\ hrows = NoRows
    /\ up = [d \in Devices |-> TRUE] /\ lk = [d \in Devices |-> <<>>]
    /\ rq = [d \in Devices |-> TRUE]                    \* the window's first read (retain => refresh) reaches the host computer's copy: it asks the host
    /\ dv = [d \in Devices |-> 0] /\ drows = [d \in Devices |-> NoRows] /\ dstale = [d \in Devices |-> FALSE]
    /\ drd = [d \in Devices |-> "clean"] /\ hver = [d \in Devices |-> 0] /\ ann = [d \in Devices |-> 0]
    /\ ip = [d \in Devices |-> <<>>]
    /\ fv = [d \in Devices |-> 0] /\ frows = [d \in Devices |-> NoRows] /\ fshow = [d \in Devices |-> NoRows]
    /\ fin = [d \in Devices |-> TRUE] /\ fq = [d \in Devices |-> FALSE] /\ fann = [d \in Devices |-> 0]
    /\ fdeb = [d \in Devices |-> FALSE] /\ fret = [d \in Devices |-> FALSE]
    /\ goneD = [d \in Devices |-> {}] /\ goneF = [d \in Devices |-> {}]
    /\ need = [d \in Devices |-> NoNeed] /\ chk = [d \in Devices |-> NoNeed] /\ bad = [d \in Devices |-> FALSE]
    /\ post = [d \in Devices |-> <<"none", "none", NoS>>]
    /\ nChanges = 0 /\ nIdx = 0 /\ nTicks = 0 /\ nDrops = 0 /\ nForeign = 0
    /\ seen = [d \in Devices |-> {}]

\* host-services.ts listingChanged(): re-announce only when the listing differs from the last snapshot
Announce(f2, r2) ==
    IF snap # Unk /\ Listing(f2, r2) # snap
       THEN snap' = Listing(f2, r2) /\ evTimer' = TRUE
       ELSE UNCHANGED <<snap, evTimer>>

----------------------------------------------------------------------------
\* ===== the host's tabs change: each handler ends by calling listingChanged() in the same synchronous block =====

\* @code src/main/remote/host-services.ts:1684-1723 #createTab: the device's tab holds its session now; listingChanged()
\* @code src/main/sidecar-pool.ts:679-689 a window tab acquired a session: #registerSessionFile, then #notifyWindowTabsChanged -> listingChanged
\* @code src/main/sidecar-pool.ts:2107-2116 #registerSessionFile: a file taken calls onSessionFilesChanged -> listingChanged
Open(t, s) ==
    /\ file[t] = NoS /\ t \notin pendReg /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = s] IN file' = f2 /\ Announce(f2, rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<pendReg, rec, idx, hs, lkv, hsl, ip, fd, post, nIdx, nTicks, nDrops, nForeign, seen>>

\* @code src/main/remote/host-services.ts:2383-2412 #closeTab ... listingChanged()
\* @code src/main/sidecar-pool.ts:1322-1331 #releaseEntry lets the file go (#unregisterSessionFile); 1846-1847 releaseTab -> #notifyWindowTabsChanged -> listingChanged
Close(t) ==
    /\ (file[t] # NoS \/ t \in pendReg) /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = NoS] IN file' = f2 /\ Announce(f2, rec)
    /\ pendReg' = pendReg \ {t}
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<rec, idx, hs, lkv, hsl, ip, fd, post, nIdx, nTicks, nDrops, nForeign, seen>>

\* @code src/main/remote/host-services.ts:1782-1791 'session' handler: tab.sessionFile = identity.sessionFile; listingChanged() when it changed
\* @code src/main/sidecar-pool.ts:1018-1029 'session' handler of a window tab: register the file, notify when it changed
Switch(t, s) ==
    /\ file[t] # NoS /\ file[t] # s /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = s] IN file' = f2 /\ Announce(f2, rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<pendReg, rec, idx, hs, lkv, hsl, ip, fd, post, nIdx, nTicks, nDrops, nForeign, seen>>

\* @code src/main/sidecar-pool.ts:993-1005 sessionInfoUpdate with another sessionId unregisters the file (entry.sessionFile = undefined)
\* @code src/main/sidecar-pool.ts:2118-2124 #unregisterSessionFile: the let-go calls onSessionFilesChanged
\* @code src/main/index.ts:1105 onSessionFilesChanged -> hostServices.listingChanged()
IdChange(t) ==
    /\ t \in WinTabs /\ file[t] # NoS /\ nChanges < MaxChanges
    /\ LET f2 == [file EXCEPT ![t] = NoS]
       IN /\ file' = f2 /\ pendReg' = pendReg \cup {t}
          /\ Announce(f2, rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<rec, idx, hs, lkv, hsl, ip, fd, post, nIdx, nTicks, nDrops, nForeign, seen>>

\* @code src/main/sidecar-pool.ts:1018-1029 the `session` identity arrives (get_state, heartbeat): register the file and notify
Reregister(t, s) ==
    /\ t \in pendReg
    /\ LET f2 == [file EXCEPT ![t] = s] IN file' = f2 /\ Announce(f2, rec)
    /\ pendReg' = pendReg \ {t}
    /\ UNCHANGED <<rec, idx, hs, lkv, hsl, ip, fd, post, cn, seen>>

\* @code src/main/index.ts:980-990 sessionOpeners(): the closed-child record (AGENT_CLOSED_CHILDREN_PREF) appears or goes
\* @code src/main/ipc.ts:1285 the pref changed: hostedTabs.listingChanged()
Record ==
    /\ nChanges < MaxChanges
    /\ rec' = ~rec
    /\ Announce(file, ~rec)
    /\ nChanges' = nChanges + 1
    /\ UNCHANGED <<file, pendReg, idx, hs, lkv, hsl, ip, fd, post, nIdx, nTicks, nDrops, nForeign, seen>>

\* @code src/main/remote/host-services.ts:1318-1325 sessionsChanged(): a child's review changed, or the index moved but no row did
Tick ==
    /\ nTicks < MaxTicks
    /\ evTimer' = TRUE /\ nTicks' = nTicks + 1
    /\ UNCHANGED <<tr, snap, hs, lkv, hsl, ip, fd, post, nChanges, nIdx, nDrops, nForeign, seen>>

----------------------------------------------------------------------------
\* ===== the index's rows change: the index reads again and tells main, which calls sessionsChanged() =====

\* @code src/main/session-index.ts:437-440 #notifyChange: the watch saw a new session file; the shared list reads again
\* @code src/main/ipc.ts:598-606 sessionIndex.onListChange -> remoteDevices.hostSessionsChanged() -> sessionsChanged()
IdxCreate(s) ==
    /\ idx[s] = Absent /\ nIdx < MaxIdx
    /\ idx' = [idx EXCEPT ![s] = 0] /\ evTimer' = TRUE /\ nIdx' = nIdx + 1
    /\ UNCHANGED <<file, pendReg, rec, snap, hs, lkv, hsl, ip, fd, post, nChanges, nTicks, nDrops, nForeign, seen>>

\* A journal write (by `by` = "host": a turn appended) or a rename (by a device: the host renamed it for that device).
\* @code src/main/session-index.ts:437-440 #notifyChange / relist() (src/main/session-index.ts:195-197) after a rename
\* @code src/main/remote/host-services.ts:2315-2316 a device's rename: the title is in the journal, sessionIndex.relist()
\* @code src/main/ipc.ts:1458-1463 SESSIONS_RENAME: remoteDevices.hostSessionsStale(device) once the host answered
IdxBump(s, by) ==
    /\ Listed(idx, s) /\ idx[s] < MaxJ /\ nIdx < MaxIdx /\ Free(by)
    /\ idx' = [idx EXCEPT ![s] = @ + 1] /\ evTimer' = TRUE /\ nIdx' = nIdx + 1
    /\ post' = IF by = "host" THEN post ELSE [post EXCEPT ![by] = <<"main", "ren", s>>]
    /\ UNCHANGED <<file, pendReg, rec, snap, hs, lkv, hsl, ip, fd, nChanges, nTicks, nDrops, nForeign, seen>>

\* A session is deleted (by the host's own window, or by a device: the host deletes it, then main of that device marks its copy stale).
\* @code src/main/session-index.ts:246-255 deleteSession -> #notifyChange
\* @code src/main/remote/host-services.ts:2282-2291 #deleteSession (a device's delete takes the host's path)
\* @code src/main/ipc.ts:472-484 SESSIONS_DELETE: remoteDevices.request(sessions.delete), then hostSessionsStale(device)
IdxDelete(s, by) ==
    /\ Listed(idx, s) /\ nIdx < MaxIdx /\ Free(by)
    /\ idx' = [idx EXCEPT ![s] = Gone] /\ evTimer' = TRUE /\ nIdx' = nIdx + 1
    /\ post' = IF by = "host" THEN post ELSE [post EXCEPT ![by] = <<"main", "del", s>>]
    /\ UNCHANGED <<file, pendReg, rec, snap, hs, lkv, hsl, ip, fd, nChanges, nTicks, nDrops, nForeign, seen>>

\* A session moves to another folder: its old path is gone, a new path is listed.
\* @code src/main/session-index.ts:276-289 moveSession -> #notifyChange
\* @code src/main/remote/host-services.ts:1107-1112 sessions.move
\* @code src/main/ipc.ts:1473-1482 SESSIONS_MOVE: remoteDevices.request(sessions.move), then hostSessionsStale(device)
IdxMove(s, t, by) ==
    /\ Listed(idx, s) /\ idx[t] = Absent /\ nIdx < MaxIdx /\ Free(by)
    /\ idx' = [idx EXCEPT ![t] = idx[s], ![s] = Gone] /\ evTimer' = TRUE /\ nIdx' = nIdx + 1
    /\ post' = IF by = "host" THEN post ELSE [post EXCEPT ![by] = <<"main", "mov", s>>]
    /\ UNCHANGED <<file, pendReg, rec, snap, hs, lkv, hsl, ip, fd, nChanges, nTicks, nDrops, nForeign, seen>>

----------------------------------------------------------------------------
\* ===== the host reads, publishes and answers =====

EmitAll(l, m) == [d \in Devices |-> IF up[d] THEN Append(l[d], m) ELSE l[d]]

\* @code src/main/remote/host-services.ts:1318-1325 sessionsChanged(): the debounce fires -> #deviceList.changed()
\* @code src/main/session-list-share.ts:52-61 changed(): no copy yet -> onChange(null) (a bare event); else read and hand on the delta
\* @code src/main/session-list-share.ts:77-90 #readOnce, #publish: a changed list gets the next version and goes to onChange
\* @code src/main/remote/host-services.ts:587-590 onChange: a delta to a device that has the capability, a bare event to the others
\* @code src/main/remote/host-services.ts:1371-1373 #decorated records the listing snapshot of this read
HostChanged ==
    /\ evTimer /\ \A d \in Devices : Len(lk[d]) + 1 <= MaxCh
    /\ evTimer' = FALSE
    /\ IF hv = 0
          THEN /\ lk' = EmitAll(lk, BareMsg) /\ UNCHANGED <<hv, hrows, snap>>
          ELSE /\ snap' = Listing(file, rec)
               /\ IF Truth = hrows
                     THEN UNCHANGED <<hv, hrows, lk>>
                     ELSE /\ hv' = hv + 1 /\ hrows' = Truth
                          /\ lk' = EmitAll(lk, DeltaMsg(hv, hv + 1, Diff(hrows, Truth)))
    /\ UNCHANGED <<tr, up, rq, hsl, ip, fd, post, cn, seen>>

\* @code src/main/remote/host-services.ts:1059-1067 sessions.list: stale() then current(): the read samples the rows now; a changed list is published
\*   (the delta goes to every device first), then the reply
\* @code src/main/session-list-share.ts:35-44 current()
\* @code src/main/remote/host-services.ts:1371-1373 #decorated records the listing snapshot of this read
HostRequest(d) ==
    /\ rq[d] /\ up[d] /\ \A e \in Devices : Len(lk[e]) + 2 <= MaxCh
    /\ rq' = [rq EXCEPT ![d] = FALSE]
    /\ snap' = Listing(file, rec)
    /\ LET fresh == hv = 0 \/ Truth # hrows
           v2 == IF hv = 0 THEN 1 ELSE IF fresh THEN hv + 1 ELSE hv
           l1 == IF hv > 0 /\ fresh THEN EmitAll(lk, DeltaMsg(hv, hv + 1, Diff(hrows, Truth))) ELSE lk
       IN /\ hv' = v2 /\ hrows' = IF fresh THEN Truth ELSE hrows
          /\ lk' = [l1 EXCEPT ![d] = Append(l1[d], ReplyMsg(v2, IF fresh THEN Truth ELSE hrows))]
    /\ UNCHANGED <<tr, evTimer, up, hsl, ip, fd, post, cn, seen>>

\* Another paired device reads the list (sessions.list: stale(), read, publish): the host records the snapshot and a changed list goes to
\* every device, this one included; the answer goes elsewhere.
\* @code src/main/remote/host-services.ts:1059-1067 sessions.list of a device that is not modeled
ForeignRead ==
    /\ nForeign < MaxForeign /\ \A e \in Devices : Len(lk[e]) + 1 <= MaxCh
    /\ nForeign' = nForeign + 1
    /\ snap' = Listing(file, rec)
    /\ IF hv = 0
          THEN /\ hv' = 1 /\ hrows' = Truth /\ UNCHANGED lk
          ELSE IF Truth = hrows
          THEN UNCHANGED <<hv, hrows, lk>>
          ELSE /\ hv' = hv + 1 /\ hrows' = Truth /\ lk' = EmitAll(lk, DeltaMsg(hv, hv + 1, Diff(hrows, Truth)))
    /\ UNCHANGED <<tr, evTimer, up, rq, hsl, ip, fd, post, nChanges, nIdx, nTicks, nDrops, seen>>

----------------------------------------------------------------------------
\* ===== the device computer's copy of the host's list (HostSessionList) =====

\* A delta is applied only against the version the copy holds.
BaseOk(h, b) == h = b
\* HostSessionList.stale() with no read under way: the next ask reads the host, and the windows are told (a bare event).
MarkStale(d) == dstale' = [dstale EXCEPT ![d] = TRUE] /\ ip' = [ip EXCEPT ![d] = Append(@, BareMsg)]
\* A change the copy cannot apply (a missed version, or a bare event) and no read under way.
HslGap(d) == MarkStale(d)
\* The link is back: the copy may have missed changes.
LinkBack(d) == MarkStale(d)
\* The applied list is no fresher than the copy it replaces (F4, fixed 30 Oct 2026): a stale copy stays stale until a read.
StaleAfterSet(st) == st

\* @code src/main/remote/host-session-list.ts:63-79 hostChanged(data): apply, ignore, note, or mark stale
\* @code src/main/remote/devices.ts:974-978 the host's sessions.changed event -> link.sessions.hostChanged(data)
\* @code src/main/session-list-share.ts:63-70 set(rows): the applied list becomes the copy, no fresher than before (F4), handed on like a read
\* @code src/main/session-list-share.ts:47-49 stale(); src/main/remote/host-session-list.ts:82-85 stale() also tells the windows (a bare event)
HostEvent(d, i) ==
    /\ EvOk(lk[d], i, LinkMode) /\ Len(ip[d]) + 2 <= MaxCh
    /\ LET m == lk[d][i]
           isD == m.kind = "delta"
           apply == isD /\ dv[d] > 0 /\ BaseOk(hver[d], m.base)
           have == isD /\ ~apply /\ hver[d] = m.ver
           reading == ~apply /\ ~have /\ drd[d] # "none"
           nr == Apply(drows[d], m.upd)
       IN /\ lk' = [lk EXCEPT ![d] = Drop(lk[d], i)]
          /\ IF apply
                THEN /\ hver' = [hver EXCEPT ![d] = m.ver]
                     /\ dstale' = [dstale EXCEPT ![d] = StaleAfterSet(dstale[d])]
                     /\ goneD' = [goneD EXCEPT ![d] = @ \cup Dropped(drows[d], nr)]
                     /\ IF nr = drows[d]
                           THEN UNCHANGED <<dv, drows, ip>>
                           ELSE /\ dv' = [dv EXCEPT ![d] = @ + 1]
                                /\ drows' = [drows EXCEPT ![d] = nr]
                                /\ ip' = [ip EXCEPT ![d] = Append(@, DeltaMsg(dv[d], dv[d] + 1, Diff(drows[d], nr)))]
                     /\ Tag(d, "hslApply")
                     /\ UNCHANGED <<drd, ann>>
                ELSE IF have
                THEN UNCHANGED <<hsl, ip, seen>>
                ELSE IF reading
                THEN /\ ann' = [ann EXCEPT ![d] = IF isD THEN m.ver ELSE @]
                     /\ Tag(d, "hslNote")
                     /\ UNCHANGED <<dv, drows, dstale, drd, hver, goneD, ip>>
                ELSE /\ HslGap(d)
                     /\ Tag(d, "hslGap")
                     /\ UNCHANGED <<dv, drows, drd, hver, ann, goneD>>
    /\ UNCHANGED <<tr, an, hs, up, rq, fd, post, cn>>

\* @code src/main/remote/host-session-list.ts:87-104 #read: the host's answer sets hostVersion, the finally branch asks for another read when a change named a later version
\* @code src/main/session-list-share.ts:77-90 #readOnce, #publish: the rows become the copy; a changed list goes to the windows as a delta
\* @code src/main/session-list-share.ts:35-44 current() returns the copy to the window's ask
HostReply(d, i) ==
    /\ RepOk(lk[d], i, LinkMode) /\ lk[d][i].kind = "reply" /\ Len(ip[d]) + 3 <= MaxCh
    /\ LET m == lk[d][i]
           late == ann[d] > 0 /\ m.ver < ann[d]
           before == dv[d] > 0
           chg == before /\ m.rows # drows[d]
           q1 == IF late THEN Append(ip[d], BareMsg) ELSE ip[d]
           q2 == IF chg THEN Append(q1, DeltaMsg(dv[d], dv[d] + 1, Diff(drows[d], m.rows))) ELSE q1
           dv2 == IF ~before THEN 1 ELSE IF chg THEN dv[d] + 1 ELSE dv[d]
       IN /\ lk' = [lk EXCEPT ![d] = Drop(lk[d], i)]
          /\ hver' = [hver EXCEPT ![d] = m.ver]
          /\ drd' = [drd EXCEPT ![d] = "none"] /\ ann' = [ann EXCEPT ![d] = 0]
          /\ dstale' = [dstale EXCEPT ![d] = late \/ (drd[d] = "dirty" /\ dstale[d])]
          /\ dv' = [dv EXCEPT ![d] = dv2] /\ drows' = [drows EXCEPT ![d] = m.rows]
          /\ goneD' = [goneD EXCEPT ![d] = @ \cup Dropped(drows[d], m.rows)]
          /\ ip' = [ip EXCEPT ![d] = Append(q2, ReplyMsg(dv2, m.rows))]
    /\ UNCHANGED <<tr, an, hs, up, rq, fd, post, cn, seen>>

----------------------------------------------------------------------------
\* ===== the link =====

\* The connection drops: what was in flight is lost, a read of the host fails (and so does the window's ask).
\* @code src/main/remote/devices.ts:957-972 client.on("state"): a link that is not online
\* @code src/main/remote/host-session-list.ts:87-104 #read throws; its finally still runs
LinkDrop(d) ==
    /\ up[d] /\ nDrops < MaxDrops /\ Len(ip[d]) + 2 <= MaxCh
    /\ up' = [up EXCEPT ![d] = FALSE] /\ lk' = [lk EXCEPT ![d] = <<>>] /\ rq' = [rq EXCEPT ![d] = FALSE]
    /\ nDrops' = nDrops + 1
    /\ IF drd[d] # "none"
          THEN LET late == ann[d] > 0 /\ hver[d] > 0 /\ hver[d] < ann[d]
               IN /\ drd' = [drd EXCEPT ![d] = "none"] /\ ann' = [ann EXCEPT ![d] = 0]
                  /\ dstale' = [dstale EXCEPT ![d] = @ \/ late]
                  /\ ip' = [ip EXCEPT ![d] = Append(IF late THEN Append(@, BareMsg) ELSE @, ErrMsg)]
          ELSE UNCHANGED <<drd, ann, dstale, ip>>
    /\ UNCHANGED <<tr, an, hs, dv, drows, hver, goneD, fd, post, nChanges, nIdx, nTicks, nForeign, seen>>

\* The link is back: the copy may have missed changes, so it is stale (the windows are told).
\* @code src/main/remote/devices.ts:957-972 client.on("state") online: link.sessions.stale()
LinkUp(d) ==
    /\ ~up[d] /\ Len(ip[d]) + 1 <= MaxCh
    /\ up' = [up EXCEPT ![d] = TRUE]
    /\ LinkBack(d)
    /\ UNCHANGED <<tr, an, hs, lk, rq, dv, drows, drd, hver, ann, goneD, fd, post, cn, seen>>

----------------------------------------------------------------------------
\* ===== the window's feed (session-list.ts) =====

\* What the window asks of the device computer's copy (`sessions.listShared` -> HostSessionList.current()): the copy when it is
\* current, else one read of the host (a failed link answers an error at once).
AskStarts(d) == ~(dv[d] > 0 /\ ~dstale[d]) /\ up[d]
AskOut(d, q) ==
    IF dv[d] > 0 /\ ~dstale[d] THEN Append(q, ReplyMsg(dv[d], drows[d]))
    ELSE IF ~up[d] THEN Append(q, ErrMsg) ELSE q
\* Ghost: an answer that must show what the device's request did and does not.
Violates(c, rows) ==
    /\ c[1] # "none"
    /\ IF c[1] = "ren" THEN rows[c[2]] # NoRow /\ rows[c[2]].j < c[3] ELSE rows[c[2]] # NoRow

\* @code src/renderer/stores/session-list.ts:164-206 refresh(): a read in flight queues one more, else the global feed reads the numbered list
\* @code src/main/remote/devices.ts:548-552 hostSessions -> HostSessionList.current()
\* `nd`: what a delete, rename or move just done through this device needs the next ask to show (NoNeed: nothing new).
RefreshFx(d, nd) ==
    LET n == IF nd # NoNeed THEN nd ELSE need[d]
    IN IF fin[d]
          THEN /\ fq' = [fq EXCEPT ![d] = TRUE] /\ need' = [need EXCEPT ![d] = n]
               /\ UNCHANGED <<fin, ip, drd, rq, chk>>
          ELSE /\ fin' = [fin EXCEPT ![d] = TRUE] /\ UNCHANGED fq
               /\ chk' = [chk EXCEPT ![d] = n] /\ need' = [need EXCEPT ![d] = NoNeed]
               /\ ip' = [ip EXCEPT ![d] = AskOut(d, @)]
               /\ drd' = [drd EXCEPT ![d] = IF AskStarts(d) THEN "clean" ELSE @]
               /\ rq' = [rq EXCEPT ![d] = IF AskStarts(d) THEN TRUE ELSE @]

\* The feed's view after `accept`: the rows it reconciles to (reconcile keeps a row object only when sameRow, so the content is the answer's).
SetShow(d, new) == fshow' = [fshow EXCEPT ![d] = new]

\* @code src/renderer/stores/session-list.ts:211-228 onSessionsChanged: a delta while a read is under way is noted; a delta of the held version applies; the same version is ignored; else the 350 ms debounce
FeedEvent(d, i) ==
    /\ EvOk(ip[d], i, IpcMode)
    /\ LET m == ip[d][i]
           isD == m.kind = "delta"
           noted == isD /\ fin[d]
           apply == isD /\ ~noted /\ FeedBaseOk(fv[d], m.base)
           have == isD /\ ~noted /\ ~apply /\ fv[d] = m.ver
       IN /\ ip' = [ip EXCEPT ![d] = Drop(@, i)]
          /\ IF noted
                THEN /\ fann' = [fann EXCEPT ![d] = m.ver] /\ Tag(d, "feedNote")
                     /\ UNCHANGED <<fv, frows, fshow, goneF, fdeb>>
                ELSE IF apply
                THEN /\ fv' = [fv EXCEPT ![d] = m.ver] /\ frows' = [frows EXCEPT ![d] = Apply(frows[d], m.upd)]
                     /\ SetShow(d, Apply(frows[d], m.upd))
                     /\ goneF' = [goneF EXCEPT ![d] = @ \cup Dropped(frows[d], Apply(frows[d], m.upd))]
                     /\ Tag(d, "feedApply")
                     /\ UNCHANGED <<fann, fdeb>>
                ELSE IF have
                THEN /\ UNCHANGED <<fv, frows, fshow, goneF, fann, fdeb, seen>>
                ELSE /\ FeedGap(d)
                     /\ Tag(d, "feedGap")
                     /\ UNCHANGED <<fv, frows, fshow, goneF, fann>>
    /\ UNCHANGED <<tr, an, hs, lkv, hsl, fin, fq, fret, need, chk, bad, post, cn>>

\* @code src/renderer/stores/session-list.ts:164-206 the read's answer: copy = answer, accept, queue a read when a change named a later version; .finally: a queued refresh runs now
FeedReply(d, i) ==
    /\ RepOk(ip[d], i, IpcMode) /\ ip[d][i].kind = "reply" /\ Len(ip[d]) + 1 <= MaxCh
    /\ LET m == ip[d][i]
           raced == FeedRaced(fann[d], m.ver)
           again == fq[d] \/ raced
       IN /\ fv' = [fv EXCEPT ![d] = m.ver] /\ frows' = [frows EXCEPT ![d] = m.rows]
          /\ SetShow(d, m.rows) /\ goneF' = [goneF EXCEPT ![d] = @ \cup Dropped(frows[d], m.rows)]
          /\ fann' = [fann EXCEPT ![d] = 0] /\ fq' = [fq EXCEPT ![d] = FALSE]
          /\ fin' = [fin EXCEPT ![d] = again]
          /\ bad' = [bad EXCEPT ![d] = @ \/ Violates(chk[d], m.rows)]
          /\ chk' = [chk EXCEPT ![d] = IF again THEN need[d] ELSE NoNeed]
          /\ need' = [need EXCEPT ![d] = IF again THEN NoNeed ELSE need[d]]
          /\ IF raced THEN Tag(d, "feedRaced") ELSE UNCHANGED seen
          /\ IF again
                THEN /\ ip' = [ip EXCEPT ![d] = AskOut(d, Drop(@, i))]
                     /\ drd' = [drd EXCEPT ![d] = IF AskStarts(d) THEN "clean" ELSE @]
                     /\ rq' = [rq EXCEPT ![d] = IF AskStarts(d) THEN TRUE ELSE @]
                ELSE /\ ip' = [ip EXCEPT ![d] = Drop(@, i)] /\ UNCHANGED <<drd, rq>>
    /\ UNCHANGED <<tr, an, hs, up, lk, dv, drows, dstale, hver, ann, goneD, fdeb, fret, post, nChanges, nIdx, nTicks, nDrops, nForeign>>

\* @code src/renderer/stores/session-list.ts:183-197 the read failed: the error is shown, a retry is set while held; .finally runs the queued refresh
FeedErr(d, i) ==
    /\ RepOk(ip[d], i, IpcMode) /\ ip[d][i].kind = "err" /\ Len(ip[d]) + 1 <= MaxCh
    /\ LET again == fq[d]
       IN /\ fret' = [fret EXCEPT ![d] = TRUE]
          /\ fann' = [fann EXCEPT ![d] = 0] /\ fq' = [fq EXCEPT ![d] = FALSE]
          /\ fin' = [fin EXCEPT ![d] = again]
          /\ chk' = [chk EXCEPT ![d] = IF again THEN need[d] ELSE NoNeed]
          /\ need' = [need EXCEPT ![d] = IF again THEN NoNeed ELSE need[d]]
          /\ IF again
                THEN /\ ip' = [ip EXCEPT ![d] = AskOut(d, Drop(@, i))]
                     /\ drd' = [drd EXCEPT ![d] = IF AskStarts(d) THEN "clean" ELSE @]
                     /\ rq' = [rq EXCEPT ![d] = IF AskStarts(d) THEN TRUE ELSE @]
                ELSE /\ ip' = [ip EXCEPT ![d] = Drop(@, i)] /\ UNCHANGED <<drd, rq>>
    /\ UNCHANGED <<tr, an, hs, up, lk, dv, drows, dstale, hver, ann, goneD, fv, frows, fshow, goneF, fdeb, bad, post, cn, seen>>

\* @code src/renderer/stores/session-list.ts:211-228 the debounce fires: refresh()
FeedDebFire(d) ==
    /\ fdeb[d] /\ Len(ip[d]) + 1 <= MaxCh
    /\ fdeb' = [fdeb EXCEPT ![d] = FALSE]
    /\ RefreshFx(d, NoNeed)
    /\ UNCHANGED <<tr, an, hs, up, lk, dv, drows, dstale, hver, ann, goneD, fv, frows, fshow, goneF, fann, fret, bad, post, cn, seen>>

\* @code src/renderer/stores/session-list.ts:183-197 the retry timer of a failed read fires: refresh()
FeedRetry(d) ==
    /\ fret[d] /\ Len(ip[d]) + 1 <= MaxCh
    /\ fret' = [fret EXCEPT ![d] = FALSE]
    /\ RefreshFx(d, NoNeed)
    /\ UNCHANGED <<tr, an, hs, up, lk, dv, drows, dstale, hver, ann, goneD, fv, frows, fshow, goneF, fann, fdeb, bad, post, cn, seen>>

\* A device's delete, rename or move: main answered after the host did, and marked the device computer's copy stale (a bare event goes to the windows) ...
\* @code src/main/ipc.ts:472-484 SESSIONS_DELETE: remoteDevices.hostSessionsStale(device)
\* @code src/main/ipc.ts:1458-1463 SESSIONS_RENAME: remoteDevices.hostSessionsStale(device)
\* @code src/main/ipc.ts:1473-1482 SESSIONS_MOVE: remoteDevices.hostSessionsStale(device)
\* @code src/main/remote/devices.ts:562-564 hostSessionsStale -> HostSessionList.stale()
PostMain(d) ==
    /\ post[d][1] = "main" /\ Len(ip[d]) + 1 <= MaxCh
    /\ post' = [post EXCEPT ![d] = <<"feed", post[d][2], post[d][3]>>]
    /\ dstale' = [dstale EXCEPT ![d] = PostStale(dstale[d])] /\ drd' = [drd EXCEPT ![d] = IF @ = "clean" THEN "dirty" ELSE @]
    /\ ip' = [ip EXCEPT ![d] = Append(@, BareMsg)]
    /\ UNCHANGED <<tr, an, hs, lkv, dv, drows, hver, ann, goneD, fd, cn, seen>>

\* ... and the window's feed continues: a delete drops the row from the rows it shows, then it reads again.
\* @code src/renderer/stores/session-list.ts:255-273 deleteSession: every list of this device drops the row, then refresh()
\* @code src/renderer/stores/session-list.ts:274-284 renameSession: the row's title, then refresh()
PostFeed(d) ==
    /\ post[d][1] = "feed" /\ Len(ip[d]) + 1 <= MaxCh
    /\ post' = [post EXCEPT ![d] = <<"none", "none", NoS>>]
    /\ IF post[d][2] = "del"
          THEN SetShow(d, [fshow[d] EXCEPT ![post[d][3]] = NoRow])
          ELSE UNCHANGED fshow
    /\ RefreshFx(d, <<post[d][2], post[d][3], IF Listed(idx, post[d][3]) THEN idx[post[d][3]] ELSE 0>>)
    /\ UNCHANGED <<tr, an, hs, up, lk, dv, drows, dstale, hver, ann, goneD, fv, frows, goneF, fann, fdeb, fret, bad, cn, seen>>

----------------------------------------------------------------------------
Quiescent ==
    /\ pendReg = {} /\ ~evTimer
    /\ \A d \in Devices :
          /\ up[d] /\ lk[d] = <<>> /\ ip[d] = <<>> /\ ~rq[d] /\ drd[d] = "none"
          /\ ~fin[d] /\ ~fq[d] /\ ~fdeb[d] /\ ~fret[d] /\ post[d][1] = "none"
Terminated == Quiescent /\ UNCHANGED vars

Next == \/ \E t \in Tabs, s \in Sessions : Open(t, s) \/ Switch(t, s)
        \/ \E t \in Tabs : Close(t)
        \/ \E t \in WinTabs : IdChange(t)
        \/ \E t \in WinTabs, s \in Sessions : Reregister(t, s)
        \/ Record
        \/ Tick
        \/ \E s \in Sessions : IdxCreate(s)
        \/ \E s \in Sessions, by \in Devices \cup {"host"} : IdxBump(s, by) \/ IdxDelete(s, by)
        \/ \E s, t \in Sessions, by \in Devices \cup {"host"} : IdxMove(s, t, by)
        \/ HostChanged \/ ForeignRead
        \/ \E d \in Devices : HostRequest(d) \/ FeedDebFire(d) \/ FeedRetry(d) \/ PostMain(d) \/ PostFeed(d) \/ LinkDrop(d) \/ LinkUp(d)
        \/ \E d \in Devices, i \in 1..MaxCh :
              HostEvent(d, i) \/ HostReply(d, i) \/ FeedEvent(d, i) \/ FeedReply(d, i) \/ FeedErr(d, i)
        \/ Terminated

Spec == Init /\ [][Next]_vars /\ WF_vars(HostChanged)
        /\ \A d \in Devices :
              WF_vars(HostRequest(d)) /\ WF_vars(FeedDebFire(d)) /\ WF_vars(FeedRetry(d)) /\ WF_vars(LinkUp(d))
              /\ WF_vars(PostMain(d)) /\ WF_vars(PostFeed(d))
              /\ WF_vars(\E i \in 1..MaxCh : HostEvent(d, i)) /\ WF_vars(\E i \in 1..MaxCh : HostReply(d, i))
              /\ WF_vars(\E i \in 1..MaxCh : FeedEvent(d, i)) /\ WF_vars(\E i \in 1..MaxCh : FeedReply(d, i))
              /\ WF_vars(\E i \in 1..MaxCh : FeedErr(d, i))
        /\ \A t \in WinTabs, s \in Sessions : WF_vars(Reregister(t, s))

----------------------------------------------------------------------------
\* ===== Properties (protocol level, frozen: formal/session-listing/Properties.md) =====

\* Once events settle, each window's rows say what the host's tabs hold (heldOnHost) ...
HeldConverges == Quiescent => \A d \in Devices : HeldRows(fshow[d]) = HeldRows(Truth)
\* ... and who opened what (openedBySession) ...
OpenersConverge == Quiescent => \A d \in Devices : OpenRows(fshow[d]) = OpenRows(Truth)
\* ... and every row: the window lists exactly the host's list, whatever order the messages came in.
ListConverges == Quiescent => \A d \in Devices : fshow[d] = Truth
\* A session the host deleted (or moved away) and a receiver's copy dropped never comes back in that copy: not in the device
\* computer's copy of the host's list, not in the window's numbered copy.
NoReappear ==
    \A d \in Devices :
        /\ \A s \in goneD[d] : drows[d][s] = NoRow
        /\ \A s \in goneF[d] : frows[d][s] = NoRow
\* The ask a window makes after a device's delete, rename or move through the host shows it: main marked the copy stale, so the
\* answer is not the copy from before (the host publishes that change only after its debounce).
FreshAfterRequest == \A d \in Devices : ~bad[d]
\* A window has at most one ask at the device computer's copy: a read of the host under way is that ask.
OneAsk == \A d \in Devices : drd[d] # "none" => fin[d]
\* No copy holds a version with other rows than the host numbered that version: a delta was never applied against another base.
SameVersionSameRows ==
    \A d \in Devices :
        /\ (hver[d] > 0 /\ hver[d] = hv) => drows[d] = hrows
        /\ (dv[d] > 0 /\ fv[d] = dv[d]) => frows[d] = drows[d]

\* Sanity (must FAIL): a window can show a held row and an opener row, hide a deleted one, and the delta path is used.
NeverHeld == \A d \in Devices : HeldRows(fshow[d]) = {}
NeverOpener == \A d \in Devices : OpenRows(fshow[d]) = {}
NoHslApply == \A d \in Devices : "hslApply" \notin seen[d]
NoHslGap == \A d \in Devices : "hslGap" \notin seen[d]
NoHslNote == \A d \in Devices : "hslNote" \notin seen[d]
NoFeedApply == \A d \in Devices : "feedApply" \notin seen[d]
NoFeedGap == \A d \in Devices : "feedGap" \notin seen[d]
NoFeedNote == \A d \in Devices : "feedNote" \notin seen[d]
NoFeedRaced == \A d \in Devices : "feedRaced" \notin seen[d]
NeverGone == \A d \in Devices : goneD[d] = {} /\ goneF[d] = {}
=============================================================================
