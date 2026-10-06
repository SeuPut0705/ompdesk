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
- omp compatibility self-check: when a sidecar's `gui-bridge` connects, the GUI asks once per omp version which bridge features this omp's internals can no longer serve (plan mode, MCP, settings, …) and shows a dismissible warning naming them, with an `omp update` / report-an-issue hint. A bridge that fails to connect at all gets the same warning instead of only a log line. The affected commands fail with a coded `unsupported_omp` (or `bridge_unavailable`) error naming the feature instead of a raw TypeError, and one broken bridge module no longer takes the others down.

### Fixed

- Windows: omp installed under a path with a space (e.g. `C:\Users\First Last\…\omp.cmd`) failed to launch; the shim path is now quoted for every omp spawn.
- With no provider credentials (and no on-device model), stock omp exits at startup with "No models available", so the GUI crash-looped and the first-run onboarding that connects a provider never opened. The GUI now boots omp once on a model from the installed omp's own catalog so onboarding appears.
- Windows: new tab, chat tab, and close tab had no working shortcut (their defaults were ⌘-only). Every ⌘ shortcut now uses Ctrl on Windows (new tab Ctrl+T, chat tab Ctrl+Shift+T, close tab Ctrl+W; thinking toggle moves to Ctrl+Alt+T there), and shortcut labels show Windows key names.
- Opening a tab or switching to a session hydrated the transcript up to three times concurrently; it now loads once per tab and session.
- Opening a session with a long history re-fetched and re-projected the whole history for every transcript page.
- A packaged app ignored the project folder passed on the command line.
- A missing or too-old omp left the window at "Connecting…" with no explanation; the reason and the install/update command now show in the UI language.
- "Remove global override" in settings failed for settings without a default.
- Typed GUI commands stock omp does not advertise (`/plan`, `/loop`, `/goal`, `/vibe`, `/tan`, `/omfg`, `/pause`, `/settings`, …) were sent to the model as text, and slash completion offered a skill instead (`/plan` + Enter → `/skill:…-plan`). They are now listed in completion and run natively; completion ranks exact, then prefix, then substring matches.
- At the minimum window width with 200% zoom (400 CSS px), the session sidebar left the conversation too narrow and the composer's Send button was laid out off-screen. The sidebar now takes at most 40% of a narrow window and the composer toolbar wraps, keeping Send on its own row.
- A transcript following a streaming reply could paint newly streamed text below the fold for a frame or more on a slow renderer before scrolling to it; the follower now pins in the same frame the row is measured.
- With omp 18.6.3, opening a session whose saved model is unavailable still failed after choosing a replacement model in the restore prompt: the GUI switched first and set the model afterwards, but omp now refuses that switch. The chosen model is now passed with the switch (older omp still gets it set afterwards).
- Stats could show "Stats unavailable — This operation was aborted" right after opening on a slow machine (seen on Windows): the GUI gave each stats request 5 s, no more than the stats server's own database lock wait. Requests now get 15 s.

### Removed or narrowed compared to the fork-based GUI

- Live session sharing (collab host/join/leave) from the GUI. `omp` in a terminal still offers it.
- Re-answering a past `ask` from the session tree.
- Reordering queued messages within a lane. Editing a queued message or moving a steer to follow-up re-queues it at the lane's end, text only.
- Job result previews in the jobs dialog; the shake summary arrives as command output; share uploads are not trimmed before upload.
- `abort_subagent` cancels only running subagents stock omp lists for the session.
