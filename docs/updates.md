# Updates

[한국어](updates.ko.md) · [Back to the README](../README.md)

Everything updates itself. Nothing here needs an account.

## OMPdesk

Use **Check for Updates…** in the app menu or **Settings › Updates & about**. On macOS, keep the app in a writable place such as the Applications folder; a restart is then all an update takes.

If tasks are running when you restart, a dialog says so. With **Continue interrupted work after relaunch** on (the default), the tasks pick up on the first launch after the update.

No GitHub account or token is needed: the repository is public, the app reads its GitHub releases directly, and it checks each download against the SHA-512 in the release metadata.

If you hit GitHub's rate limit often, you can **optionally** give the app a token. It only raises the limit; updates work without one. The app looks in this order:

1. The `GH_TOKEN` or `GITHUB_TOKEN` environment variable
2. The GitHub CLI login (`gh auth login`)
3. A [token](https://github.com/settings/tokens) saved in the **GitHub token (optional)** field of **Settings › Updates & about**, stored encrypted with the OS secure storage

## omp

omp updates itself. While OMPdesk is open it checks npm's latest `@oh-my-pi/pi-coding-agent` at launch and every few hours, and runs `omp update` in the background when there is something newer.

- **Your work is not interrupted.** A running omp keeps the code it already loaded. Idle tabs restart on the new omp right away; busy tabs restart after their task finishes. Session history and drafts stay.
- **A quiet notice.** One "omp updated" notification when it finishes. If the new omp lacks a feature OMPdesk uses, a warning names the feature.
- **On failure** the reason is kept in **Settings › Updates & about › This computer** and the next check tries again, backing off if the network keeps failing. On Windows, a locked omp file can make the install fail; the next check retries.
- **To turn it off or run it by hand,** use the **Update omp automatically** switch (on by default) and the **Update now** button in the same place, or run `omp update` in a terminal.
- **Remote devices update themselves.** A connected computer's omp is updated by that computer's OMPdesk, never by this one.
- Development and test runs never update automatically.

## Plugins, marketplaces, skills and MCP servers

Extensions omp loads stay current too: at launch and every 4 hours while OMPdesk is open. Only what is installed is updated; nothing new is installed and no config file is edited.

- **Marketplaces** refresh their catalog. **Plugins** installed from a marketplace, npm or git update the way omp upgrades them.
- **Pinned versions are left alone.** An npm plugin installed as `pkg@1.2.3` (an exact version or a range), a git plugin pinned to a commit or version tag, an MCP server run as `pkg@1.2.3`, and a plugin linked from a local folder only report that a newer version exists.
- **Skills** update only when installed from the skills registry. A plugin's skills follow that plugin; plain local files show "local, not updated". New versions that carry scripts need your approval, so they are not installed automatically.
- **MCP servers:** unpinned `npx`, `bunx` and `uvx` packages fetch the latest on every start. Executables installed globally with `npm`, `bun`, `brew`, `pipx`, `uv` or `pip` update through the tool that installed them; installs that need system or administrator rights are left alone. The built-in REA is pinned to the OMPdesk version. OMPdesk never edits MCP config files.
- **Your work is not interrupted.** Idle tabs reload the way `/reload-plugins` does; busy tabs wait for their turn to end. An update that could break a running MCP server waits until it stops.
- **To turn it off or run it by hand,** use the **Update extensions automatically** switch (on by default) and the per-item **Update now** buttons in **Settings › Updates & about › This computer › Extensions**. Failures and skips are listed there too.
- **Remote devices update themselves.**
