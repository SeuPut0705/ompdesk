# Correspondence: tab-session

| Model | Code | Atomic because |
|---|---|---|
| `OpenOf` | `src/main/omp-launch.ts#sessionOpen` | pure function |
| `Spawn` | `SidecarManager.#spawn` (`src/main/sidecar.ts`), its `sessionOpen` call and `spawn()` | synchronous from the launch to `spawn()` |
| `Ready` | `#handleReady`: the `ready` frame | one frame handler |
| `Observe` | `#observeResponse` for `get_state` (the ready status's `get_state`, `src/main/sidecar-factory.ts`; the pool's `session` handler hears the same answer) | one response handler |
| `Crash` | the child's `exit` (non-zero), then `#attemptRestart`'s timer calling `#spawn` | nothing writes the session state between them |
| `Restart` | `restart()` / `restart(undefined, entry.sessionFile)`: machine setup (`index.ts` `followSetupState`, `onOmpReady`), `desktop-slot-host.ts` `#kill`, `SidecarPool.restartOnNewOmp`, ipc `SIDECAR_RESTART` | synchronous: kill, state, `start()` |
| `Open(f)` | `restart(undefined, f)` with a stored session | as above |
| `Move` | `restart(cwd)`: ipc `SIDECAR_SELECT_PROJECT` / `SIDECAR_SET_PROJECT` | as above |
| `GateMove` | the start gate in `#handleReady`'s `announceReady` (`worktree-lifecycle.ts` resolves a worktree cwd): `#isNew = true; restart(cwd)`; once, for a new tab's first spawn, before its ready status (a local command's get_state may already have named the session) | one continuation after the gate's await |
| `Switch(f)` | `#observeResponse` for a successful `switch_session` (sidebar open in the same tab, `local/sessions.ts`): `#sessionPath = command.sessionPath`; the pool takes the same path (`ipc.ts` `noteSessionFile`) | one response handler |
| `NewSession` | `#observeResponse` for a successful `new_session`: `#sessionPath = null; #isNew = true` | one response handler |
| `Write` | stock writes a new session's file at its first assistant message | environment |
| `default` branch of `Spawn` | stock's `autoResume` (the person's config) or a new session | environment |

## Assumptions (each a place a bug could hide)

- A1: `start()`'s awaits (omp, proxy, shell env, builtin extensions, `sessionFree`) do not change `#sessionPath` or `#isNew`: they only gate when `#spawn` runs.
- A2: the `get_state` answer names the session the running omp is on (stock `get_state.sessionFile`), written or not.
- A3: stock's `autoResume` picks only a written session of the tab's folder.
- A5: a `fork`, `branch` or `handoff` inside the omp (also `SESSION_CHANGING_COMMANDS`) keeps `#sessionPath` on the session it came from until the next `get_state` names the copy; a crash in between reopens that parent session. Not modeled: its file is the conversation the copy was made from, written and intact, so nothing is lost and no other conversation opens; the renderer's hydrate sends that `get_state` right after the command. Starting a new one instead would put the tab on an empty session, further from what it showed.
- A4: `entry.sessionFile` (the pool) equals `#sessionPath` after the same `get_state`; an omp update's restart therefore reopens what `Restart` does.
