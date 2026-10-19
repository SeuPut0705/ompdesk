# Running parallel sessions

## Open

`ompdesk_session_open` takes one session's fields or `sessions: [ … ]` for several at once. Each: `message`, `folder`, `model` (`provider/id`), `mode` (`plan` or `goal`; `goal` needs a `message`, which becomes the goal), `worktree` (`true`, or `{branch, base}` with `base` `HEAD` or `default`). Shared: `show` (`background` default, `focus`, `split-right`, `split-down`). It returns the ids. On a paired host's tab it opens on that host.

Before you open: say which parts you will run. Write each first message with the brief template in SKILL.md. When the child writes files, give it `worktree: true` or Ownership no other child shares, so two sessions never edit one file.

```json
ompdesk_session_open
{"show": "background", "sessions": [
  {"message": "Title: …\nTarget: src/main, read-only\nChange: list unhandled promise rejections\nConstraints: change nothing\nOwnership: none\nObservable acceptance: file:line with a one-line reason each\nEnd your final answer with a short summary of what changed and anything left undone."},
  {"message": "Title: …\nTarget: src/shared/format.ts\nChange: add missing tests\nConstraints: production code untouched\nOwnership: src/shared/format.test.ts\nObservable acceptance: bunx vitest run src/shared/format.test.ts passes\nEnd your final answer with a short summary of what changed and anything left undone.", "worktree": true}
]}
```

## Collect

Children tell you: each one's `done`, `review`, `question` or `blocked` report (`ompdesk_report`) lands in your session as a quiet line and wakes you when you are idle, so end your turn after dispatching instead of polling. To block on them now, one `ompdesk_session_result` with `sessions: [ids]` and `wait: true`; `until: "any"` returns at the first finish. Never poll `ompdesk_sessions` in a loop.

- a `question` or `blocked` report: answer with `ompdesk_session_send` (the child waits for it); a choice only the user can make goes to the user. It shows on the user's work board as waiting until you answer.

- finished: use the answer; `ompdesk_session_read` (`limit`, `before` cursor) when the summary is thin.
- waiting for an answer: `ompdesk_session_answer` only when the answer is a detail you know; a preference, a secret or the user's own choice goes to the user (`ompdesk_tab_focus`, `ompdesk_notify`).
- waiting for plan approval (a plan-mode session proposed its plan): read the plan file the listing names, then `ompdesk_session_answer` with `approve: true` and `choice` `execute` (fresh context, default), `compact` or `keep_context`, or `approve: false` with `text` as feedback (it revises). A plain `ompdesk_session_send` also counts as feedback and closes the card. Approving needs the user's approve permission unless full control is on; feedback always works.
- timeout: still running. Wait again or report progress; silence alone is no reason to stop it.

## Paths in a child's answer

A worktree child reports paths inside its own checkout. When a result names an absolute path in the main repo or another checkout, do not follow it to read or edit there: map it to the child's worktree, or ask the child. Edits made outside the child's checkout land on the user's branch unseen.

## Send and coordinate

`ompdesk_session_send` (`session`, `message`, `delivery`): `follow_up` waits for the turn to end; `steer` only for a correction that cannot wait. Every message shows in the receiver as sent by an agent with your title.

With sessions you did not open: look first (`ompdesk_sessions`, then `ompdesk_session_read`), do not interrupt one the user is typing in, hand over exactly what it needs, review by replying with concrete findings rather than redoing its work, and avoid editing its files. Never start message chains between sessions that wait on each other.

## Finish

Synthesize per session: what it found or changed, conflicts and overlaps, what is left. Close the sessions you opened when done (`ompdesk_session_stop` with `close`); one you collected that ended well, that nobody is using and whose work landed has closed itself already, and its saved session stays readable (skill://ompdesk/references/worktrees-review.md). Children finishing reach the user through OMPdesk's batched notifications; use `ompdesk_notify` (`title`, `body`) only for what those do not say.

## Another folder, model and mode, shown beside

```json
ompdesk_session_open
{"folder": "/Users/me/work/api-server", "model": "anthropic/claude-opus-4", "mode": "plan", "message": "Plan rate limiting for the public routes. Do not edit files yet. End with the plan as a numbered list.", "show": "split-right"}
```
