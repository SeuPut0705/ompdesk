# Changing OMPdesk itself

`ompdesk_app_list` and `ompdesk_app` let you do in the app what the user would do by clicking in Settings or the side panel: set the theme, open the preview panel, switch a model, read usage, check for an update. Do not ask the user to click something an action covers.

## Flow

1. `ompdesk_app_list` with `area` (`settings`, `ui`, `usage`, `models`, `sessions`, `updates`, `accounts`, `mobile_web`, `extensions`, `memory`, `permissions`) or `query` (words from an id or description). It prints each matching action with its tier and argument schema; with many matches it prints names only, so narrow the filter.
2. `ompdesk_app` with `action` (an id from the list, e.g. `settings.theme`) and `args` as the schema says. Arguments are checked in the app; an unknown action or argument is refused.
3. Read before you change: `settings.get` shows current values, `usage.read` the provider quota windows.

## Tiers

- `read`: free.
- `change`: free. The user sees a quiet toast ("Agent changed: Theme → Nord") with Undo, and the change is noted in your session. `app.undo` puts back your last change when it had a previous value.
- `sensitive`: accounts and sign-in starts, approval-adjacent and network settings (proxy), mobile web, installing plugins, erasing memory or saved sessions, updates, restart and quit. The user gets a confirmation card first; a refusal is final: do not retry or look for another route, say what you wanted and why. If the user turned on "let agents manage", the card is skipped.
- `never`: what bounds your own power (the control tools switch, approval mode, who may approve, memory and computer-use switches), secrets and tokens, answering a card, pairing devices, adding MCP servers. The list shows these with the reason. Tell the user to do them in Settings; `ui.settings_open` opens the right section for them.

## Sign-in

`accounts.github_sign_in` and `accounts.provider_sign_in` only start the existing flow. The user finishes it in the window; you never see a credential. Check `accounts.github_status` afterwards.

## Habits

- Change one thing, say what you changed, and leave the rest.
- Do not change a setting to make your own task easier (approvals, models, limits) unless the user asked for that.
- A toast and a card are for the user: never claim they approved something they did not.
