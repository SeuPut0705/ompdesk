# Correspondence: WebCloseReports.tla ↔ code

| Model | Code | Atomic because |
|---|---|---|
| `Edit(p, v)` | `src/renderer/web/FileEditReporter.tsx` effect on `fileEditDirty`/`fileEditTabId`/`activeTabId` → `reportFileEdits` | one React effect run; the frame joins the socket's FIFO |
| `Connect(p)` | the core's router `Host::attach_conn` (`web/router.rs`; a new connection, `connId` a random UUID) | under the router's lock |
| `Greet(p)` | `FileEditReporter`'s `onConnectionState("open")` → send | the page's own effect, after the hello |
| `Drop(c)` | the core's `Host::finish` (the connection leaves the router, then `web.conns` `end`) → main's `WsRouter.connections` → `onConnectionEnded` → `web-host.ts` → `index.ts` `fileEditReports.forget(connId)` | the core refuses the connection's frames from the moment it ends; main runs the event's chain synchronously, after every `web.call` the core sent before it (one ordered stream) |
| `Deliver(c)` | the core's `Host::receive` (refuses an ended connection) → `Host::dispatch` → `web.call` → main's `WsRouter.call` → `#dispatch` → `registry.invoke` → `ipc.ts` `FILE_EDIT_REPORT` → `FileEditReports.report` | no `await` before the handler for a frame without picture blocks; the handler accepts only that shape (`parseFileEditReport`: exactly one `{dirtyTabId}`), so a frame whose upload `#dispatch` awaits is refused (pinned: `ws-router.test.ts` "hands a Files-edit report to main within the frame…" and "never lets a report outlive its connection, even one whose arguments carry a picture…") |
| `Write` / `Forget` | `FileEditReports.report` / `forget`: one connection's entry | Map set/delete |
| `Edits(t)` | `FileEditReports.edits` | pure read |
| `CloseStep(t)` | `tabCloseStep` (`src/main/agent-control/tab-close.ts`) minus `looked`/`userTouched` | pure |
| `CloseDecide(t)` | `AgentControl.#closeTab` reads `host.tabs()` (each tab's `webEdits` from `edits`, `host.ts` `#controlTab`) and applies `tabCloseStep` | synchronous until `await host.release` |
| `CloseRelease(t)` | `host.release` → `closeWindowTab` → `await refreshExitPolicy` → `stillClosable()` (`tabCloseStep` on the store now) → `closeTabTerminals` → `SidecarPool.releaseTab` | split from the decision (awaits in between); the re-check and the release are one synchronous run |

## Abstractions that could hide a bug

- One window: the store's window filter is not exercised here (unit-tested instead).
- Frames are FIFO per connection and never duplicated (a WebSocket).
- `Greet` sends from the page's current editor state; the real page sends `fileEditTabId ?? activeTabId` when dirty, which the model folds into `edit[p]`.
- The `SplitDispatch` switch is how the model says "no `await` before the handler"; the code keeps it because `#dispatch` awaits only a frame with picture blocks (or `FS_UPLOAD_TO_HOST`), and `parseFileEditReport` refuses any report but exactly one `{dirtyTabId: string | null}`, which holds none.

## Closed gap: a report during the release's awaits

Before `stillClosable`, a dirty report that landed after `#closeTab` decided and before `releaseTab` ran (during `refreshExitPolicy`) did not stop the release (`NoLateDirtyRelease` failed, 7 steps). `closeWindowTab` now asks `stillClosable` right after that await, and `AgentControlHost.release` builds it as `tabCloseStep` on the store's word at that moment; nothing awaits between the re-check and `releaseTab`. The `no-recheck-before-release` mutation puts the gap back and must be detected.
