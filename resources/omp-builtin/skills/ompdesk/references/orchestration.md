# Running parallel sessions

## Open

`ompdesk_session_open` takes one session's fields or `sessions: [ … ]` for several at once. Each: `message`, `folder`, `model` (`provider/id`), `mode` (`plan` or `goal`; `goal` needs a `message`, which becomes the goal), `worktree` (`true`, or `{branch, base}` with `base` `HEAD` or `default`). Shared: `show` (`background` default, `focus`, `split-right`, `split-down`). It returns the ids. On a paired host's tab it opens on that host.

Before you open: say which parts you will run. Write each first message with the brief template in SKILL.md. When the child writes files, give it `worktree: true` or Ownership no other child shares, so two sessions never edit one file. A `task` subagent is no substitute: it works in your checkout whatever folder you name, so a git worktree you make by hand and hand to it isolates nothing.

Keep the brief light, and say so in it: `bun run check:changed` (or the project's one check) once at the end, never after every edit; one release per piece of work; the parity e2e on a paired device and the phone only when the UI changed; a reproduction once before the fix and once after; independent items as parallel sessions rather than one long one; a narrow, mechanical implementation opened with `model` set to the model your `task` role uses. A child's done report ends with `Pace: wall 22 min · model+between-calls 20 min (156 calls, median 4.0 s) · tools 2 min · errors 6`, and `· waste: read src/x.ts ×14` or `· waste: 2.1 model calls per tool call` when the session re-read one file ten times or more, or made 1.5 or more model calls per tool call over ten or more tool calls. Name that waste in the next brief to that child or its successor, with what to do instead (keep what it read, act instead of thinking twice). `ompdesk_sessions` and `ompdesk_session_result` carry the short form (`pace 22 min, 156 calls, median 4.0 s`).

Check capacity first: `ompdesk_sessions` ends with each computer's memory (free of total, pressure, starts still growing, waiting work, what one more session is expected to need). Open as few sessions at once as the work needs; each runs checks, tests and builds that can take gigabytes. While a computer's memory is in danger, OMPdesk holds a new session's first message (and a message that would start an idle one) and starts it by itself in order once memory frees: the result says `waiting for memory … it starts by itself`. Never send a held message again, never close and reopen to get around the wait; the owner can start one at once from its row. Waiting on your children with `ompdesk_session_result` `wait: true` never holds them back: they start ahead of other work while you wait.

Track what you dispatched in `todo`: one item per session you open, named by its title, marked done when its `done` report arrives (dropped when you stop it), so the list on the user's work board is the work in flight, not an earlier task's steps.

```json
ompdesk_session_open
{"show": "background", "sessions": [
  {"message": "Title: …\nTarget: src/main, read-only\nChange: list unhandled promise rejections\nConstraints: change nothing\nOwnership: none\nObservable acceptance: file:line with a one-line reason each\nEnd your final answer with a short summary of what changed and anything left undone."},
  {"message": "Title: …\nTarget: src/shared/format.ts\nChange: add missing tests\nConstraints: production code untouched\nOwnership: src/shared/format.test.ts\nObservable acceptance: bunx vitest run src/shared/format.test.ts passes\nEnd your final answer with a short summary of what changed and anything left undone.", "worktree": true}
]}
```

## Collect

Children tell you: each report (`ompdesk_report`) lands in your session as a quiet line between your steps while you work, ends a `wait` you are in, and a `done`, `review`, `question` or `blocked` wakes you when you are idle; so end your turn (or wait on your own jobs) after dispatching instead of polling. To block on them now, one `ompdesk_session_result` with `sessions: [ids]` and `wait: true`; `until: "any"` returns at the first finish. Never poll `ompdesk_sessions` in a loop.

- a `question` or `blocked` report: answer with `ompdesk_session_send` (the child waits for it); a choice only the user can make goes to the user. It shows on the user's work board as waiting until you answer.

- finished: use the answer; `ompdesk_session_read` (`limit`, `before` cursor) when the summary is thin.
- waiting for an answer: `ompdesk_session_answer` only when the answer is a detail you know; a preference, a secret or the user's own choice goes to the user (`ompdesk_tab_focus`, `ompdesk_notify`).
- waiting for plan approval (a plan-mode session proposed its plan): read the plan file the listing names, then `ompdesk_session_answer` with `approve: true` and `choice` `execute` (fresh context, default), `compact` or `keep_context`, or `approve: false` with `text` as feedback (it revises). A plain `ompdesk_session_send` also counts as feedback and closes the card. Approving needs the user's approve permission unless full control is on; feedback always works.
- timeout: still running. Wait again or report progress; silence alone is no reason to stop it.

## Paths in a child's answer

A worktree child reports paths inside its own checkout. When a result names an absolute path in the main repo or another checkout, do not follow it to read or edit there: map it to the child's worktree, or ask the child. Edits made outside the child's checkout land on the user's branch unseen.

## Send and coordinate

`ompdesk_session_send` (`session`, `message`, `delivery`): `follow_up` waits for the turn to end; `steer` only for a correction that cannot wait. A session that already reported back to you in its running turn gets the message between its steps anyway, and one that reports while your follow-up still waits is told to end its turn. Every message shows in the receiver as sent by an agent with your title. A session id you were given keeps naming the same session after OMPdesk relaunches, although the list then shows its new id.

With sessions you did not open: look first (`ompdesk_sessions`, then `ompdesk_session_read`), do not interrupt one the user is typing in, hand over exactly what it needs, review by replying with concrete findings rather than redoing its work, and avoid editing its files. Never start message chains between sessions that wait on each other.

## Finish

Synthesize per session: what it found or changed, conflicts and overlaps, what is left. Close the sessions you opened when done (`ompdesk_session_stop` with `close`); one you collected that ended well, that nobody is using and whose work landed has closed itself already, and its saved session stays readable (skill://ompdesk/references/worktrees-review.md). Children finishing reach the user through OMPdesk's batched notifications; use `ompdesk_notify` (`title`, `body`) only for what those do not say.

## Another folder, model and mode, shown beside

```json
ompdesk_session_open
{"folder": "/Users/me/work/api-server", "model": "anthropic/claude-opus-4", "mode": "plan", "message": "Plan rate limiting for the public routes. Do not edit files yet. End with the plan as a numbered list.", "show": "split-right"}
```
