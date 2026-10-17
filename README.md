<div align="center">

**English** · [한국어](README.ko.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="resources/brand/wordmark-dark.svg">
  <img src="resources/brand/wordmark-light.svg" alt="OMPdesk" height="64">
</picture>

**The desktop app for the omp coding agent: parallel sessions, autopilot, and your phone.**

<a href="https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-mac-arm64.dmg"><img src="resources/brand/download-macos.svg" alt="Download for macOS (Apple Silicon)" width="280" height="64"></a>
<a href="https://github.com/SeuPut0705/ompdesk/releases/latest/download/ompdesk-windows-setup.exe"><img src="resources/brand/download-windows.svg" alt="Download for Windows (x64)" width="280" height="64"></a>

[![Latest release](https://img.shields.io/github/v/release/SeuPut0705/ompdesk?style=flat-square&color=5B5BD6)](https://github.com/SeuPut0705/ompdesk/releases/latest)
![macOS and Windows](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-5B5BD6?style=flat-square)
[![MIT license](https://img.shields.io/badge/license-MIT-5B5BD6?style=flat-square)](LICENSE)

<sub>An unofficial app for [omp](https://github.com/can1357/oh-my-pi), not affiliated with its authors. The UI is in English and Korean.</sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/hero-dark.webp">
  <img src="docs/media/hero.webp" alt="A prompt to add a dark theme toggle: the agent works through tool steps, two subagents and a todo list on the work board, then reports the result" width="860">
</picture>

<sub>Recorded on a test omp with example files, not real accounts or data.</sub>

</div>

## Why OMPdesk

- **Stock omp, nothing forked.** It runs the omp installed on your computer, with the same settings, logins and sessions as your terminal.
- **Many sessions in parallel.** Split view, git worktrees, and agents that fan work out, compare it and merge the winner.
- **Keep working from anywhere.** Autopilot keeps going, a restart picks tasks back up, and your phone can steer a run.

## Features

<table>
<tr>
<td width="50%" valign="top"><b>Autopilot</b><br>An endless run in its own git worktree: audit, implement, verify, commit, every cycle. Local only unless you choose more. A per-project <code>AUTOPILOT.md</code> guide (drafted for you) sets its direction.<br><a href="docs/media/autopilot.webp"><img src="docs/media/autopilot.webp" alt="Autopilot cycles 1, 2 and 3 landing in the side panel's timeline, then the same run on the work board" width="100%"></a></td>
<td width="50%" valign="top"><b>Parallel sessions and orchestration</b><br>An agent fans work out to sessions in their own worktrees, compares the branches, and merges one after you approve. Nothing is pushed.<br><a href="docs/media/fan-out.webp"><img src="docs/media/fan-out.webp" alt="Three worktree sessions are compared, one approved and merged from the review queue, one discarded" width="100%"></a></td>
</tr>
<tr>
<td width="50%" valign="top"><b>Split view and work board</b><br>Up to four sessions side by side. Each shows its subagents, todos and waiting questions on a live board.<br><a href="docs/media/split-board.webp"><img src="docs/media/split-board.webp" alt="One running session with its work board, then two more sessions dragged in to make a three-pane split" width="100%"></a></td>
<td width="50%" valign="top"><b>Mobile web (beta, off by default)</b><br>Steer a running task from your phone over your own Tailscale network: copy the link and open it on a device signed in to the same Tailscale account. No code, no QR to scan, with opt-in push notifications. <a href="docs/mobile-web.md">Set it up</a>.<br><a href="docs/media/phone.webp"><img src="docs/media/phone.webp" alt="A 390-pixel-wide phone view: a steering message sent to a running session, then the notification opt-in in Settings" width="45%"></a></td>
</tr>
<tr>
<td width="50%" valign="top"><b>Resume after restart</b><br>Quit, crash or update in the middle of a task and the next launch continues it where it stopped.<br><a href="docs/media/resume.webp"><img src="docs/media/resume.webp" alt="OMPdesk quits during a running task and, on relaunch, continues it with a notice" width="100%"></a></td>
<td width="50%" valign="top"><b>Accounts and usage</b><br>Several accounts per provider with live limit gauges, and a model role for every kind of job.<br><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/models-dark.webp"><img src="docs/media/models.webp" alt="Settings, Models and accounts: subscription accounts with their 5-hour and 7-day usage gauges" width="100%"></picture></td>
</tr>
<tr>
<td width="50%" valign="top"><b>Files, Changes, Preview, Terminal</b><br>Code, Markdown, PDF and Office files, diffs, a live preview and a terminal, beside the chat.<br><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/files-dark.webp"><img src="docs/media/files.webp" alt="The right panel's Files view with a TypeScript file open next to the chat" width="100%"></picture></td>
<td width="50%" valign="top"><b>Remote devices</b><br>Run tabs on another computer, with its omp, files and accounts, and steer them from here. <a href="docs/remote-devices.md">How</a>.<br><picture><source media="(prefers-color-scheme: dark)" srcset="docs/media/devices-dark.webp"><img src="docs/media/devices.webp" alt="Settings, Devices and connections: sharing this computer, connecting to a device, SSH hosts and Mobile web" width="100%"></picture></td>
</tr>
</table>

Also in the box: computer use (on by default, one session drives the desktop at a time, `/computer off` to disable), a subagent side panel, and compact headers on code blocks and figures.

## Install

1. **Download** with a button above. macOS: open the DMG and drag **OMPdesk** to Applications. Windows: run the installer.
2. **Launch it.** On first launch OMPdesk installs omp, Bun and (on Windows) Git by itself. No terminal.
3. **Sign in to a model** (a provider login or an API key). A terminal omp login works as is.

macOS first open: the build is signed but not notarized, so right-click the app and choose **Open** once.

Needs macOS on Apple Silicon or Windows 10/11 x64. omp 18.11.0 or newer is installed for you.

## Updates

OMPdesk, omp, the CLIs of your connected accounts, and omp's plugins, skills and MCP servers update themselves while the app is open. Running work is not interrupted, and a restart for an app update continues it after relaunch. No GitHub account or token is needed. [Details](docs/updates.md).

## FAQ

- **Is it the official omp app?** No. It is an unofficial app that drives the omp you have installed; omp itself is never modified.
- **Does it cost anything?** No. It is MIT licensed and needs no account. Your model providers bill you as they do in the terminal.
- **Can the agent control my computer?** Computer use is on by default, and only one session drives the desktop at a time. On macOS it needs Screen Recording and Accessibility granted to OMPdesk. With omp's default tool approval the agent acts without asking: set **Tool approval** to always ask in Settings › Permissions & security, or turn it off with `/computer off`.
- **I closed the window and the app is still running.** By design: tasks continue until you quit (⌘Q or the tray menu).
- **Something else broke.** See [Troubleshooting](docs/troubleshooting.md), or open an [issue](https://github.com/SeuPut0705/ompdesk/issues).

## Privacy

- **Local.** Settings, sessions and accounts stay on the computer that runs omp. Model calls go to your own providers.
- **No telemetry.** OMPdesk collects no usage statistics and switches omp's OTLP export off.
- **Mobile web stays on your tailnet.** It is off by default and reachable only through your own Tailscale network.

## Build from source

Needs Bun, Git and omp 18.11.0 or newer.

```bash
git clone https://github.com/SeuPut0705/ompdesk.git
cd ompdesk
bun install
bun run dev
```

Development, checks and release rules are in [AGENTS.md](AGENTS.md); changes per version in [CHANGELOG.md](CHANGELOG.md). To re-record the media above: `bun run readme:media`.

## Contributing · Security · License

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.txt)

Made by [@SeuPut0705](https://github.com/SeuPut0705)
