# The bot's desk

## `ompdesk_bot`

Only the owner's bot session has this tool in practice (Settings › Bot; the bot is the session the owner named 봇). Any other session, a paired device's session and a caller outside OMPdesk is refused with a message saying so: reach the owner with `ompdesk_notify` and the session that opened you with `ompdesk_report`. The desk is kept apart from the conversation (`<userData>/bot-desk.json`), so it survives a new conversation and a compaction.

- `action: "desk"` reads the standing duties, the decisions still waiting for the owner and the wakes you scheduled for yourself (`ompdesk_schedule` with `target: "self"`), as compact text. The duties are also in your prompt every turn.
- `action: "decide"` posts what only the owner can decide: `question` (one clear sentence), optional `options` (at most six; leave it out for a free answer) and `context` (what the owner needs to know). It returns at once with the decision's id: keep working on whatever does not depend on it, and never wait for it or post it again. The owner sees it in the bot's home, apart from the chat, with a "needs you" banner and a push to paired phones. Their answer reaches you later as a message that starts your turn and names the decision id, its question and the answer; continue from it.
- `action: "duty_add"` records a standing responsibility the owner gave you (`text`, one sentence: "check the nightly build every morning"), not a single task. The same text twice is one duty. At most twenty. `action: "duty_remove"` drops one by `id` once it is over; `desk` shows the ids.

A duty that needs a timer is a duty plus a wake: record it, then schedule the wake with `ompdesk_schedule`.
