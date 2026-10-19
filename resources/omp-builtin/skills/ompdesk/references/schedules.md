# Schedules

## `ompdesk_schedule`

Puts a prompt on OMPdesk's Schedules service: a fresh print-mode session started on a timer in a folder, only while the app is open. `action` is `create`, `list` or `cancel`.

- `action: "create"` needs `name`, `prompt` and `every_minutes` or `daily_at` (`HH:MM`, optional `days` 0-6); optional `folder` (absolute) and `model`. The prompt has no memory of this conversation, so write it self-contained with the brief template. No card by default; the user confirms a new one only if they turned off both full control and "Let agents manage other sessions". It never runs with auto-approve; Settings › Schedules marks agent-made ones `[agent]`.
- `action: "list"` shows every schedule; `action: "cancel"` with `id` removes only the ones agents made, never the user's.

Use it for recurring orchestration ("every morning, review the open PRs"), not for work that can run now.

## Keeping something durable

To keep a lesson or decision for later sessions, use ai-memory's own tools (see its `ai-memory-durable-pages` skill); OMPdesk has no tool for it.
