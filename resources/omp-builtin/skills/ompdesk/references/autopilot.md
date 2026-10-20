# Autopilot

## `ompdesk_autopilot`

Starts, reads and stops an Autopilot run: an unattended loop that keeps improving a git repo in its own worktree (cycles of audit, change, check, commit; it pushes and releases only as far as the ship level allows). `action` is `start`, `status` or `stop`.

## Autopilot or sessions

- Autopilot: open-ended improvement of one repo with commits and a ship level, no end state you can state in a sentence ("keep the tests and docs healthy", "work through this backlog"). It picks its own items and runs until stopped or a ceiling pauses it.
- Sessions (`ompdesk_session_open`): bounded tasks with an acceptance you can check, parallel attempts, other folders or models. Use these when you can write the brief.

## Start

- `action: "start"`; `folder` (absolute; default your own) on `device` (default the device your session runs on; `local` is this computer). On this computer the folder must be open in a session of this window, because the run starts from that session; open one there first. On a paired device a session there is opened for it when none has the folder open.
- A run on a paired device is that device's: its worktree, checks and shipping run there, and it opens here as a session of yours that shows the device's run.
- `ship`: `commit` (local commits only), `push` (push each green cycle) or `release` (also publishes versions). Omitted: `commit`.
- `branch`: `{"kind":"new","name":"..."}` or `{"kind":"existing","name":"..."}`. Omitted: a new `autopilot/<date>` branch.
- `guide`: AUTOPILOT.md text committed as the branch's first commit. `advanced`: `focus`, `parallel`, `cadence` (with release), `remote`, `backlog`, `limits`; anything omitted keeps the Autopilot sheet's defaults.
- The run opens as a session you started; the answer names its id. Do not message it.

## Cards

A start needs no card by default (the user gives agents full control of OMPdesk unless they turned it off; then "Let agents manage other sessions", on unless turned off, lifts the card, and a card always appears for `ship` release and for the repo's default branch (`main`)). A refusal is final. Git safety holds either way: no force push, and destructive git stays banned in the run.

## Status and stop

- `action: "status"` with `session`: state, cycle, current item, red streak, last commit, push and release, and why it paused or ended. Read it between your own steps; a quiet run is working.
- `action: "stop"` with `session`: ends the run after the cycle in flight. `now: true` aborts the turn at once and pauses it; the user resumes it on the Autopilot screen.
- Runs you started need no card to read or stop; other runs need full control or the user's manage setting (stopping one asks the user first without them).

Treat the run's commits as work to report, not to merge: it ships by its own ship level. Tell the user the branch and what it did.
