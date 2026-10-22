# Troubleshooting

[한국어](troubleshooting.ko.md) · [Back to the README](../README.md)

| Symptom | What to check |
|---|---|
| macOS says the app is from an "unidentified developer" | Expected. The build is signed with a self-signed certificate and is not notarized by Apple. In Finder, right-click the app and choose **Open** once. If it stays blocked, allow it in **System Settings › Privacy & Security**. |
| Windows SmartScreen blocks the installer | Choose **More info → Run anyway**. If a company policy blocks it, ask your administrator. |
| I closed the window but the app is still running | By design. Closing the last window only hides it, and running tasks continue. On macOS click the Dock icon; on Windows use the tray icon or start the app again. Quit with ⌘Q, the menu, or the tray menu. With **Continue interrupted work after relaunch** on (the default) it quits without asking and the tasks continue on the next launch; with it off, it asks first if tasks are running. To quit on close on Windows, turn off **Keep running in the tray when closed** in **Settings › General**. A window that is not the last one closes normally. |
| "omp not found" | Open the setup screen or **Settings › Updates & about › This computer**, read the reason, and press **Try again**. If you installed omp yourself, check `omp --version` in a terminal. If it lives somewhere unusual, set the `OMP_GUI_OMP` environment variable to the executable's path. |
| "omp is too old" | OMPdesk runs `omp update` by itself. If that failed, run `omp update` in a terminal and press **Restart**. omp 18.12.6 or newer is required. |
| The app update fails with "rate limit exceeded" | Try again in a minute. An optional GitHub token raises the limit: `GH_TOKEN`, `gh auth login`, or the **GitHub token (optional)** field in **Settings › Updates & about**. See [Updates](updates.md). |
| Pull request features don't work | Open a Git repository, then sign in under **Settings › General › GitHub account** (or check that `gh auth status` shows you signed in). |
| Connecting to another computer says its OMPdesk version is incompatible | The two computers run versions whose connection protocol differs. Update both with **Check for Updates…** in the app menu (or **Settings › Updates & about**), then connect again. **Settings › Devices & connections** names the version each connected computer runs. See [Remote devices](remote-devices.md). |
| A connected computer keeps dropping, or comes back slowly | OMPdesk reconnects by itself: at once when this computer wakes, unlocks, gets its network back or its window comes to the front, and when Tailscale shows the other computer again; every second while the other computer's OMPdesk restarts (an update); otherwise after a wait that grows to 30 seconds. "Reconnecting…" shows only after the link has been down for a few seconds, and work on the other computer keeps running meanwhile. If it never comes back, check that both computers show in `tailscale status` and that the other one runs OMPdesk with sharing on. The `remote-link` lines of the [log](#logs) say when the link dropped and why, each attempt, and how long the outage lasted. |
| A connected computer's tab says "The device running this session is offline" while that computer shows connected | Pressing **Connect** again for a computer that was already connected (Settings › Devices & connections, or an agent's reconnect) left the open tabs on the old connection in OMPdesk 0.61.0 and earlier. Update OMPdesk; until then close the tab and open the session again from the sidebar. If it stays after that, press **Copy diagnostics** in Settings › Updates & about and send it with the report. |
| A task stopped after the computer slept or the network dropped | OMPdesk waits for the connection and retries by itself. Press **Cancel** to stop waiting. |
| Computer use asked for permission on macOS | Computer use is on by default. Grant **Screen Recording** and **Accessibility** to OMPdesk in System Settings. Turn it off for a session with `/computer off`. |
| An MCP server is off, or its tools are missing | **Settings › Tools & extensions › MCP servers** says why on the server's row, with the fix beside it. A server found only in another tool's config (Codex, Claude Code, Cursor…) has **Use in omp**, which copies that one server into omp's own config; one turned off has **Turn on**; one marked **Sign-in needed** has **Sign in**, which opens the sign-in page on the device you are using (if the page then shows a code, paste it into the box OMPdesk opens). Open sessions pick the change up by themselves: there is no need to restart them or to sign in from `omp` in a terminal. |
| A worktree folder of an agent or Autopilot session is gone, or the disk filled up | OMPdesk keeps the disk it fills in check by itself, once a day. Worktrees idle for 3 days lose only what tools make again (build output, installed dependencies). A worktree whose work already landed is removed; one with unlanded work, idle for 14 days with no tab open on it, is saved first: its changes as commits on an `ompdesk/saved/…` branch, files git does not keep (such as an edited `.env`) in a private archive. On Windows, which cannot tell whether a program still works in a folder, only worktrees whose work landed are removed. **Saved worktrees** in the **Work tree** view (command palette, or the last row of the work board's **Child sessions**) puts one back with **Restore**. **Settings › Updates & about › This computer › Disk** shows what is in use and has **Clean up**. |

## Install by hand

OMPdesk installs Bun, omp and Git (on Windows) on first launch. To do it yourself:

```bash
curl -fsSL https://bun.sh/install | bash        # Windows: powershell -c "irm bun.sh/install.ps1 | iex"
bun install -g @oh-my-pi/pi-coding-agent
omp --version
```

## What first launch installs

| Item | How |
|---|---|
| Bun (required) | Bun's official install script, into `~/.bun`. No administrator rights. |
| omp (required) | `bun install -g @oh-my-pi/pi-coding-agent`; `omp update` if it is older than 18.12.6. |
| Git for Windows (Windows, required) | Uses an existing install; otherwise a pinned PortableGit release, verified by SHA-256, unpacked under `%LOCALAPPDATA%\ompdesk\tools\git`. No administrator rights. |
| Git (macOS, optional) | `xcode-select --install`. |
| GitHub CLI, Node.js (optional) | macOS: Homebrew if present, otherwise a checksum-verified archive in OMPdesk's tools folder. Windows: `winget`, which may ask Windows for permission. |

Required items finish first; optional ones install in the background. Status and **Try again** are in **Settings › Updates & about › This computer**.

## Logs

| Log | Where |
|---|---|
| OMPdesk's own errors and restart decisions | `~/Library/Application Support/ompdesk/logs/gui-runtime.jsonl` (Windows: `%APPDATA%\ompdesk\logs\gui-runtime.jsonl`) |
| omp's log | `~/.omp/logs/` (Windows: `%USERPROFILE%\.omp\logs\`) |

**Help › Send feedback** in the sidebar drafts a GitHub issue and can attach the recent OMPdesk errors (never session content). Nothing is sent while you write it; **Continue on GitHub** opens the draft in your browser, which hands its text to GitHub in the page address, so review it there before you post.

**Settings › Updates & about › Copy diagnostics** puts the versions (with those of the paired computers connected now, never their names), how the window draws (software rendering, Reduce motion), the setup state and the last 100 entries of OMPdesk's log (a repeated line shows once, with its count) on the clipboard with secrets, addresses and your user folder hidden (**Preview** shows exactly what is copied; nothing is uploaded). Prefer it to the raw files, which can hold file paths, addresses and other details of your machine: remove anything private before you paste lines from them.

When one session misbehaves, **Save diagnostic bundle** in that session's menu (right-click its row, or the row's ⋯) writes a zip of its transcript, its subagents' transcripts and the last request it sent, plus the **Copy diagnostics** text, to a place you pick. Secrets, addresses and your user folder are hidden in every file, but the bundle still holds the conversation; **Save diagnostic bundle (anonymized)** (or holding Option/Alt) turns the conversation's text into size markers and its paths into mock ones, keeping metadata such as model names and timings. Nothing is uploaded: read the zip before you attach it to an issue.

## Still stuck

Open an [issue](https://github.com/SeuPut0705/ompdesk/issues) with the steps to reproduce, `omp --version` and the **Copy diagnostics** text (or the OMPdesk version, your OS and the relevant lines of the [logs](#logs)).
