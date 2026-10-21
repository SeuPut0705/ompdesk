# Changing OMPdesk itself

`ompdesk_app_list` and `ompdesk_app` let you do in the app what the user would do by clicking in Settings or the side panel: set the theme, open the preview panel, switch a model, read usage, check for an update. Do not ask the user to click something an action covers.

## Flow

1. `ompdesk_app_list` with `area` (`settings`, `ui`, `usage`, `models`, `sessions`, `updates`, `accounts`, `mobile_web`, `extensions`, `memory`, `connections`, `autopilot`, `permissions`) or `query` (words from an id or description). It prints each matching action with its tier and argument schema; with many matches it prints names only, so narrow the filter.
2. `ompdesk_app` with `action` (an id from the list, e.g. `settings.theme`) and `args` as the schema says. Arguments are checked in the app; an unknown action or argument is refused.
3. Read before you change: `settings.get` shows current values, `usage.read` the provider quota windows.

## Tiers

- `read`: free.
- `change`: free. The user sees a quiet toast ("Agent changed: Theme → Nord") with Undo, and the change is noted in your session. `app.undo` puts back your last change when it had a previous value.
- `sensitive`: accounts and sign-in starts, approval-adjacent and network settings (proxy), mobile web, installing plugins or MCP servers (the card shows the exact command or url), sharing between computers over Tailscale (`remote.list_tailnet` lists the tailnet's computers, `remote.connect` connects to one by its node id, `remote.block`/`remote.unblock` keep a device out or let it back, `remote.set_allowed_users` sets the Tailscale accounts that may use this computer; there is no pairing code), erasing memory or saved sessions, updates, restart and quit. **While the user gives agents full control of OMPdesk (on by default) none of these raises a card.** With full control off there are two groups. **Always a card, whatever "Let agents manage other sessions" says**: erasing data (`sessions.delete`, `memory.purge`, `memory.delete_page`, `memory.sweep`), running code (`extensions.install_plugin`, `extensions.install_mcp`, `extensions.mcp_use`), credentials and traffic (`accounts.github_sign_in`, `accounts.provider_sign_in`, `extensions.mcp_sign_in`, `settings.proxy`), exposing the computer (`mobile_web.set_enabled` with `enabled` true, `remote.connect`, `remote.unblock`, `remote.set_allowed_users`) and ending running work (`updates.apply`, `app.quit`); the list shows each action's rule. **Card unless that switch is on** (it is on unless the user turned it off, so by default no card): `updates.check`, the auto-update switches, `settings.builtinRea`, `settings.rotation`, `remote.block`. Undoing a setting asks by the same rule. Deleting a saved session another session opened with `ompdesk_session_stop` and `delete` asks too. A refusal is final: do not retry or look for another route, say what you wanted and why.
- `agent_power.set` (`switch`, plus `on` or, for `tools.approvalMode`, `mode`): the switches that bound your own power (control tools, full control, manage, approve, approval mode, memory, engineering mode, computer use). Only under full control; refused otherwise, and then the user changes them in Settings (`ui.settings_open` opens the right section). Change one only when the user asked.
- `never`: secrets and tokens, and answering a card, whatever the switches say. The list shows these with the reason.

## Which computer

A session that runs on a paired host acts on that host exactly as the Settings page does while that tab is focused. Stock settings, models, usage, plugins and MCP servers already go to the host's omp. `settings.rotation` and `settings.builtinRea` read and write the host's own value (`settings.get` shows it), and `sessions.saved`, `sessions.search`, `sessions.rename` and `sessions.delete` work on the host's saved sessions. `updates.status`, `updates.check` and `updates.apply` stay on this computer's OMPdesk unless you pass `host: true`, which asks the paired host's OMPdesk instead (`updates.apply` refuses while work runs there, yours included). Everything else is this device's own: its look, notifications, proxy, update switches, memory, Tailscale and phone-page sharing.

## Sign-in

`accounts.github_sign_in` and `accounts.provider_sign_in` only start the existing flow. The user finishes it in the window; you never see a credential. Check `accounts.github_status` afterwards.

## MCP servers

Never start a terminal `omp` (or `/mcp` in one) to add, sign in to or reload an MCP server: each OMPdesk tab is its own omp, and a terminal's work never reaches the open sessions.

1. `extensions.mcp_servers` lists each server: connected or not, tools, `needs sign-in`, and why one is off (`turned off in omp's config`, `found only in <tool>'s config`, …).
2. `extensions.install_mcp` adds one; its answer says whether it needs a sign-in.
3. `extensions.mcp_sign_in` with the server's `name` starts its OAuth sign-in: a browser page shows in your session and the user completes it. Tell the user to finish it there; you never see a credential.
4. A server found only in another tool's config (Codex, Claude Code, Cursor, …) is not used by omp: `extensions.mcp_use` copies that one server into omp's config (the tool's other servers, skills and rules stay unused).

Every change (an add, a sign-in, `mcp_use`) reaches every open session by itself, a session in a turn when its turn ends; no tab needs a restart. After starting a sign-in, end your turn and let the user finish it; check `extensions.mcp_servers` when they come back, never poll in a loop.

## Habits

- Change one thing, say what you changed, and leave the rest.
- Do not change a setting to make your own task easier (approvals, models, limits) unless the user asked for that.
- A toast and a card are for the user: never claim they approved something they did not.

## Autopilot

`autopilot.start`, `autopilot.status` and `autopilot.stop` are `ompdesk_autopilot` itself: its confirmation card (none under full control; with it off always for ship release or the default branch, and for commit and push on another branch only when the manage switch is off) and its folder rules apply, and the app actions have no other route to Autopilot. See skill://ompdesk/references/autopilot.md.
