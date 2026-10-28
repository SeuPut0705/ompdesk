# Correspondence: session-listing

Sync commit: `1cc0239708a810cbdc1683f5be194b968caaea87` plus the `syncDiff` of the uncommitted F3 fix (the commit at which this map was confirmed against the code; the same value as `syncCommit` of `session-listing` in `formal/manifest.json`).

The `@code path:lines` tags in `tla/SessionListing.tla` are the machine-checked half of this map. This table records what each tag abstracts and the assumptions the model relies on.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `Open(t,s)` | `src/main/remote/host-services.ts:1593-1619` `#createTab` + `listingChanged()`; `src/main/sidecar-pool.ts:657`, `#registerSessionFile` `:2059-2068` (`onSessionFilesChanged`) | action | a window tab or a device's tab holds a session; the notify is in the same synchronous block | |
| `Close(t)` | `host-services.ts:2253-2281` `#closeTab`; `sidecar-pool.ts:1799-1800` `#releaseEntry` + `#notifyWindowTabsChanged` | action | | also releases a tab whose file was already unregistered |
| `Switch(t,s)` | `host-services.ts:1678-1686`; `sidecar-pool.ts:980-994` | action | a tab holds another session | |
| `IdChange(t)` | `sidecar-pool.ts:958-970` `sessionInfoUpdate` with another `sessionId` -> `#unregisterSessionFile` `:2070-2078` -> `onSessionFilesChanged` (`src/main/index.ts:1014-1016`) -> `listingChanged()` | action | the file leaves `windowSessionFiles()` and the host compares at once | silent before F3's fix; pinned by `sidecar-pool.test.ts` "announces every take and let-go of a session file" |
| `Reregister(t,s)` | `sidecar-pool.ts:980-994` `session` identity -> `#registerSessionFile` + notify | action | any session, same or another | fair: heartbeat `get_state` |
| `Record` | `src/main/index.ts:900-909` `sessionOpeners` (`AGENT_CLOSED_CHILDREN_PREF`); `src/main/ipc.ts:1266` | action | one boolean: a closed-child record names the opener relation `ClosedPair` | announces via `listingChanged()` |
| `Tick` | `host-services.ts:1258-1265` `sessionsChanged()` | action | a journal write or a child's review changed: an event with no listing change | off in the fast config |
| `Announce(f2, r2)` | `host-services.ts:1272-1279` `listingChanged`; `2295-2297` `listingSignature` | operator | the signature is the whole `[held, openers]` value | mutation `signature-ignores-openers` |
| `Compute(d)` | `host-services.ts:1000-1015` `sessions.list` | action | read `#listing()`, record the snapshot, build the rows, in one block after `await sessionIndex.list` | A2 |
| `Emit` | `host-services.ts:1258-1265` | action | the debounce timer fires and every connected device gets the event | |
| `Refresh(d)`, `DebFire(d)` | `src/renderer/stores/session-list.ts:119-126`, `183-184` | operator, action | one read in flight, one queued | |
| `DeliverReply(d,i)` | `session-list.ts:129-137`, `168-174` | action | the reply replaces the rows | `reconcile`'s `sameRow` keeps old rows only when nothing differs |
| `DeliverEvent(d,i)` | `session-list.ts:180-185` | action | (re)starts the 350 ms debounce | |
| `file, pendReg, rec` | `tab.sessionFile`, `entry.sessionFile` (+ pending id-change handoff), `AGENT_CLOSED_CHILDREN_PREF` | variables | | |
| `snap` | `LocalHostServices.#listingSnapshot` (`host-services.ts:529`) | variable | | shared by every device |
| `ch` | the link between the host and a device | variable | one queue per device; `Ordered` picks the order | A1 |
| `view, inFlight, queued, deb` | the feed's rows, `inFlight`, `queued`, `debounceTimer` (`session-list.ts:107-117`) | variables | | |

## Assumptions

- A1: replies and events reach a device in any order (`Ordered = FALSE`). The code sends them on one connection and forwards them to the renderer on two IPC paths, and enforces no order. Under in-order delivery the device's `queued` re-read is redundant (`evidence/mutation-queued-ordered.log`).
- A2: `Compute` and each tab handler's `listingChanged()` run in one synchronous block (JS is single-threaded): the rows and the snapshot of one `sessions.list` describe the same listing.
- A3: the host announces to every connected device at once (`#conns`); a device connected later reads fresh.
- A4: each device stays connected and holds its feed open (`holders > 0`); reads do not fail.
- A5: a closed or released window tab is a tab on the host; a tab opened by a window tab is a child of it (`Opens`).
- A6: `sessionInfoUpdate` with a new id is eventually followed by the `session` identity (`Reregister` is fair): the code relies on "the renderer's hydrate (get_state) re-registers the current file" (`sidecar-pool.ts:963-968`).
- A7: every change of what a host tab holds calls `listingChanged()` in the block that makes it (the pool's `onSessionFilesChanged` covers each window tab's take and let-go; `LocalHostServices` covers its own tabs). With that, the single shared snapshot always equals the listing at the last announce or read, so any change from what any device last read is announced; a per-device snapshot is not needed.

## Granularity

One action = one event handler or timer. Merged steps: a handler's mutation and its `listingChanged()` call (one synchronous block); a read's `#listing()`, snapshot and row building (one block); the reply's delivery and `reconcile` (one block). The `await sessionIndex.list` inside `sessions.list` is the gap between a device's request and `Compute`.
