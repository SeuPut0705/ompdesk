---------------------- MODULE SessionDeleteFences ----------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Scopes, Opens, Deletes, Slots, InvalidateReads, RecheckOpen
VARIABLES file, tombstone, dpc, fence, op, published, badOpen,
          feed, snapshot, generation, readPc, readGen, readConn, readRow,
          connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow, shared

vars == <<file, tombstone, dpc, fence, op, published, badOpen,
          feed, snapshot, generation, readPc, readGen, readConn, readRow,
          connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow, shared>>

Active == {d \in Deletes : dpc[d] \in {"host", "local", "store", "removed", "notified"}}
OpenAllowed == ~tombstone /\ fence = 0

Init ==
    /\ file = TRUE /\ tombstone = FALSE /\ fence = 0
    /\ dpc = [d \in Deletes |-> "unused"]
    /\ op = [o \in Opens |-> "unused"]
    /\ published = {} /\ badOpen = FALSE
    /\ feed = [s \in Scopes |-> TRUE] /\ snapshot = [s \in Scopes |-> TRUE]
    /\ generation = [s \in Scopes |-> 0]
    /\ readPc = [s \in Scopes |-> [r \in Slots |-> "unused"]]
    /\ readGen = [s \in Scopes |-> [r \in Slots |-> 0]]
    /\ readConn = [s \in Scopes |-> [r \in Slots |-> 0]]
    /\ readRow = [s \in Scopes |-> [r \in Slots |-> FALSE]]
    /\ connection = 0 /\ online = TRUE /\ acknowledged = FALSE
    /\ rebuilt = FALSE /\ rebuiltRow = FALSE /\ restored = FALSE /\ restoredRow = FALSE
    /\ shared = [gen |-> 0, copyGen |-> 0, copyRow |-> TRUE,
                  reading |-> FALSE, sampleGen |-> 0, sampleRow |-> TRUE,
                  bumped |-> FALSE, lateDropped |-> FALSE, freshAfterLate |-> FALSE,
                  late |-> [s \in Scopes |-> [r \in Slots |-> FALSE]],
                  wants |-> [s \in Scopes |-> [r \in Slots |-> 0]]]

\* @code src/main/session-mutations.ts:53-60 Count the delete before closing hosted tabs.
\* @code src/main/remote/host-services.ts:2825-2835 Close idle hosted tabs before awaiting their exit.
DeleteStart(d) ==
    /\ dpc[d] = "unused"
    /\ dpc' = [dpc EXCEPT ![d] = "host"]
    /\ fence' = fence + 1 /\ published' = {}
    /\ UNCHANGED <<file, tombstone, op, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/session-mutations.ts:60-64 After hosted exits, await closing the local session tab.
DeleteHostClosed(d) ==
    /\ dpc[d] = "host" /\ dpc' = [dpc EXCEPT ![d] = "local"]
    /\ UNCHANGED <<file, tombstone, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/session-mutations.ts:62-64 The local close succeeded and storage deletion starts.
DeleteLocalClosed(d) ==
    /\ dpc[d] = "local" /\ dpc' = [dpc EXCEPT ![d] = "store"]
    /\ UNCHANGED <<file, tombstone, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/session-index.ts:329-335 The storage operation can remove the file before its promise resumes.
StorageRemove(d) ==
    /\ dpc[d] = "store" /\ file' = FALSE /\ dpc' = [dpc EXCEPT ![d] = "removed"]
    /\ UNCHANGED <<tombstone, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/session-index.ts:335-337 The storage continuation invalidates the shared list.
DeleteNotify(d) ==
    /\ dpc[d] = "removed" /\ dpc' = [dpc EXCEPT ![d] = "notified"]
    /\ shared' = [shared EXCEPT !.gen = @ + 1]
    /\ UNCHANGED <<file, tombstone, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>

\* @code src/main/session-mutations.ts:64-72 After deleteStored resolves, add the tombstone and release this delete's count in finally.
\* @code src/main/deleted-sessions.ts:80-93 add changes the in-memory map before requesting its save.
DeleteCommit(d) ==
    /\ dpc[d] = "notified" /\ tombstone' = TRUE
    /\ dpc' = [dpc EXCEPT ![d] = "done"]
    /\ fence' = fence - 1
    /\ UNCHANGED <<file, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/session-mutations.ts:55-72 Refusal or a rejected close/storage promise runs finally without adding a tombstone.
DeleteFail(d) ==
    /\ dpc[d] \in {"host", "local", "store"}
    /\ dpc' = [dpc EXCEPT ![d] = "failed"] /\ fence' = fence - 1
    /\ UNCHANGED <<file, tombstone, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/renderer/stores/session-list.ts:255-285 Successful delete continuation forgets both feeds and snapshots.
