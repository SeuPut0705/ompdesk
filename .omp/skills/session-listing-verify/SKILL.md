---
name: session-listing-verify
description: "Checks that a paired device's session list follows the host's tabs: once events settle, heldOnHost and openedBySession on the device equal what the host holds. Use when changing LocalHostServices.listingChanged, #listing, #listingSnapshot, sessions.list or sessionsChanged in src/main/remote/host-services.ts, the window tabs' session registration in src/main/sidecar-pool.ts (windowSessionFiles, sessionOpeners, #registerSessionFile, #unregisterSessionFile, onSessionFilesChanged, onWindowTabsChanged), or the device feed in src/renderer/stores/session-list.ts (refresh, reconcile, sameRow); or when asked whether a device can show a stale held row."
---

# Session listing verification

## The promise and the harm

After any order of tab open, close and session change on the host and device list reads, once events settle each paired device's list equals the host's current listing: a row says `heldOnHost` exactly when a tab on the host holds the session, and `openedBySession` names the opener the host knows.

If it breaks, a device keeps showing a row as held by a tab that is gone (or hides one that is held) until something else refreshes the list, and nests a child under a wrong or missing opener.

## Coverage

| Check id | Tool | Covers (files and functions) | Model and tags |
|---|---|---|---|
| `session-listing` | TLC 1.8.0 | `src/main/remote/host-services.ts`: `listingChanged`, `#listing`, `#listingSnapshot`, `listingSignature`, `sessionsChanged`, `sessions.list` in `call`, `#createTab`, `#closeTab`, the `session` handler in `#wire`; `src/main/sidecar-pool.ts`: the `sessionInfoUpdate` and `session` handlers, `#registerSessionFile`, `#unregisterSessionFile`, `onSessionFilesChanged`, `windowSessionFiles`, `sessionOpeners`, `#notifyWindowTabsChanged`; `src/main/index.ts`: `sessionOpeners`, `onWindowTabsChanged`, `onSessionFilesChanged`; `src/main/ipc.ts`: the closed-children pref hook; `src/renderer/stores/session-list.ts`: `refresh`, `reconcile`, `sameRow` | `formal/session-listing/tla/SessionListing.tla`; tags `@code` on `Open`, `Close`, `Switch`, `IdChange`, `Reregister`, `Record`, `Tick`, `Compute`, `Emit`, `DeliverReply`, `DeliverEvent`, `DebFire` |

Sync commit: `1cc0239708a810cbdc1683f5be194b968caaea87` plus `syncDiff` `1193c5e4f5…` (stamped with `--stamp --allow-dirty` while the F3 fix was uncommitted: the model is in sync while the covered code equals what was stamped; re-stamp after the commit to drop `syncDiff`). This is the commit at which the verification was last confirmed to describe the covered code. It mirrors `syncCommit` of `session-listing` in `formal/manifest.json`; if they differ, the manifest wins and this line is stale.

## Bounds and assumptions

- Bounds: 2 devices, 1 window tab, 1 hosted tab (opened by the window tab), 2 sessions, at most 3 host changes, queues of at most 3 messages per device, any delivery order; 2.9M states, depth 32 (fast tier, about 30 s). The deep run adds one journal event and queues of 4 (14.8M states, depth 35, about 190 s).
- Assumptions (each is a place a bug could hide): a handler's mutation and its `listingChanged()` call run in one synchronous block; the rows and the snapshot of one `sessions.list` describe the same listing; replies and events may arrive in any order (the queued re-read is redundant if they cannot); `sessionInfoUpdate` with a new id is eventually followed by the `session` identity. The full table is `formal/session-listing/CORRESPONDENCE.md`.
- Not covered: connection loss and reconnect, the feed's release and retain, read errors and the retry backoff, other row fields (`status`, `messageCount`), deleting and renaming sessions, the snapshot cache. `formal/session-listing/SCOPE.md` lists them.

## Run it

