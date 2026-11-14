# Schedule model correspondence

| Model action | Native code | Atomic boundary |
| --- | --- | --- |
| `Reserve` | `Engine::reserve`, `Application::settle` | Engine lock records the active reservation before canonical Remote quota is reserved. |
| `Invalidate` | `Engine::command`, `Engine::save`, `Engine::invalidate_pending` | Pause, disable and edit invalidate only work that has not committed. Delete calls the existing stop path. |
| `Reserved` | `Engine::reserved` | A reply to an invalidated reservation refunds and starts nothing. Native Host reserve is synchronous under the same lock; the legacy delayed-response path is also covered by its regression test. |
| `Resolve` | `Application::prepare_run` | `Host::resolve_launch` is pure preparation and may yield. Its cancellation receiver is selected before a simultaneously ready resolution. |
| `Commit` | `Application::prepare_run`, `Engine::launch_allowed` | The final validity check and synchronous supervisor spawn or authenticated wake commit hold one Engine lock. `RunProcess::done` is followed outside that lock. |
| `DuplicateStart` | `Application::prepare_run` | The run-slot map refuses a second start for an already held identity. `Engine::started` also ignores duplicate acknowledgements, so it logs a wake once. |
| `Finish` | `Application::prepare_run`, `Engine::ended`, `Journal::close` | The run is removed and its completion is recorded under the lock. Close stops and awaits native runs, and writes the final journal before returning. |
| `RetireSource` | `Triggers::sync`, `Triggers::close` | The live token is removed before deferred source stop callbacks. A resumed same-key trigger receives a new token. |
| `ReadSource` | Native source task using `SourceContext` | External I/O is outside the application lock. Its reader algorithm and transport are not modeled. |
| `Publish` | `SourceContext::publish`, `Triggers::current` | The generation check, mark save and fire are one locked transaction. Stale callbacks cannot save, fire or report failure. |

Source tokens encode instance identity rather than a revision counter supplied by JSON. `generation` in the model represents the native invalidation bit and identity comparison, not a page field. A committed run is deliberately not cancelled when its schedule is edited or paused; the existing explicit stop and delete paths still stop it.

The standalone artifact probe uses the current Rust Application and current production supervisor with a shell stand-in CLI. It is not proof of Machine, Memory, Hub, Remote or inbox provider integration, NativeCaller authority, a real model response, or the final Node-free app assembly.
