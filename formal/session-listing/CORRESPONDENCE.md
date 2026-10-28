# Correspondence: session-listing

Sync commit: `b7d45962525cd52ce08554f6fce5e75cd92c20be` (the commit at which this map was confirmed against the code; the same value as `syncCommit` of `session-listing` in `formal/manifest.json`).

The `@code path:lines` tags in `tla/SessionListing.tla` are the machine-checked half of this map. This table records what each tag abstracts and the assumptions the model relies on.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `Open(t,s)` | `src/main/remote/host-services.ts:1589-1615` `#createTab` + `listingChanged()`; `src/main/sidecar-pool.ts:651` | action | a window tab or a device's tab holds a session; the notify is in the same synchronous block | |
| `Close(t)` | `host-services.ts:2237-2265` `#closeTab`; `sidecar-pool.ts:1792-1793` `#releaseEntry` + `#notifyWindowTabsChanged` | action | | also releases a tab whose file was already unregistered |
| `Switch(t,s)` | `host-services.ts:1674-1681`; `sidecar-pool.ts:973-987` | action | a tab holds another session | |
| `IdChange(t)` | `sidecar-pool.ts:952-963` `sessionInfoUpdate` with another `sessionId` -> `#unregisterSessionFile` | action | the file leaves `windowSessionFiles()`, no notify | the one silent step; pinned by `sidecar-pool.test.ts` "the session under the tab changed" |
| `Reregister(t,s)` | `sidecar-pool.ts:973-987` `session` identity -> `#registerSessionFile` + notify | action | any session, same or another | fair: heartbeat `get_state` |
| `Record` | `src/main/index.ts:900-909` `sessionOpeners` (`AGENT_CLOSED_CHILDREN_PREF`); `src/main/ipc.ts:1265` | action | one boolean: a closed-child record names the opener relation `ClosedPair` | announces via `listingChanged()` |
| `Tick` | `host-services.ts:1254-1261` `sessionsChanged()` | action | a journal write or a child's review changed: an event with no listing change | off in the fast config |
| `Announce(f2, r2)` | `host-services.ts:1268-1275` `listingChanged`; `2279-2281` `listingSignature` | operator | the signature is the whole `[held, openers]` value | mutation `signature-ignores-openers` |
| `Compute(d)` | `host-services.ts:996-1011` `sessions.list` | action | read `#listing()`, record the snapshot, build the rows, in one block after `await sessionIndex.list` | A2 |
| `Emit` | `host-services.ts:1254-1261` | action | the debounce timer fires and every connected device gets the event | |
| `Refresh(d)`, `DebFire(d)` | `src/renderer/stores/session-list.ts:119-126`, `183-184` | operator, action | one read in flight, one queued | |
| `DeliverReply(d,i)` | `session-list.ts:129-137`, `168-174` | action | the reply replaces the rows | `reconcile`'s `sameRow` keeps old rows only when nothing differs |
| `DeliverEvent(d,i)` | `session-list.ts:180-185` | action | (re)starts the 350 ms debounce | |
| `file, pendReg, rec` | `tab.sessionFile`, `entry.sessionFile` (+ pending id-change handoff), `AGENT_CLOSED_CHILDREN_PREF` | variables | | |
| `snap` | `LocalHostServices.#listingSnapshot` (`host-services.ts:526`) | variable | | shared by every device |
| `ch` | the link between the host and a device | variable | one queue per device; `Ordered` picks the order | A1 |
| `view, inFlight, queued, deb` | the feed's rows, `inFlight`, `queued`, `debounceTimer` (`session-list.ts:107-117`) | variables | | |

## Assumptions

- A1: replies and events reach a device in any order (`Ordered = FALSE`). The code sends them on one connection and forwards them to the renderer on two IPC paths, and enforces no order. Under in-order delivery the device's `queued` re-read is redundant (`evidence/mutation-queued-ordered.log`).
- A2: `Compute` and each tab handler's `listingChanged()` run in one synchronous block (JS is single-threaded): the rows and the snapshot of one `sessions.list` describe the same listing.
- A3: the host announces to every connected device at once (`#conns`); a device connected later reads fresh.
- A4: each device stays connected and holds its feed open (`holders > 0`); reads do not fail.
- A5: a closed or released window tab is a tab on the host; a tab opened by a window tab is a child of it (`Opens`).
- A6: `sessionInfoUpdate` with a new id is eventually followed by the `session` identity (`Reregister` is fair): the code relies on "the renderer's hydrate (get_state) re-registers the current file" (`sidecar-pool.ts:957-961`).

## Granularity

One action = one event handler or timer. Merged steps: a handler's mutation and its `listingChanged()` call (one synchronous block); a read's `#listing()`, snapshot and row building (one block); the reply's delivery and `reconcile` (one block). The `await sessionIndex.list` inside `sessions.list` is the gap between a device's request and `Compute`.