`<tools-dir>` is the folder of the SKILL.md that you see when you read `skill://ompdesk-formal-verify`. In CI and on machines without OMPdesk, use a copy of that folder's `scripts/` and `assets/toolchain.json` (see `references/ci-and-drift.md` there).

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only session-listing
```

It takes about 5 minutes (matrix of 4 runs including the deep one, 9 mutations, tag check, drift). Read the result like this:
- `PASS`, exit 0: no counterexample within the bounds above. It does not mean the code is correct.
- `FAIL`, exit 1: a property was violated, a mutation was MISSED, or an `@code` tag no longer resolves. A violation prints a trace with one row per step: the action, its `@code` location and the variables that changed.
- `DRIFT:` note under the drift line: covered files differ from the sync commit, so the model needs another look (CI adds `--strict-drift` and fails on it). A sync commit that is not in this repository fails.
- `NOT CHECKED`, exit 3: the tool could not be prepared (for example offline). Report "not checked". Never report it as a pass.

## Does my change touch this?

It does when it changes the host's listing (`listingChanged`, `#listing`, `listingSignature`, `sessions.list`), who counts as holding a session (`windowSessionFiles`, `#registerSessionFile`, `#unregisterSessionFile`, `onSessionFilesChanged`, a tab's `sessionFile`) or who opened it (`sessionOpeners`, `AGENT_CLOSED_CHILDREN_PREF`), the debounce of `sessionsChanged`, or the device feed (`refresh`, `reconcile`, `sameRow`); or adds code that changes what `heldOnHost` or `openedBySession` would say without calling `listingChanged()`. Search for them: `grep -rn "listingChanged\|heldOnHost\|openedBySession\|windowSessionFiles\|sessionOpeners\|onSessionFilesChanged\|#unregisterSessionFile" src`. If it does, run the check; if the check or the covered code needs to change, go to "Updating the verification for an intended change".

## A failure: real bug or modeling error?

Replay the counterexample against the real code, step by step, using the `@code` location on each trace row. If a step cannot happen in the code, the verification is wrong: fix the verification and say what was wrong. If every step can happen, it is a bug: tell the counterexample as steps in the code's own words, state the harm in one sentence, and report it; a failing test on the unchanged code is the proof (F3 started as one in `src/main/remote/host-services.test.ts`; the pool half is now pinned by `sidecar-pool.test.ts` "announces every take and let-go of a session file"). Never weaken the property or the model, add a state constraint or add fairness to make the check pass. If a change to the property is intended, say so as a model change and cite the evidence.

## Updating the verification for an intended change

1. Change the model from the code, before you rerun: each changed part must again point to code a reviewer can open (`@code` tags in `formal/session-listing/tla/SessionListing.tla`, the table in `formal/session-listing/CORRESPONDENCE.md`). One indivisible step in the code stays one step in the model; a new `await` between a mutation and its `listingChanged()` call splits a step. `Open`, `Close` and `Switch` each stand for a hosted tab (`host-services.ts`) and a window tab (`sidecar-pool.ts`) at once; when a change touches only one of them, split the action by tab kind (`t \in WinTabs` / `t \in HostTabs`) so the model can see it. This is how the scratch break of `#closeTab` dropping its `listingChanged()` call was shown (the run failed on `HeldConverges` with `Close("h1")` on a row tagged `host-services.ts:2237-2265`, and the drift line named `src/main/remote/host-services.ts`).
2. Change a property only when the code's promise changed on purpose. Write down the old wording, the new wording and the evidence (doc comment, tests, changelog, commit message).
3. Keep the bounds unless the change makes them wrong. If you must reduce one, say so.
4. Update `formal/session-listing/tla/mutations.json` so each new guard or step has a mutation that breaks it, and `matrix.json` when a finding is fixed (a run that expects the violation must flip to pass, or move into a mutation as F3's did: `id-change-silent`). Rerun. Then break the new code the way the property guards against and confirm the check catches it.

## Moving the sync commit

Move the sync commit forward only after you confirmed that the verification describes the code at the new commit. Commit the code and the verification change first, then run `bun <tools-dir>/scripts/verify-all.ts formal --only session-listing --stamp`, and copy the new sha into the Coverage section above in the same change. Do not move it for a check that failed, was blocked or was UNAVAILABLE.

## Known findings

- F3 (fixed 28 Oct 2026): the host re-announces by comparing with the snapshot that ANY device's read last recorded, and `sessionInfoUpdate` with another session id unregistered a window tab's session file without calling `listingChanged()`. Device A listed a session as held; the window's omp reported a new session id, so the file left `windowSessionFiles()` silently; device B read the list in that gap (its snapshot had no held session); the tab closed, `listingChanged()` found the listing equal to B's snapshot and said nothing; device A kept the row as held on the host. The fix: the pool calls `onSessionFilesChanged` on every take and let-go of a session file (wired in `index.ts` to `hostServices.listingChanged()`), so every change is announced when it happens and the one shared snapshot never hides a change from any device (`CORRESPONDENCE.md` A7; a per-device snapshot is not needed). Property `HeldConverges`; tests `sidecar-pool.test.ts` "announces every take and let-go of a session file" and `host-services.test.ts` "a device that listed a session as held hears of it when a window's tab lets go of it" (with `control for F3`); the bug stays as the mutation `id-change-silent`. Introduced by commit 8553336d4 (28 Oct 2026, the listing re-announce) on top of the older silent unregister (F-OWN in `sidecar-pool.ts`, present since the first commit).
