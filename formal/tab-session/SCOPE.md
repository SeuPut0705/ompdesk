# Scope: tab-session

## The promise and the harm

Every spawn of a tab's omp opens the session the tab shows: a written session is reopened, a session stock has not written yet or a new tab starts a new session (stock's `autoResume` pinned off), and only a move to another folder leaves the choice to omp.

When it breaks, a crash, machine setup, the desktop slot or an omp update puts the tab on a new empty session (the conversation is left in the sidebar) or, with the person's `autoResume` on, on another conversation of the folder. Tests reach one order of events at a time; the harm sits in orders like "crash after `ready` but before the `get_state` answer".

## Modeled (in scope)

- The session a spawn opens, `sessionOpen` (`src/main/omp-launch.ts#sessionOpen`), as `#spawn` builds it (`src/main/sidecar.ts#SidecarManager.#spawn`).
- `ready` (`#handleReady`), the ready status's `get_state` answer (`#observeResponse`; sent by `src/main/sidecar-factory.ts`), the child's exit and the crash restart (`#attemptRestart`), `restart(cwd?, resumeSessionPath?)` in its three uses: no argument, a stored session, another folder.
- Stock writing a session's file at its first answer (environment), stock's `autoResume` when the spawn names no session (environment: any written session of the folder, or a new one).

## Abstracted

- One tab, one folder; another folder after a move is not modeled (any session there is allowed).
- The pool's view of the tab's session (`entry.sessionFile`) is the ghost `shown`, updated by the same `get_state` answer as `#sessionPath`.
- An omp update's restart (`restartOnNewOmp`) passes the pool's file explicitly; it equals `#sessionPath` once observed, so it is the `Restart` action.
- Boot failures that respawn before `ready` (`#recoverBootModelRestore`, `#recoverNoModelBoot`) keep the state, like a crash before `ready`.

## Out of scope

- The session ownership wait (`sessionFree`, `#whenSessionLetGo`), the start gate's restart into a worktree, `new_session` / `switch_session` inside a running omp (the next `get_state` names it), remote tabs (`RemoteSidecar`), the extensions and settings a spawn carries (`session-launch-parity.test.ts` compares those across start paths).

## Properties

| Name | Kind | Source |
|---|---|---|
| `NoMissingSession` | invariant | `sidecar.ts` comment at `#spawn` ("`--session` on it only fails"), sidecar.test.ts "starts a fresh session in its folder when the session's file was never written" |
| `KeepsSession` | invariant | `.omp/rules/interrupted-work.md` "One conversation stays one session across a relaunch"; a10eb6877 |
| `NeverAnother` | invariant | `resources/gui-bridge/fresh-launch.yml` ("a new tab must open a new session even when the user enabled autoResume") |

## Bounds

| Run | Bounds | States, depth, time |
|---|---|---|
| fast | 1 stored session + 1 other written, 3 new ids, 4 spawns | 2,925, 18, 0.4 s |
| larger | 2 stored + 1 other, 5 new ids, 6 spawns | 61,683, 26, 1.0 s |

## Tools and files

- Tool: TLA+ with TLC: an ordering question over a small state machine (choosing-tools.md).
- Files: `tla/TabSession.tla`, `tla/MC*.cfg`, `tla/matrix.json`, `tla/mutations.json`, `Properties.md`, `CORRESPONDENCE.md`, `evidence/`.
- Manifest id: `tab-session`; covers `src/main/omp-launch.ts#sessionOpen`, `src/main/sidecar.ts#SidecarManager.restart`, `#observeResponse`, `#handleReady`, `#attemptRestart`, `#spawn`.
