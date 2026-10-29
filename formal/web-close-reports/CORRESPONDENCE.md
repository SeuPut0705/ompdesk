# Correspondence: WebCloseReports.tla ↔ code

| Model | Code | Atomic because |
|---|---|---|
| `Edit(p, v)` | `src/renderer/web/FileEditReporter.tsx` effect on `fileEditDirty`/`fileEditTabId`/`activeTabId` → `reportFileEdits` | one React effect run; the frame joins the socket's FIFO |
| `Connect(p)` | `WsRouter.attach` (a new `WsConnection`, `connId = randomUUID()`) | synchronous attach |
| `Greet(p)` | `FileEditReporter`'s `onConnectionState("open")` → send | the page's own effect, after the hello |
| `Drop(c)` | `WsConnection.#finish` → `WsRouter.detach` → `onConnectionEnded` → `web-host.ts` → `index.ts` `fileEditReports.forget(connId)` | one synchronous call chain, no `await` |
| `Deliver(c)` | `WsConnection.receive` (refuses after `#closed`) → `#invoke` → `#dispatch` → `registry.invoke` → `ipc.ts` `FILE_EDIT_REPORT` → `FileEditReports.report` | no `await` before the handler for a frame without picture blocks; the handler accepts only that shape (`parseFileEditReport`: exactly one `{dirtyTabId}`), so a frame whose upload `#dispatch` awaits is refused (pinned: `ws-router.test.ts` "hands a Files-edit report to main within the frame…" and "never lets a report outlive its connection, even one whose arguments carry a picture…") |
| `Write` / `Forget` | `FileEditReports.report` / `forget`: one connection's entry | Map set/delete |
| `Edits(t)` | `FileEditReports.edits` | pure read |
| `CloseStep(t)` | `tabCloseStep` (`src/main/agent-control/tab-close.ts`) minus `looked`/`userTouched` | pure |
| `CloseDecide(t)` | `AgentControl.#closeTab` reads `host.tabs()` (each tab's `webEdits` from `edits`, `host.ts` `#controlTab`) and applies `tabCloseStep` | synchronous until `await host.release` |
| `CloseRelease(t)` | `host.release` → `closeWindowTab` → `await refreshExitPolicy` → `SidecarPool.releaseTab` | split from the decision: there are awaits in between |

## Abstractions that could hide a bug

- One window: the store's window filter is not exercised here (unit-tested instead).
- Frames are FIFO per connection and never duplicated (a WebSocket).
- `Greet` sends from the page's current editor state; the real page sends `fileEditTabId ?? activeTabId` when dirty, which the model folds into `edit[p]`.
- The `SplitDispatch` switch is how the model says "no `await` before the handler"; the code keeps it because `#dispatch` awaits only a frame with picture blocks (or `FS_UPLOAD_TO_HOST`), and `parseFileEditReport` refuses any report but exactly one `{dirtyTabId: string | null}`, which holds none.

## Suspected gap (accepted, not reproduced)

`NoLateDirtyRelease` fails by design (`MC_late.cfg`): a dirty report that lands after `#closeTab` decided and before `releaseTab` ran (during `refreshExitPolicy`) does not stop the release. It is the same harm class as an edit the page has not yet reported at decision time, which the rule already accepts ("an offline page's tab closes"). Not reproduced in the code; not changed.
