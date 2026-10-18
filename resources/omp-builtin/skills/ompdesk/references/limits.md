# Permissions and limits

## Allowed without asking

List, read, send, wait, open, answer a question, show, notify; stop, close and delete sessions you opened.

## One confirmation card for the user

Stopping, closing or deleting a session you did not open, merging any branch (`ompdesk_merge`), and creating a schedule, unless the user turned the card off in Settings ("Let agents manage other sessions"). A refusal is final; do not ask again. Cards titled "[OMPdesk] …" are the user's to answer, never yours.

## Tool approvals in another session

You may deny an "Allow tool: …" request. You may approve only when the user turned on "Let agents approve for other sessions"; otherwise the answer is "user approval needed": point the user at that session (`ompdesk_tab_focus`, `ompdesk_notify`).

## Never possible

Accounts, settings, permissions, other sessions' hidden state. A session the user hid from agents refuses everything; treat it as not there.

## Caps

At most 6 sessions you opened open at once, 4 opened per turn and 12 per hour; 20 messages per turn and 60 per hour; 6 a minute between the same two sessions; a chain of agent messages (A → B → C …) at most 3 hops; messaging yourself is refused. When a cap says no, stop and report instead of working around it.

Every message you send shows in the receiver as sent by an agent with your title; every answer shows "answered by an agent". All of it is in your own transcript.
