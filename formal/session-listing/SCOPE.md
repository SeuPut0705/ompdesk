# Scope: session listing, the host's shared list, its changes and the receivers

Model: `tla/SessionListing.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`.

## The promise and the harm

After any order of tab open, close and session change on the host, of changes to the index's rows (a session appears, is written to, renamed, deleted or moved), of reads, lost messages and link drops, once events settle each paired device's list in each window equals the host's current list: a row exists exactly when the host lists the session, says `heldOnHost` exactly when a tab on the host holds it, and `openedBySession` names the opener the host knows. A session the host deleted does not come back in any receiver's copy, and no receiver applies a change against a version it does not hold.

If it breaks, a device keeps showing a row as held by a tab that is gone (or hides one that is held), a deleted or moved session stays listed or comes back, a child is nested under a wrong or missing opener, or a rename does not show, until something else happens to refresh the list.

Why tests miss it: the host sends what changed, numbered; a receiver's copy is right only if every change reached it in its own order and every one it missed made it read again. The races (a read in flight while a change arrives, a request's `stale()` that another change's apply clears, a lost event, a link drop, two paths to a window with no order between them) need two or three messages to cross, which a test with one device and one change never does. No journal moves when a tab opens, closes or changes session, so for those the host's snapshot comparison (`#listingSnapshot`) is the only announcement, and whether it speaks depends on what other devices read in between.

## In scope

- The host's shared list: `LocalHostServices.#deviceList` (`SessionListShare`: the numbered copy, `changed()`, `stale()`, `current()`, `#publish`), `sessions.list`, `sessionsChanged()` and its debounce, `listingChanged()`, `#listing()`, `#listingSnapshot`, the delta or bare event to each device (host-services.ts, session-list-share.ts, shared/session-list-delta.ts).
- The window tabs' side that feeds `windowSessionFiles()` and `sessionOpeners()` (sidecar-pool.ts), the closed-child record merged by `sessionOpeners()` (index.ts).
- The index's changes as the host sees them (session-index.ts: delete, move, rename's `relist`, the watch's `#notifyChange`) and a device's delete, rename and move through the host (ipc.ts, host-services.ts).
- The paired computer's copy of the host's list: `HostSessionList` (`hostChanged`, `#read`, `stale`), `RemoteDevices` events, link state and `hostSessionsStale` (host-session-list.ts, devices.ts).
- The window's feed: `refresh()` (one read in flight, one queued), the delta handler (note while a read is under way, apply at the held version, ignore the same version, debounce otherwise), the answer, a failed read's retry, `deleteSession`, `renameSession`, `reconcile`/`sameRow` (session-list.ts).

## Abstracted

- Bounds of the runs (CORRESPONDENCE.md A1-A10): one or two devices (each with its computer's copy and one window feed), one hosted tab and at most one window tab, two sessions, at most 3 tab changes or 2 index changes of the kinds above per run, one link drop per device, queues of 3 messages.
- A row is `[journal state 0..1, heldOnHost, openedBySession]` or no row; other fields are not modeled. The index's own shared copy is not a layer: the host's read samples the rows when it ends. A second paired device whose answers go elsewhere is `ForeignRead` (its read still records the snapshot and publishes).
- The link is in order (`LinkMode = "fifo"`: one counted encrypted socket); the two IPC paths to a window have no order between them (`IpcMode = "free"`: events in order, a reply anywhere). In order does not mean a read continues before the next frame is handled: the frames of one drain run between a reply's arrival and its read's continuation (`HostReplyArrive`, `HostReplyResume`, F7). `LinkMode = "gap"` is a run with a link that reorders (a later event passes a reply); it passes now that the continuation drops an older answer (it was F5's counterexample).
- Version numbers are integers: epochs (a host that restarts) are not modeled. Generation counters are a `stale` flag and a clean or dirty read.
- `reconcile` keeps a row object when `sameRow`; the model assigns the answer to the rows, and the mutations `sameRow-ignores-*` stand for a `sameRow` that forgot a field.
- A device's two feeds (`local`, `global`) are not told apart: only the global feed reads the numbered list. The folder's list (`scope: "local"`) is read as it was and not modeled.

## Out of scope (not checked)

- A host that restarts (a new epoch), devices older than this build (they get a bare event and read the whole list; the host's emission to them is one branch of `onChange` that the host tests pin, and their receiver code is not in this repository), the windows of the host's own computer (the same feed over `SessionIndex`'s copy, without a link or the tabs' overlay).
- `retain`/release of the feed and the `generation` counter that drops an answer; read errors' backoff (a failed read retries after any delay); the snapshot cache (`snapshots()`).
- The optimistic part of a window's own delete: it hides the row at once, and an answer that was already on its way lands after it and shows the row until the queued read lands (F6: only the copies and the settled view are checked). A rename's title patch.
- Rows' other fields (`modified`, `size`, `title`, `kind`, `status`, `messageCount`): `sameRow` does not compare `status`, `messageCount`, `firstMessage` or `parentSessionPath`; whether that can leave a stale row is not examined here. The per-device `device` filter of `SESSIONS_CHANGED`, `childProblem`, several windows of one device each with their own copy.
- Time: debounces and timers are abstract delays; only their order against other events is modeled.

## What the fast tier does not cover (30 Oct 2026, after the same-drain read model, F7)

Splitting the host's reply into its arrival and the read's continuation, with the frames of one drain between them, made the state space 4 to 20 times larger (events behind a reply now apply, or are noted, before the read continues). The matrix runs `MC.cfg` (`code-overlay-2-devices`), `MC_two.cfg` (`code-two-devices`) and `MC_deep.cfg` (`deep-with-a-foreign-reader`) are therefore `"tier": "deep"`; `--tier fast` runs `MC_delta.cfg`, `MC_gap.cfg` and the sanity runs. What the deep runs showed on the new model, and what is still open:

- `MC_delta.cfg` (1 device, 2 index changes, 1 link drop; fast): 9,288,934 distinct states, depth 46, no violation (697 s on one worker).
- `MC_two.cfg` (2 devices with symmetry; deep): 27,311,255 distinct states, depth 56, no violation (2,121 s).
- `MC_deep.cfg` (a second device that reads; deep): 22,607,796 distinct states, depth 46, no violation (1,467 s).
- `MC.cfg` (2 devices, 1 window tab, 3 tab changes; deep): NOT FINISHED. It stopped at the 1,800 s limit with 18.6M distinct states seen and no violation, so there is no verdict; it was 2.3M states before the split. `MC.cfg` now has `SYMMETRY DevSym` (devices are interchangeable, as in `MC_two.cfg`); the run with it was not repeated to the end. The window-tab and opener behaviours (`HeldConverges`, `OpenersConverge` with a window tab) rest on the old model's complete run and on the new model's partial one.
- Mutations: only `hsl-keeps-older-answer` (new, detected, `NoReappear`) and `hsl-ignores-announced-version` (no longer equivalent: detected, `ListConverges`) were run on the new model. The other 20 were not rerun, and the baseline of the mutation checker (`MC.cfg`, 4 workers) did not finish in 900 s. The sync commit was not moved for that reason.
- The drain is an over-approximation: any event in the link's queue (up to the queue bound) can run between a reply's arrival and the read's continuation, where the code runs the frames the socket had buffered. The host's own steps are not interleaved inside it (they commute with the computer's synchronous block).
