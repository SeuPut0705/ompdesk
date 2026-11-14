---------------------- MODULE SessionDeleteSafety ----------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Scopes, Opens, Deletes, Slots, InvalidateReads, RecheckOpen, Mode
VARIABLES file, tombstone, dpc, fence, acknowledged, detail
vars == <<file, tombstone, dpc, fence, acknowledged, detail>>
Active == {d \in Deletes : dpc[d] \in {"host", "local", "store", "removed", "notified"}}
OpenAllowed == ~tombstone /\ fence = 0

Init ==
    /\ file = TRUE /\ tombstone = FALSE /\ fence = 0
    /\ dpc = [d \in Deletes |-> "unused"] /\ acknowledged = FALSE
    /\ detail = CASE Mode = "open" ->
         [op |-> [o \in Opens |-> "unused"], published |-> {}, badOpen |-> FALSE]
       [] Mode = "list" ->
         [feed |-> [s \in Scopes |-> TRUE], snapshot |-> [s \in Scopes |-> TRUE],
          generation |-> [s \in Scopes |-> 0],
          readPc |-> [s \in Scopes |-> [r \in Slots |-> "unused"]],
          readGen |-> [s \in Scopes |-> [r \in Slots |-> 0]],
          readConn |-> [s \in Scopes |-> [r \in Slots |-> 0]],
          readRow |-> [s \in Scopes |-> [r \in Slots |-> FALSE]],
          connection |-> 0, online |-> TRUE, rebuilt |-> FALSE, rebuiltRow |-> FALSE,
          shared |-> [gen |-> 0, copyGen |-> 0, copyRow |-> TRUE,
                      reading |-> FALSE, sampleGen |-> 0, sampleRow |-> TRUE,
                      bumped |-> FALSE, wants |-> [s \in Scopes |-> [r \in Slots |-> 0]]]]
       [] Mode = "restore" -> [restored |-> FALSE, restoredRow |-> FALSE]

\* @code src/main/session-mutations.ts:46-73 Count before closing hosted tabs.
DeleteStart(d) ==
    /\ dpc[d] = "unused" /\ dpc' = [dpc EXCEPT ![d] = "host"]
    /\ fence' = fence + 1
    /\ detail' = IF Mode = "open" THEN [detail EXCEPT !.published = {}] ELSE detail
    /\ UNCHANGED <<file, tombstone, acknowledged>>
\* @code src/main/session-mutations.ts:46-73 Await the hosted close.
\* @code src/main/remote/host-services.ts:2839-2855 Close hosted tabs and await exits.
DeleteHostClosed(d) ==
    /\ dpc[d] = "host" /\ dpc' = [dpc EXCEPT ![d] = "local"]
    /\ UNCHANGED <<file, tombstone, fence, acknowledged, detail>>
\* @code src/main/session-mutations.ts:46-73 Await the local close.
DeleteLocalClosed(d) ==
    /\ dpc[d] = "local" /\ dpc' = [dpc EXCEPT ![d] = "store"]
    /\ UNCHANGED <<file, tombstone, fence, acknowledged, detail>>
\* @code src/main/session-index.ts:329-338 Remove before the storage continuation.
StorageRemove(d) ==
    /\ dpc[d] = "store" /\ file' = FALSE /\ dpc' = [dpc EXCEPT ![d] = "removed"]
    /\ UNCHANGED <<tombstone, fence, acknowledged, detail>>
\* @code src/main/session-index.ts:329-338,441-444 Notify after storage removal.
\* @code src/main/session-list-share.ts:46-60 Invalidate the shared list.
DeleteNotify(d) ==
    /\ dpc[d] = "removed" /\ dpc' = [dpc EXCEPT ![d] = "notified"]
    /\ detail' = IF Mode = "list" THEN [detail EXCEPT !.shared.gen = @ + 1] ELSE detail
    /\ UNCHANGED <<file, tombstone, fence, acknowledged>>
\* @code src/main/session-mutations.ts:46-73 Commit the tombstone and release the count.
DeleteCommit(d) ==
    /\ dpc[d] = "notified" /\ tombstone' = TRUE
    /\ dpc' = [dpc EXCEPT ![d] = "done"] /\ fence' = fence - 1
    /\ UNCHANGED <<file, acknowledged, detail>>
