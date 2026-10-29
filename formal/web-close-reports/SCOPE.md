# Scope: paired page Files-edit reports and an agent's close

## The promise

Main keeps, per live connection of a paired web page, that connection's latest report of the tab whose Files editor holds unsaved edits; an ended connection's report never counts again; and an agent's close (`ompdesk_session_stop {close}`, auto-close, a failed open's cleanup, Autopilot's source tab) never decides to release a tab a settled live page holds unsaved edits in, nor lets one go while main's store names it dirty.

## The harm

A released tab closes its Files editor with the person's unsaved edits in it, or (the other way) a dropped page's stale "dirty" keeps a finished child open forever. This area regressed five times (eb63a456, fb2f902, b2c22f84, 0f9382b8, 09f8b6af): per-window reports, forgetting the whole window on one drop, a stale report outliving its connection.

## Why tests miss it

The bugs live in orders: a reload overlapping its predecessor, a drop between a frame's read and its handling, a reconnect's open report racing an edit. Unit tests pick a few orders; the model checks all of them within the bounds.

## Bounds

2 pages sharing one window, 2 tabs, 2 connections per page (one reconnect each), at most 3 editor changes, at most 2 report frames in flight per connection; any interleaving. 1,192,923 distinct states, depth 25, about 30 s (`MC.cfg`).

## In the model

`FileEditReporter` (send on change and on `open`), `WsRouter` attach, receive and detach, `onConnectionEnded` → `FileEditReports.forget`, the `FILE_EDIT_REPORT` handler → `report`, `edits`, `tabCloseStep`, `#closeTab`'s decision and the release after its awaits with its re-check (`stillClosable`).

## Not in the model

- Several windows (devices): the store keys reports by connection and filters by window; cross-window isolation is pinned by `file-edit-reports.test.ts` (every order of up to 5 events over 3 connections in 2 windows).
- `looked` / `userTouched` (the person at the tab), the desktop window path (`ask-window`), the close note, `#whenGone`.
- An unpair: it ends every connection of the device (`closeDevice`) before the window goes, which is the model's `Drop` per connection.
- The page side's own transport: a send while the page is not `open` is lost; the model sends only from a greeted connection and resends on `open`.
- Liveness (that a close eventually happens): safety only.