DeleteAcknowledged(d) ==
    /\ dpc[d] = "done" /\ dpc' = [dpc EXCEPT ![d] = "acked"]
    /\ generation' = [s \in Scopes |-> IF InvalidateReads THEN generation[s] + 1 ELSE generation[s]]
    /\ feed' = [s \in Scopes |-> FALSE] /\ snapshot' = [s \in Scopes |-> FALSE]
    /\ acknowledged' = TRUE /\ rebuilt' = FALSE
    /\ UNCHANGED <<file, tombstone, fence, op, published, badOpen, readPc, readGen, readConn, readRow, connection, online, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/renderer/stores/session-list.ts:161-180 Start a feed read and retain its feed generation.
\* @code src/main/session-index.ts:260-263 A shared read may have started before deletion.
ReadStart(s, r) ==
    /\ online /\ readPc[s][r] = "unused"
    /\ readPc' = [readPc EXCEPT ![s][r] = "waiting"]
    /\ readGen' = [readGen EXCEPT ![s][r] = generation[s]]
    /\ readConn' = [readConn EXCEPT ![s][r] = connection]
    /\ shared' = [shared EXCEPT !.wants[s][r] = shared.gen]
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, snapshot, generation, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>

\* @code src/main/session-list-share.ts:46-49 Another index change can invalidate a previously cached list.
ShareStale ==
    /\ ~shared.bumped
    /\ shared' = [shared EXCEPT !.gen = @ + 1, !.bumped = TRUE]
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>

\* @code src/main/session-list-share.ts:34-42 Start the one shared read at the current generation.
\* @code src/main/session-index.ts:283-292 The underlying read may retain rows across its next await.
ShareReadStart ==
    /\ ~shared.reading /\ shared.copyGen < shared.gen
    /\ shared' = [shared EXCEPT !.reading = TRUE, !.sampleGen = shared.gen, !.sampleRow = file]
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>

\* @code src/main/session-list-share.ts:77-89 Publish a sampled read at its captured generation.
ShareReadFinish ==
    /\ shared.reading
    /\ shared' = [shared EXCEPT !.reading = FALSE, !.copyGen = shared.sampleGen, !.copyRow = shared.sampleRow]
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>

\* @code src/main/session-list-share.ts:34-43 An ask resumes only when the copy reaches the generation it wanted.
ReadAnswer(s, r) ==
    /\ readPc[s][r] = "waiting" /\ shared.copyGen >= shared.wants[s][r]
    /\ readPc' = [readPc EXCEPT ![s][r] = "ready"]
    /\ readRow' = [readRow EXCEPT ![s][r] = shared.copyRow]
    /\ shared' = [shared EXCEPT !.late[s][r] =
        acknowledged /\ readConn[s][r] # connection /\ shared.copyRow]
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, snapshot, generation, readGen, readConn, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>

\* @code src/renderer/stores/session-list.ts:138-185 The answer is accepted only by its original feed generation.
ReadFinish(s, r) ==
    /\ readPc[s][r] = "ready"
    /\ readPc' = [readPc EXCEPT ![s][r] = "done"]
    /\ IF readConn[s][r] = connection /\ readGen[s][r] = generation[s]
       THEN /\ feed' = [feed EXCEPT ![s] = readRow[s][r]]
            /\ rebuilt' = IF connection = 1 THEN TRUE ELSE rebuilt
            /\ rebuiltRow' = IF connection = 1 THEN readRow[s][r] ELSE rebuiltRow
       ELSE /\ UNCHANGED <<feed, rebuilt, rebuiltRow>>
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, snapshot, generation, readGen, readConn, readRow, connection, online, acknowledged, restored, restoredRow>>
    /\ shared' = [shared EXCEPT
        !.lateDropped = @ \/ shared.late[s][r],
        !.freshAfterLate = @ \/ (shared.lateDropped /\ connection = 1 /\
            readConn[s][r] = connection /\ readGen[s][r] = generation[s] /\ ~readRow[s][r])]

\* @code src/renderer/stores/session-list.ts:115-120 The delayed snapshot timer reads the current feed, not an old captured array.
SaveSnapshot(s) ==
    /\ snapshot' = [snapshot EXCEPT ![s] = feed[s]]
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/remote/host-services.ts:1916-1947 View creation, the second check, disposal on refusal and publication do not await.
OpenView(o) ==
    /\ op[o] = "unused" /\ OpenAllowed
    /\ op' = [op EXCEPT ![o] = "published"]
    /\ published' = IF published = {} THEN {o} ELSE published
    /\ UNCHANGED <<file, tombstone, dpc, fence, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/remote/devices.ts:1032-1054 A returning host marks its shared session list stale.
