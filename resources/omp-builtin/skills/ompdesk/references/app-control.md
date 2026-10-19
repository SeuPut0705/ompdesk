# Changing OMPdesk itself

`ompdesk_app_list` and `ompdesk_app` let you do in the app what the user would do by clicking in Settings or the side panel: set the theme, open the preview panel, switch a model, read usage, check for an update. Do not ask the user to click something an action covers.

## Flow

1. `ompdesk_app_list` with `area` (`settings`, `ui`, `usage`, `models`, `sessions`, `updates`, `accounts`, `mobile_web`, `extensions`, `memory`, `connections`, `autopilot`, `permissions`) or `query` (words from an id or description). It prints each matching action with its tier and argument schema; with many matches it prints names only, so narrow the filter.
2. `ompdesk_app` with `action` (an id from the list, e.g. `settings.theme`) and `args` as the schema says. Arguments are checked in the app; an unknown action or argument is refused.
3. Read before you change: `settings.get` shows current values, `usage.read` the provider quota windows.

## Tiers

- `read`: free.
- `change`: free. The user sees a quiet toast ("Agent changed: Theme → Nord") with Undo, and the change is noted in your session. `app.undo` puts back your last change when it had a previous value.
- `sensitive`: accounts and sign-in starts, approval-adjacent and network settings (proxy), mobile web, installing plugins or MCP servers (the card shows the exact command or url), starting pairing (`remote.pair` only opens the place where the user completes it; you never give or read a code), erasing memory or saved sessions, updates, restart and quit. **While the user gives agents full control of OMPdesk (on by default) none of these raises a card.** With full control off there are two groups. **Always a card, whatever "Let agents manage other sessions" says**: erasing data (`sessions.delete`, `memory.purge`, `memory.delete_page`, `memory.sweep`), running code (`extensions.install_plugin`, `extensions.install_mcp`), credentials and traffic (`accounts.github_sign_in`, `accounts.provider_sign_in`, `settings.proxy`), exposing the computer (`mobile_web.set_enabled` with `enabled` true, `remote.pair`) and ending running work (`updates.apply`, `app.quit`); the list shows each action's rule. **Card unless that switch is on** (it is on unless the user turned it off, so by default no card): `updates.check`, the auto-update switches, `settings.builtinRea`, `settings.rotation`. Undoing a setting asks by the same rule. Deleting a saved session another session opened with `ompdesk_session_stop` and `delete` asks too. A refusal is final: do not retry or look for another route, say what you wanted and why.
- `agent_power.set` (`switch`, plus `on` or, for `tools.approvalMode`, `mode`): the switches that bound your own power (control tools, full control, manage, approve, approval mode, memory, engineering mode, computer use). Only under full control; refused otherwise, and then the user changes them in Settings (`ui.settings_open` opens the right section). Change one only when the user asked.
- `never`: secrets, tokens and pairing codes, and answering a card, whatever the switches say. The list shows these with the reason.

## Sign-in

`accounts.github_sign_in` and `accounts.provider_sign_in` only start the existing flow. The user finishes it in the window; you never see a credential. Check `accounts.github_status` afterwards.

## Habits

- Change one thing, say what you changed, and leave the rest.
- Do not change a setting to make your own task easier (approvals, models, limits) unless the user asked for that.
- A toast and a card are for the user: never claim they approved something they did not.

## Autopilot

`autopilot.start`, `autopilot.status` and `autopilot.stop` are `ompdesk_autopilot` itself: its confirmation card (none under full control; with it off always for ship release or the default branch, and for commit and push on another branch only when the manage switch is off) and its folder rules apply, and the app actions have no other route to Autopilot. See skill://ompdesk/references/autopilot.md.