\* @code src/main/session-mutations.ts:46-73 Failure releases this count without a tombstone.
DeleteFail(d) ==
    /\ dpc[d] \in {"host", "local", "store"}
    /\ dpc' = [dpc EXCEPT ![d] = "failed"] /\ fence' = fence - 1
    /\ UNCHANGED <<file, tombstone, acknowledged, detail>>
\* @code src/renderer/stores/session-list.ts:259-286 Invalidate feeds on acknowledgement.
DeleteAcknowledged(d) ==
    /\ dpc[d] = "done" /\ dpc' = [dpc EXCEPT ![d] = "acked"]
    /\ acknowledged' = TRUE
    /\ detail' = IF Mode = "list" THEN
         [detail EXCEPT !.generation = [s \in Scopes |-> IF InvalidateReads THEN detail.generation[s] + 1 ELSE detail.generation[s]],
                        !.feed = [s \in Scopes |-> FALSE], !.snapshot = [s \in Scopes |-> FALSE], !.rebuilt = FALSE]
       ELSE detail
    /\ UNCHANGED <<file, tombstone, fence>>

\* @code src/renderer/stores/session-list.ts:169-209 Capture the read generation.
\* @code src/main/session-list-share.ts:34-43 Capture the wanted shared generation.
ReadStart(s, r) ==
    /\ Mode = "list" /\ detail.online /\ detail.readPc[s][r] = "unused"
    /\ detail' = [detail EXCEPT !.readPc[s][r] = "waiting", !.readGen[s][r] = detail.generation[s],
                   !.readConn[s][r] = detail.connection, !.shared.wants[s][r] = detail.shared.gen]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/session-list-share.ts:46-60 Invalidate a cached list.
ShareStale ==
    /\ Mode = "list" /\ ~detail.shared.bumped
    /\ detail' = [detail EXCEPT !.shared.gen = @ + 1, !.shared.bumped = TRUE]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/session-list-share.ts:34-43,77-89 Start a shared read and capture its generation.
ShareReadStart ==
    /\ Mode = "list" /\ ~detail.shared.reading /\ detail.shared.copyGen < detail.shared.gen
    /\ detail' = [detail EXCEPT !.shared.reading = TRUE, !.shared.sampleGen = detail.shared.gen, !.shared.sampleRow = file]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/session-list-share.ts:77-89 Publish the captured sample.
ShareReadFinish ==
    /\ Mode = "list" /\ detail.shared.reading
    /\ detail' = [detail EXCEPT !.shared.reading = FALSE, !.shared.copyGen = detail.shared.sampleGen, !.shared.copyRow = detail.shared.sampleRow]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/session-list-share.ts:34-43 Resume once the wanted generation is available.
ReadAnswer(s, r) ==
    /\ Mode = "list" /\ detail.readPc[s][r] = "waiting" /\ detail.shared.copyGen >= detail.shared.wants[s][r]
    /\ detail' = [detail EXCEPT !.readPc[s][r] = "ready", !.readRow[s][r] = detail.shared.copyRow]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/renderer/stores/session-list.ts:169-209 Accept only the captured feed generation.
