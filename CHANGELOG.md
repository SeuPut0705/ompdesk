# Changelog

## [0.1.0] - Unreleased

First release of omp GUI as its own project. Derived from [nornzach/oh-my-pi-gui](https://github.com/nornzach/oh-my-pi-gui) 0.9.16 (MIT); rebuilt to run on the user's stock omp instead of a bundled fork.

### Runtime

- Drives the **system-installed omp** (`omp --mode rpc-ui`); `omp update` updates the agent the GUI uses. Requires omp **18.6.0** or newer; a missing or outdated omp shows an install/update hint.
- GUI features stock omp's RPC does not cover run in the Electron main process (git/gh, files, `~/.omp` config, `omp` CLI) or through `gui-bridge`, an omp extension the GUI loads with `-e` for live-session state. No omp fork, no bundled agent binary.
- Stats run the user's omp-stats server without opening a browser and add the paginated request list the Requests page needs.
- macOS (arm64 + x64 from one config) and Windows only; Linux packaging removed.

### Added

- Korean UI: renderer, settings, menus, tray, dialogs. The language switcher cycles EN → 中文 → 한국어; with no saved choice the UI follows the OS locale.

### Removed or narrowed compared to the fork-based GUI

- Live session sharing (collab host/join/leave) from the GUI. `omp` in a terminal still offers it.
- Re-answering a past `ask` from the session tree.
- Reordering queued messages within a lane. Editing a queued message or moving a steer to follow-up re-queues it at the lane's end, text only.
- Job result previews in the jobs dialog; the shake summary arrives as command output; share uploads are not trimmed before upload.
- `abort_subagent` cancels only running subagents stock omp lists for the session.
