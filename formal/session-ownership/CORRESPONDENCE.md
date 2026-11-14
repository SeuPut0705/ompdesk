# Model and native correspondence

The native `@code` tags identify source ranges read in this checkout. They are provisional until Base wires the service to its pool and confirms the receipt and host-fact contracts. The model is not registered in a manifest in this assignment.

| Model | Native operation and boundary |
|---|---|
| `Open` | `session_ownership/mod.rs:99-155` `acquire(owner, facts)`. Base supplies trusted execution facts. Under the ownership mutex, acquisition rejects a frozen or closed owner, then reuses that owner's live entry, takes a left tag matching session and hosted/local kind, or creates a fresh tag. The model omits repeated acquisition by an already live owner. |
| `Dispose` | `mod.rs:190-201` `closing(owner)` marks the owner closed and its live entry closing under the mutex. For a restored session, the model also queues the work of `mod.rs:310-338` `session_released`, which matches local or hosted kind. These are separate native calls and selection and ending are atomic inside the latter. Base must call `session_released` after an actual release, including a tab that never acquired. |
| `CloseBeforeAcquire` | `mod.rs:190-201` `closing(owner)` records the tombstone even if no tag has yet been acquired. |
| `Exited` | Base must join the exact `Released.exited` receipt captured before lane disposal. This is an assumed environment event, not a call to a hypothetical host `when_exited`. `sidecar/lane.rs:2056-2078` stops the child and waits for all recorded exits. The Base wiring is not modeled as established. |
| `CloseAfterExit` | `mod.rs:204-224` `released(owner)` rechecks freeze under the mutex after the receipt. When frozen it returns with the entry still `Closing`; the next constructor loads the journal as `Left`. Otherwise it marks `Ending` under the mutex before `spawn_end`. The model combines the mark and the pending effect. |
| `Sweep` | `mod.rs:232-276` `sweep` selects and marks left local entries ending under one lock, then starts their effects and schedules hosted grace. `keep` contains restored local sessions and interrupted-work markers. |
| `GraceExpires` | `mod.rs:278-307` `sweep_hosted` checks freeze, left phase, and `Host::hosted_held` while selecting and marking entries ending under one lock. The model's open hosted tab only approximates that host fact. |
| `BeginQueuedEnd` | The model splits selection and mark for local sweep and `session_released`, unlike `mod.rs:232-266` and `310-338`, which select and mark together. This introduces extra takeover, freeze, and callback orders and is not a literal native queue. The model's guards are an overapproximation only under the tab and host assumptions in SCOPE. |
| `EndAnswer` | `mod.rs:340-408` starts `procs::end` and handles the answer. Empty results remove the entry. Left or kept results restore left and schedule at most one retry. An own-only result and a transport error restore left without a retry. The model abstracts simultaneous own plus left or kept as retained. |
| `Retry` | `mod.rs:410-426` rechecks freeze and left state under the mutex before marking ending. A takeover may occur before the timer fires. |
| `Boot` | `mod.rs:49-90` and `journal.rs:11-39` load saved entries as left. The model treats the journal and in-memory entries as identical. |
| `Freeze`, `Down`, `Spawn` | Environment events. Freeze is a latch. Down can interrupt any in-flight work. Spawn represents at least one process inheriting the owner's tag. |

The model's `exited` set is ghost evidence that a captured receipt resolved, retained after the close starts so `PendingCloseProtected` can check it. `allowed` is independent ghost authorization, not a second runtime registry. It is revoked on takeover. `queue` and `retries` model delayed callbacks, not necessarily concrete collections. `alive` records only whether any represented process carries a tag. None of these ghost variables creates an authority issuer or Node policy delegation.

No proof extends through a real file write or process signal. In particular, model atomicity around `Ending` must be compared with every actual mutex unlock and await. A trace is only a suspected defect until reproduced against the native implementation with controlled receipts, timer ordering, and fake process effects.
