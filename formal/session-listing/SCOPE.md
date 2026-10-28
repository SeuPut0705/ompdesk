# Scope: session listing, host re-announce and device refresh

Model: `tla/SessionListing.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`.

## The promise and the harm

After any order of tab open, close and session change on the host and device list reads, once events settle each paired device's list equals the host's current listing: a row says `heldOnHost` exactly when a tab on the host holds the session, and `openedBySession` names the opener the host knows.

If it breaks, a device keeps showing a row as held by a tab that is gone (or hides one that is held) until something else happens to refresh the list, and nests a child under a wrong or missing opener.

Why tests miss it: no journal moves when a tab opens, closes or changes session, so the only thing that tells a device is `listingChanged()` comparing a shared snapshot. Whether it speaks depends on what other devices read in between, which a one-device test never does.

## In scope

- `LocalHostServices.listingChanged()` / `#listing()` / `#listingSnapshot` / `sessionsChanged()` debounce / `sessions.list` (host-services.ts).
- The window tabs' side that feeds `windowSessionFiles()` and `sessionOpeners()` (sidecar-pool.ts): the notify at acquire/release/`session` identity, and the one silent step (`sessionInfoUpdate` with another `sessionId` unregisters the file).
- The closed-child record that `sessionOpeners()` merges (index.ts), as an input that changes openers with no tab event.
- The device feed: `refresh()` (one read in flight, one queued), the 350 ms debounce, `reconcile`/`sameRow` (session-list.ts).

## Abstracted

- Two devices, one window tab, one hosted tab (the hosted tab was opened by the window tab), two sessions, at most 3 host changes (open, close, switch, id change, closed-child record) per run; 2 devices because one device cannot show the snapshot being shared.
- A device's two feeds (`local`, `global`) read the same host snapshot like two devices do; the model uses separate devices for it.
- The index rows (`sessionIndex.list`) are not modeled: only the overlay the property is about (`heldOnHost`, `openedBySession`). `childProblem` is announced by its own `sessionsChanged()` call and is not in the listing signature.
- `reconcile` keeps a row object when `sameRow`; the model assigns the reply to the view, and the mutations `sameRow-ignores-*` stand for a `sameRow` that forgot a field.

## Out of scope (not checked)

- Connection loss, reconnect and the device's own list reload (a reconnect reads fresh); `retain`/release of the feed; read errors and the retry backoff.
- Rows' other fields (`modified`, `size`, `title`, `kind`, `status`, `messageCount`): `sameRow` does not compare `status`, `messageCount`, `firstMessage` or `parentSessionPath`; whether that can leave a stale row is not examined here.
- Deleting or renaming a session on the device, the snapshot cache (`snapshots()`), several windows of one device.
- The per-device `device` filter of `SESSIONS_CHANGED`.
- Time: debounces and timers are abstract delays; only their order against other events is modeled.
