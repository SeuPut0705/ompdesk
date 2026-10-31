# Schedules

## `ompdesk_schedule`

Puts a prompt on a computer's Schedules service: a fresh print-mode session started on a timer in a folder, only while OMPdesk is open on that computer. `action` is `create`, `list` or `cancel`; `device` picks the computer (a paired device by name or id, `"local"` = this computer; default the one your own session runs on), and each computer keeps and runs its own schedules.

- `action: "create"` needs `name`, `prompt` and `every_minutes` or `daily_at` (`HH:MM`, optional `days` 0-6); optional `folder` (absolute on that computer; default your own folder, required when `device` is not the one your session runs on) and `model`. The prompt has no memory of this conversation, so write it self-contained with the brief template. No card by default; the user confirms a new one only if they turned off both full control and "Let agents manage other sessions". It never runs with auto-approve; that computer's Settings › Schedules marks agent-made ones `[agent]`.
- `action: "list"` shows every schedule of that computer; `action: "cancel"` with `id` (and the same `device`) removes only the ones agents made, never the user's.
- A device whose link is down is waited for about 15 seconds (a blip reconnects in that time); one that stays away is refused: it has to be on and reachable first.
- `target: "self"` (with `create`) is a wake-up for your own session, not a fresh run: at each start the prompt is delivered into this session as a message that starts a turn (the session is opened in the background when no tab holds it), so you keep this conversation and the prompt can be a note to yourself ("check the build; tell the owner only if it failed"). It takes no `folder`, `model` or `device`, works only for this computer's sessions, and `every_minutes` is at least 5. It repeats until you cancel it with `action: "cancel"`, so cancel it once the check is no longer needed. Use it to follow work you started and come back later.

Use it for recurring orchestration ("every morning, review the open PRs"), not for work that can run now.

## Keeping something durable

To keep a lesson or decision for later sessions, use ai-memory's own tools (see its `ai-memory-durable-pages` skill); OMPdesk has no tool for it.
