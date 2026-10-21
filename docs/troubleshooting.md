# Troubleshooting

[한국어](troubleshooting.ko.md) · [Back to the README](../README.md)

| Symptom | What to check |
|---|---|
| macOS says the app is from an "unidentified developer" | Expected. The build is signed with a self-signed certificate and is not notarized by Apple. In Finder, right-click the app and choose **Open** once. If it stays blocked, allow it in **System Settings › Privacy & Security**. |
| Windows SmartScreen blocks the installer | Choose **More info → Run anyway**. If a company policy blocks it, ask your administrator. |
| I closed the window but the app is still running | By design. Closing the last window only hides it, and running tasks continue. On macOS click the Dock icon; on Windows use the tray icon or start the app again. Quit with ⌘Q, the menu, or the tray menu. With **Continue interrupted work after relaunch** on (the default) it quits without asking and the tasks continue on the next launch; with it off, it asks first if tasks are running. To quit on close on Windows, turn off **Keep running in the tray when closed** in **Settings › General**. A window that is not the last one closes normally. |
| "omp not found" | Open the setup screen or **Settings › Updates & about › This computer**, read the reason, and press **Try again**. If you installed omp yourself, check `omp --version` in a terminal. If it lives somewhere unusual, set the `OMP_GUI_OMP` environment variable to the executable's path. |
| "omp is too old" | OMPdesk runs `omp update` by itself. If that failed, run `omp update` in a terminal and press **Restart**. omp 18.11.0 or newer is required. |
| The app update fails with "rate limit exceeded" | Try again in a minute. An optional GitHub token raises the limit: `GH_TOKEN`, `gh auth login`, or the **GitHub token (optional)** field in **Settings › Updates & about**. See [Updates](updates.md). |
| Pull request features don't work | Open a Git repository, then sign in under **Settings › General › GitHub account** (or check that `gh auth status` shows you signed in). |
| A task stopped after the computer slept or the network dropped | OMPdesk waits for the connection and retries by itself. Press **Cancel** to stop waiting. |
| Computer use asked for permission on macOS | Computer use is on by default. Grant **Screen Recording** and **Accessibility** to OMPdesk in System Settings. Turn it off for a session with `/computer off`. |

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
| omp (required) | `bun install -g @oh-my-pi/pi-coding-agent`; `omp update` if it is older than 18.11.0. |
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

**Settings › Updates & about › Copy diagnostics** puts the versions, the setup state and the last 100 lines of OMPdesk's log on the clipboard with secrets, addresses and your user folder hidden (**Preview** shows exactly what is copied; nothing is uploaded). Prefer it to the raw files, which can hold file paths, addresses and other details of your machine: remove anything private before you paste lines from them.

## Still stuck

Open an [issue](https://github.com/SeuPut0705/ompdesk/issues) with the steps to reproduce, `omp --version` and the **Copy diagnostics** text (or the OMPdesk version, your OS and the relevant lines of the [logs](#logs)).