\* @code src/renderer/stores/session-list.ts:237-251 Release invalidates pending reads.
ReadFinish(s, r) ==
    /\ Mode = "list" /\ detail.readPc[s][r] = "ready"
    /\ detail' = IF detail.readConn[s][r] = detail.connection /\ detail.readGen[s][r] = detail.generation[s]
       THEN [detail EXCEPT !.readPc[s][r] = "done", !.feed[s] = detail.readRow[s][r],
              !.rebuilt = IF detail.connection = 1 THEN TRUE ELSE detail.rebuilt,
              !.rebuiltRow = IF detail.connection = 1 THEN detail.readRow[s][r] ELSE detail.rebuiltRow]
       ELSE [detail EXCEPT !.readPc[s][r] = "done"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/renderer/stores/session-list.ts:115-121 Save the current feed.
SaveSnapshot(s) ==
    /\ Mode = "list" /\ detail' = [detail EXCEPT !.snapshot[s] = detail.feed[s]]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/renderer/stores/session-list.ts:237-251 Abstract release and rebuild, not every reconnect.
Reconnect ==
    /\ Mode = "list" /\ detail.connection = 0
    /\ detail' = [detail EXCEPT !.connection = 1, !.online = TRUE, !.feed = detail.snapshot]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/tab-layout.ts:80-108 Bridge the deleted query to the tombstone.
\* @code native/ompdesk/crates/core/src/pool/layout.rs:156-158,270-277 Filter deleted sessions during restore.
Restore ==
    /\ Mode = "restore" /\ ~detail.restored /\ tombstone
    /\ detail' = [detail EXCEPT !.restored = TRUE, !.restoredRow = ~tombstone]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/remote/host-services.ts:1929-1951,2127-2160 Check and publish a view without another await.
OpenView(o) ==
    /\ Mode = "open" /\ detail.op[o] = "unused" /\ OpenAllowed
    /\ detail' = [detail EXCEPT !.op[o] = "published", !.published = IF detail.published = {} THEN {o} ELSE detail.published]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/remote/host-services.ts:1878-1885 Check before lookup.
OpenStart(o) ==
    /\ Mode = "open" /\ detail.op[o] = "unused" /\ OpenAllowed
    /\ detail' = [detail EXCEPT !.op[o] = "kind"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/remote/host-services.ts:1967-2004 Resume the kind lookup.
OpenKind(o) ==
    /\ Mode = "open" /\ detail.op[o] = "kind"
    /\ detail' = [detail EXCEPT !.op[o] = IF OpenAllowed THEN "cwd" ELSE "refused"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/remote/host-services.ts:1967-2004 Resume the folder lookup.
OpenCwd(o) ==
    /\ Mode = "open" /\ detail.op[o] = "cwd"
    /\ detail' = [detail EXCEPT !.op[o] = IF OpenAllowed THEN "directory" ELSE "refused"]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>
\* @code src/main/remote/host-services.ts:1967-2004,2127-2160 Recheck and publish synchronously.
OpenPublish(o) ==
    /\ Mode = "open" /\ detail.op[o] = "directory"
    /\ LET allowed == IF RecheckOpen THEN OpenAllowed ELSE TRUE IN
       detail' = [detail EXCEPT !.op[o] = IF allowed THEN "published" ELSE "refused",
                 !.published = IF allowed /\ detail.published = {} THEN {o} ELSE detail.published,
                 !.badOpen = (detail.badOpen \/ (allowed /\ detail.published = {} /\ ~OpenAllowed))]
    /\ UNCHANGED <<file, tombstone, dpc, fence, acknowledged>>

Next ==
    \/ \E d \in Deletes : DeleteStart(d) \/ DeleteHostClosed(d) \/ DeleteLocalClosed(d) \/ StorageRemove(d) \/ DeleteNotify(d) \/ DeleteCommit(d) \/ DeleteFail(d) \/ DeleteAcknowledged(d)
    \/ \E s \in Scopes : \E r \in Slots : ReadStart(s, r) \/ ReadAnswer(s, r) \/ ReadFinish(s, r)
    \/ ShareStale \/ ShareReadStart \/ ShareReadFinish
    \/ \E s \in Scopes : SaveSnapshot(s)
    \/ Reconnect \/ Restore
    \/ \E o \in Opens : OpenStart(o) \/ OpenView(o) \/ OpenKind(o) \/ OpenCwd(o) \/ OpenPublish(o)
Spec == Init /\ [][Next]_vars
NoFeedReinsert == acknowledged => \A s \in Scopes : ~detail.feed[s] /\ ~detail.snapshot[s]
NoOpenDuringDelete == ~detail.badOpen
FenceCount == fence = Cardinality(Active)
ReconnectReadAbsent == (acknowledged /\ detail.rebuilt) => ~detail.rebuiltRow
RestoredDeletedAbsent == (tombstone /\ detail.restored) => ~detail.restoredRow
=============================================================================
