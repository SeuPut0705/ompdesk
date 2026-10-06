# Changelog

## [0.1.0] - Unreleased

First release of **seucode** (formerly omp GUI) as its own project. Derived from [nornzach/oh-my-pi-gui](https://github.com/nornzach/oh-my-pi-gui) 0.9.16 (MIT); rebuilt to run on the user's stock omp instead of a bundled fork.

### Identity

- New name and mark: the app is **seucode** (bundle id `com.seuput.seucode`, installers `seucode-<version>-…`, stable download names `seucode-mac-arm64.dmg`, `seucode-mac-x64.dmg`, `seucode-windows-setup.exe`, `seucode-windows-portable.exe`). The agent it drives is still omp. One S-shaped mark (an ink arc handing over to an accent arc) renders the app icon, the menu-bar/tray icon and the in-app logo.
- The app's data directory follows the new name (`~/Library/Application Support/seucode`, `%APPDATA%\seucode`), so window layout and GUI preferences start fresh; omp's own settings, logins and sessions in `~/.omp` are unaffected.

### Runtime

- Drives the **system-installed omp** (`omp --mode rpc-ui`); `omp update` updates the agent the GUI uses. Requires omp **18.6.0** or newer; a missing or outdated omp shows an install/update hint.
- GUI features stock omp's RPC does not cover run in the Electron main process (git/gh, files, `~/.omp` config, `omp` CLI) or through `gui-bridge`, an omp extension the GUI loads with `-e` for live-session state. No omp fork, no bundled agent binary.
- Stats run the user's omp-stats server without opening a browser and add the paginated request list the Requests page needs.
- macOS (arm64 + x64 from one config) and Windows only; Linux packaging removed.

### Added

- Korean UI: renderer, settings, menus, tray, dialogs. The language switcher cycles EN → 中文 → 한국어; with no saved choice the UI follows the OS locale.
- Composer redesign: one calm field with a single toolbar at every width — a **+** menu (attach images, prompt history ⌃R, expand ⌃G), a **mode chip** (Plan · Goal · Loop · Vibe with inline config in one popover; replaces the Modes window), **Run settings** (thinking level, fast mode, tool approval and the advanced behavior toggles in one popover), the model chip showing the model's display name, a context ring with the share used, and send / stop. ⌃G now expands the composer in place over the session instead of opening a full-screen editor dialog (external-editor round-trip kept). Image files can be dropped on the composer. The field has an accessible name and new or empty sessions focus it.
- omp compatibility self-check: when a sidecar's `gui-bridge` connects, the GUI asks once per omp version which bridge features this omp's internals can no longer serve (plan mode, MCP, settings, …) and shows a dismissible warning naming them, with an `omp update` / report-an-issue hint. A bridge that fails to connect at all gets the same warning instead of only a log line. The affected commands fail with a coded `unsupported_omp` (or `bridge_unavailable`) error naming the feature instead of a raw TypeError, and one broken bridge module no longer takes the others down.
- Transcript redesign: the answer reads at body size, your prompt is a compact bubble whose actions appear on hover without reserving space, and finished work collapses into a plain summary ("Read 2 files · Edited 1 file · Ran 1 command · 16s"). Each step shows a human label, the file name first, and a `+N −M` diff stat for edits; thinking is one quiet row. Failed responses say what happened in your language with Try again / Change model / Open providers / Compact context; a stopped response is a neutral "Stopped" note, and slow or retrying waits offer Change model and Stop response.
- First run is an inline setup in the empty session instead of a dialog: pick a provider (search, recommended first), sign in or paste an API key right in the list (the key field is masked), or add an OpenAI/Anthropic-compatible endpoint with an inline form; then choose the default model, optionally verified with one short test request. "Set up later" leaves it for Settings › Models & providers.
- Providers & login moved to Settings › Models & providers (`/providers`, `/login`, `/logout`, `/add-provider` and the menu open it): one searchable list with connected providers first, a short recommended set, and the long tail collapsed; "Connect" is a quiet row action instead of 80 primary buttons. Custom endpoints are added and edited inline (no stacked dialogs), with human protocol names and the rarely used options under "Advanced".
- Model picker: connected providers first with their display names, each model's context window (small ones flagged), and a link to manage providers. The pick also becomes the default for new sessions, as omp's own `/model` picker does.
- Command palette (⌘K): sections follow the app's layout (Session, Agents, Insights, Models, … Settings, Help) with one icon per section, shortcuts shown for the platform, and a key hint footer. Search ranks exact, then prefix, then word-start, then substring matches, understands Korean typed mid-syllable or as initial consonants ("트리", "틀", "ㅌㄹ" all find 세션 트리), and lifts recently used commands. Enter never runs a turn-starting or destructive command (retry, resend, clear, delete, compact, quit, a slash command sent to the agent, …) off a partial match: it asks for a second Enter unless the query names the command exactly or you picked it with the arrow keys.
- One name per concept across English, Korean and Chinese (session, project, side panel, command palette, plan mode, steer, follow-up, subagent, background job, Insights, …), sentence-case labels without baked-in shortcuts, and error messages that say what to do next. Korean messages use 해요체; leftover English in Korean and Chinese is translated.

### Fixed

- New sessions could start on Apple's on-device model (8k context) even with a configured provider, and the model changed between launches: with no saved default, omp prefers a known provider's catalog default and Apple only becomes available once its discovery is cached (launch 2+). The GUI now saves the default model (from first-run setup and the model picker) and, when none is saved, starts on a connected model that can hold a coding session, never a keyless or too-small one.
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
- Windows: a setting changed in the GUI could silently snap back to its previous value right after another setting was saved: omp's save took its own just-written config.yml for an external edit and dropped the change. The GUI now checks that the change was kept and applies it once more if not.
- Startup parsed about 11 MB of JavaScript, including all of mermaid, because the bundler had placed its dynamic-import helper in the mermaid chunk. Mermaid, KaTeX (and its stylesheet), the raw-HTML markdown step, CodeMirror and the todo list's drag-and-drop now load the first time they are needed; startup loads about 3.2 MB. Content that needs one of them shows plain text (TeX source, no embedded HTML, a spinner in the editor) for the moment the chunk takes to load.

### Removed or narrowed compared to the fork-based GUI

- Live session sharing (collab host/join/leave) from the GUI. `omp` in a terminal still offers it.
- Re-answering a past `ask` from the session tree.
- Reordering queued messages within a lane. Editing a queued message or moving a steer to follow-up re-queues it at the lane's end, text only.
- Job result previews in the jobs dialog; the shake summary arrives as command output; share uploads are not trimmed before upload.
- `abort_subagent` cancels only running subagents stock omp lists for the session.
