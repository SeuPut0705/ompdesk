# Correspondence: tab-session

| Model | Code | Atomic because |
|---|---|---|
| `OpenOf` | `native/ompdesk/crates/core/src/sidecar/launch.rs` `session_open` | pure function |
| `Spawn` | `Lane::launch` and `start_process` (`sidecar/lane.rs`): `session_open` is read when the launch ask is made, main answers how to start, the process starts in the lane's next step | the lane applies one message at a time; main's answer is the only wait, and a stale one is dropped (`is_live`) |
| `Ready` | `Lane::handle_ready`: the `ready` frame | one message of the lane |
| `Observe` | `Lane::observe` for `get_state` (the lane's own `get_state` that gates `ready`; the pool's `session` handler hears the same answer through `sidecar.session`/`sidecar.tabSession`) | one message of the lane |
| `Crash` | the child's exit (non-zero), `Lane::on_child_exit` and `attempt_restart`'s timer calling `spawn` | nothing writes the session state between them |
| `Restart` | `Lane::restart` (`sidecar.restart`) / `restart(undefined, entry.sessionFile)`: machine setup (`index.ts` `followSetupState`, `onOmpReady`), `desktop-slot-host.ts` `#kill`, `SidecarPool.restartOnNewOmp`, ipc `SIDECAR_RESTART` | one message of the lane: kill, state, `start` |
| `Open(f)` | `sidecar.restart {resumeSessionPath: f}` with a stored session | as above |
| `Move` | `sidecar.restart {cwd}`: ipc `SIDECAR_SELECT_PROJECT` / `SIDECAR_SET_PROJECT` | as above |
| `GateMove` | the start gate (`Lane::on_gated`, main's `worktree-lifecycle.ts` resolves a worktree cwd): `is_new = true; restart(cwd)`; once, for a new tab's first spawn, before its ready status (a local command's get_state may already have named the session) | one continuation after the gate's await |
| `Switch(f)` | `Lane::observe` for a successful `switch_session` (sidebar open in the same tab, `local/sessions.ts`): `session_path = command.sessionPath`; the pool takes the same path (`ipc.ts` `noteSessionFile`) | one response handler |
| `NewSession` | `Lane::observe` for a successful `new_session`: `session_path = None; is_new = true` | one response handler |
| `Write` | stock writes a new session's file at its first assistant message | environment |
| `default` branch of `Spawn` | stock's `autoResume` (the person's config) or a new session | environment |

## Assumptions (each a place a bug could hide)

- A1: `start`'s wait for main's `sidecar.resolve` answer (omp, proxy, shell env, builtin extensions, `sessionFree`) does not change `session_path` or `is_new`: it only gates when `spawn` runs (a restart in between supersedes it by `start_seq`).
- A2: the `get_state` answer names the session the running omp is on (stock `get_state.sessionFile`), written or not.
- A3: stock's `autoResume` picks only a written session of the tab's folder.
- A5: a `fork`, `branch` or `handoff` inside the omp (also `SESSION_CHANGING_COMMANDS`) keeps `session_path` on the session it came from until the next `get_state` names the copy; a crash in between reopens that parent session. Not modeled: its file is the conversation the copy was made from, written and intact, so nothing is lost and no other conversation opens; the renderer's hydrate sends that `get_state` right after the command. Starting a new one instead would put the tab on an empty session, further from what it showed.
- A4: `entry.sessionFile` (the pool) equals the lane's `session_path` after the same `get_state`; an omp update's restart therefore reopens what `Restart` does.
- A6 (H2, Nov 2026): the lane is not a hub instance: it applies one message at a time on its own thread (`Lane`'s inbox), as the table says. What H2 changed in `sidecar/lane.rs` is a copy of each event for in-core subscribers (`super::tap`/`untap`, next to every send to main) and `std::mem::take` for the barrier lists; no lane state the model reads (`session_path`, `is_new`, process state) is touched, and the steps shifted by two lines only (the tags follow the functions by name, `formal/retag-core.ts`). The pool's tab learns the session from `feed_session` (`pool/listen.rs`), which main calls when the sidecar emits `session`/`sessionInfoUpdate`: one hub job per event (`hub/mod.rs` header: a call runs to its end, its woken continuations after it, before the next job), after the lane's message that made it. A4 therefore reads: the pool's file follows the lane's by one main-to-hub call, and nothing the model checks (a spawn's `session_open`) reads the pool's copy.
