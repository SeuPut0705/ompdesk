# Schedules and lessons

## `ompdesk_schedule`

Puts a prompt on OMPdesk's Schedules service: a fresh print-mode session started on a timer in a folder, only while the app is open. `action` is `create`, `list` or `cancel`.

- `action: "create"` needs `name`, `prompt` and `every_minutes` (at least 30) or `daily_at` (`HH:MM`, optional `days` 0-6); optional `folder` (absolute) and `model`. The prompt has no memory of this conversation, so write it self-contained with the brief template. The user confirms a new one unless they turned the card off; it never runs with auto-approve; at most 5 agent-made schedules exist; Settings › Schedules marks them `[agent]`.
- `action: "list"` shows every schedule; `action: "cancel"` with `id` removes only the ones agents made, never the user's.

Use it for recurring orchestration ("every morning, review the open PRs"), not for work that can run now.

## `ompdesk_remember`

`lesson`: one note (at most 600 characters) to the user's memory after an orchestration you ran: what split worked, what collided, what to do differently. It needs the user's memory on and a session you opened in the last hour, and allows 3 per hour. No secrets, no copy of another session's answer.
