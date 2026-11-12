# Correspondence: SessionProcesses.tla ↔ code

| Model | Code | Atomic because |
|---|---|---|
| `Start(s)` | `SidecarManager.#launch` → `SessionProcesses.open` (`src/main/session-processes.ts`): the first left entry of the session, else a new tag | synchronous; the spawn that follows already carries the tag |
| `LeftOf(s)` | `#left`: entries in state `left` with that session file (and the same hosted/local kind) | pure read |
| `Spawn(s)` | the tab's omp, or anything under it, starts a process: the tag is in its environment (`sessionEnv`, `SESSION_TAG_ENV`) | the environment is copied at the process's creation |
| `Dispose(s)` | the pool's `release_entry` (`pool/windows.rs` in `native/ompdesk/crates/core/src/`; the TypeScript `SidecarPool` is its client) / `LocalHostServices.#closeTab` → `SidecarManager.dispose` → (after the omps' exits) handle `close`; the pool's `released` activity → `sessionReleased` | both mark their entries `ending` synchronously; the model folds the wait for the omp's exit into the step, since nothing reads the entry meanwhile but `open`, which sees `live` until `close` runs and `ending` after |
| `Frozen` | `deps.frozen()` = `quitApproved()` (`src/main/index.ts`) | read at the close |
| `End(tags)` | `#endEntry`: `state = "ending"`, then the core's `procs.end` | the mark is synchronous; the request is the step `EndOk`/`EndFail` answers |
| `EndOk(t)` | `procs.end` killed what carried the tag and answered; `#endEntry` deletes the entry | the core answers once the processes are gone; the entry stays `ending` until then |
| `EndFail(t)` | `procs.end` threw (the core restarting, a timeout), or answered `kept` or `left` (something with the tag still runs): `#endEntry` puts the entry back as `left`; in the second case it arms one retry (`RETRY_REMAINING_MS`) | one catch block / one branch |
| `Retry(t)` | the retry's timer: `#endEntry` again only when the entry is still `left` and no quit is underway | one timer callback; the model lets a tag be retried any number of times, the code once per launch |
| `QuitBegin` | `quitApproved()` turns true; `persistTabLayouts` stops saving | the latch |
| `Down` | the teardown's last step, or a crash or forced quit at any moment; the core ends with main (stdin EOF), so an end in flight is lost | the process is gone |
| `Boot` | the `SessionProcesses` constructor reads the file (every record `left`); the saved layouts restore their tabs asleep | constructor; restore is synchronous |
| `Sweep` | `index.ts`: `keptSessions` (restored layouts, markers) → `sessionProcesses.sweep` | the marks are synchronous |

## Abstractions that could hide a bug

- **The wait between a tab's release and its close.** `dispose` calls `close` only after the tab's omps exited (up to the stop's grace). Until then the entry is `live` though its tab is gone. A session reopened in that window gets a new tag (`open` finds no `left` entry), which is what the model's atomic `Dispose` gives too. The entry cannot be swept meanwhile (`sweep` takes only `left` entries).
- **A session is its file.** Two entries may name one session (a tab closed with its end in flight, the session reopened, then a crash). The model has both; `open` takes one over, the release ends the other (`sessionReleased` ends every left entry of the session).
- **The file equals the registry's entries.** The deferred write may lag by milliseconds; a crash inside that lag loses a new tag (processes nobody ends) or keeps an ended one (an end that finds nothing).
- **`keep` is exact.** `keptSessions` is read from the sanitized saved layouts and the marker file before `TurnResume.launch`; a tab the restore then fails to create keeps its session's tag until the next launch.
- **Sessions with no file yet** never take a tag over and are not in the model.

## Found while modelling

`sessionReleased` ended only the first entry the last launch left for a session. With two (the double-entry case above), the second stayed in the file with no tab until the next launch (`NoLeakAtRest`). It now ends every one; the mutation `a-released-tab-leaves-what-the-last-launch-left` removes the call and must be detected.

## Timing the model rests on after H2 (Nov 2026)

- `Dispose` is a hub call and a lane message: the pool's `release_entry` (one hub job: the entry leaves `entries`, `gone` goes to main, `release_detached` runs to its end, its asks to main answered inside the job) and then `Lane::dispose` / `when_all_exited` (`sidecar/lane.rs`, one lane message each, which tell main once every omp it stopped has exited). Main's `SidecarManager.dispose` is called from the pool's release after the hub job answered, so the `ending` mark (synchronous in `session-processes.ts`) and the lane's stop are separate steps as before; `open` still sees `live` until `close` runs. The lane edits H2 made (`tap`/`untap`, `mem::take`) shifted the tagged functions by two lines and changed neither `dispose` nor `when_all_exited`.