\* @code src/renderer/stores/session-list.ts:107-250 A released feed drops pending answers; a rebuilt feed seeds from the snapshot.
Reconnect ==
    /\ connection = 0 /\ connection' = 1 /\ online' = TRUE
    /\ feed' = snapshot
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, snapshot, generation, readPc, readGen, readConn, readRow, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/tab-layout.ts:80-123 Restore consults the in-memory tombstone before retaining a session path.
Restore ==
    /\ ~restored /\ tombstone /\ restored' = TRUE /\ restoredRow' = ~tombstone
    /\ UNCHANGED <<file, tombstone, dpc, fence, op, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow>>
    /\ UNCHANGED shared

\* @code src/main/remote/host-services.ts:1864-1875 Initial tombstone and in-flight checks precede lookup.
OpenStart(o) ==
    /\ op[o] = "unused" /\ OpenAllowed
    /\ op' = [op EXCEPT ![o] = "kind"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/remote/host-services.ts:1954-1956 The kind lookup resumes and checks again.
OpenKind(o) ==
    /\ op[o] = "kind" /\ op' = [op EXCEPT ![o] = IF OpenAllowed THEN "cwd" ELSE "refused"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/remote/host-services.ts:1959-1963 The recorded folder lookup resumes and checks again.
OpenCwd(o) ==
    /\ op[o] = "cwd" /\ op' = [op EXCEPT ![o] = IF OpenAllowed THEN "directory" ELSE "refused"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, published, badOpen, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

\* @code src/main/remote/host-services.ts:1964-1996 Directory completion, final check, race checks and creation run without another await.
\* @code src/main/remote/host-services.ts:2113-2146 createSidecar and publication of the host tab are synchronous.
OpenPublish(o) ==
    /\ op[o] = "directory"
    /\ LET allowed == IF RecheckOpen THEN OpenAllowed ELSE TRUE IN
       /\ op' = [op EXCEPT ![o] = IF allowed THEN "published" ELSE "refused"]
       /\ published' = IF allowed /\ published = {} THEN {o} ELSE published
       /\ badOpen' = badOpen \/ (allowed /\ published = {} /\ ~OpenAllowed)
    /\ UNCHANGED <<file, tombstone, dpc, fence, feed, snapshot, generation, readPc, readGen, readConn, readRow, connection, online, acknowledged, rebuilt, rebuiltRow, restored, restoredRow>>
    /\ UNCHANGED shared

Next ==
    \/ \E d \in Deletes : DeleteStart(d) \/ DeleteHostClosed(d) \/ DeleteLocalClosed(d) \/ StorageRemove(d) \/ DeleteNotify(d) \/ DeleteCommit(d) \/ DeleteFail(d) \/ DeleteAcknowledged(d)
    \/ \E s \in Scopes : \E r \in Slots : ReadStart(s, r) \/ ReadAnswer(s, r) \/ ReadFinish(s, r)
    \/ ShareStale \/ ShareReadStart \/ ShareReadFinish
    \/ \E s \in Scopes : SaveSnapshot(s)
    \/ Reconnect \/ Restore
    \/ \E o \in Opens : OpenStart(o) \/ OpenView(o) \/ OpenKind(o) \/ OpenCwd(o) \/ OpenPublish(o)

Spec == Init /\ [][Next]_vars

\* FROZEN PROPERTIES
NoFeedReinsert == acknowledged => \A s \in Scopes : ~feed[s] /\ ~snapshot[s]
NoOpenDuringDelete == ~badOpen
FenceCount == fence = Cardinality(Active)
ReconnectReadAbsent == (acknowledged /\ rebuilt) => ~rebuiltRow
RestoredDeletedAbsent == (tombstone /\ restored) => ~restoredRow
\* END FROZEN PROPERTIES

NeverOldReadAfterDelete == ~(acknowledged /\ \E s \in Scopes : \E r \in Slots : readPc[s][r] = "ready" /\ readRow[s][r])
NeverStorageGap == ~(~file /\ ~tombstone /\ fence > 0)
NeverOverlap == ~(fence = 2)
NeverFailed == ~(\E d \in Deletes : dpc[d] = "failed")
NeverRebuilt == ~(acknowledged /\ rebuilt)
NeverLateReplyAndFreshRead ==
    ~(shared.lateDropped /\ shared.freshAfterLate)
=============================================================================
