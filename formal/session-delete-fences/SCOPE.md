# Session delete fences

## Promise and harm

A deleted session must not return to the deleting consumer's feed or saved snapshot through an older read. A paired `tab.open` that yielded during lookup must not publish a view or sidecar after a delete started or finished. Otherwise a deleted conversation can appear again or be reopened against a removed file.

The model is a candidate TLA+ description, not a checked proof. It targets one saved ID and the file path representing it, two list scopes, two open requests, two delete instances, two read slots per scope, and connection generations 0 and 1. `matrix.json` records the proposed baseline, broken variants, and reachability runs. No state counts, durations, or passing verdict are available.

## Included

- A read that sampled the old shared copy can finish after the delete continuation invalidates each feed generation. The delayed snapshot timer writes the feed's current rows. Both local and global snapshots are forgotten by the successful delete continuation.
- `SessionListShare.current()` captures a wanted generation. A single underlying read can span a delete notification and publish at its earlier generation. A new request must wait for a copy at least as new as its captured wanted generation. One extra unrelated invalidation allows an old underlying read to be pending before deletion.
- The consumer may rebuild once on reconnection and seed from its persisted snapshot. `ReadAnswer` models a reply arriving separately from `ReadFinish`, and neither step is atomic with reconnect. The `NeverLateReplyAndFreshRead` sanity run requires an old pre-delete reply to arrive after reconnect, be dropped by its old consumer, and then a fresh read to be accepted by the rebuilt consumer. The shared source is assumed to be the current numbered host source, including its generation freshness rule. A post-delete layout restore consults the tombstone.
- Opens pass an initial check, then may wait for kind, recorded folder, and directory resolution. The final recheck and new sidecar or host-tab publication are one synchronous region. The already-running view branch is synchronous and includes the check before publication.
- Two deletes can overlap. Each increments the in-flight counter before closing hosted tabs, then awaits local close and storage deletion. The modeled storage removal, index notification, and tombstone continuation are distinct. A rejected close or storage operation releases its own count without inventing a tombstone.

## Exclusions and limits

The list property starts only after the deleting renderer's successful `deleteSession` continuation. It does not claim that another offline renderer immediately forgot its snapshot, or that a host-side tombstone by itself instantaneously clears all remote UI. A reconnect models a released and rebuilt feed, not every in-place link reconnect. `HostSessionList` host-version comparison, delta application, announced-version handling, events in transit, real network reorder and loss, cross-window broadcasts, read retries, and older builds are abstracted out. The paired cache is assumed to invalidate on reconnect and forward its fresh host read to the current numbered-source abstraction. This model does not establish that wiring end to end.

Storage is one Boolean. Sampling represents the result of a store read, not individual directory entries, stock's ID deduplication, another file with the same saved ID, a partial write, or an external writer recreating a file. No claim is made about the actual user's resurrection target or its cause. Tombstone retention eviction, the `AtomicSaver` disk write, process crashes, persistence across restart, and deletion failure after a physical removal but before the promise resolves are outside this model. The post-delete restore samples the in-memory tombstone only. The model does not establish crash durability.

Delete close calls are abstracted to successful or failed await outcomes. It does not model running tabs, exit waits and cleanup failure in detail. A published tab is a single Boolean per request and a successful delete closes it; sidecar execution after publication, asynchronous process cleanup, runtime failures, and error-specific disposal are not modeled. In the synchronous view branch, no other task interleaves between view construction, recheck, dispose on rejection, and publication. Open lookup failures and the missing-directory diagnostic's extra `savedWorktreesForSpawn.find` await are omitted because they terminate rather than publish; the actual check after that await remains part of the source correspondence.

The `ReadStart` and `ReadAnswer` steps split the layered IPC promise conservatively. Some combinations may require impossible microtask scheduling. A TLC counterexample is only a suspected finding until replayed against the actual code, including event-loop ordering and the network. The model adds no fairness, liveness claim, or delivery guarantee. It does not establish that a stalled read, close, or delete eventually completes.

## Integration status

`syncCommit` must remain `null` until source correspondence and every matrix and mutation run have passed on the final candidate. The parent owns the manifest and any project-local verify skill. The existing `session-listing` model addresses `HostSessionList` transport and ordering separately. Its drift is not green for this candidate, and no formal composition with this model is claimed. Its evidence remains unchanged.
