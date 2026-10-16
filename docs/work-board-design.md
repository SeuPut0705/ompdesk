# Work board — design record

The work board docks this session's live state in the right margin of a wide session pane
(`layout/work-board/WorkBoard.tsx`, `styles/work-board.css`). This is how its look was chosen.

## References (patterns, not copies)

Written from working knowledge of these products; their docs are text and say little about layout, so nothing
below was measured from screenshots.

| Reference | Pattern worth taking | Fit for OMPdesk |
| --- | --- | --- |
| Linear issue sidebar | Properties as quiet label/value rows; headers are small and muted; hover reveals affordances; collapsible groups remember their state. | Yes: small section headers with a fold chevron, persisted. |
| Vercel deployment status | One status line at the top ("Building · 2/5 steps"), a step list with per-step durations, the live step pulses. | Yes: the status line, the turn's last steps with durations. |
| Raycast | Dense rows, two-line items (title + muted subtitle), tabular numbers, everything keyboard-reachable with a hint chip. | Yes: two-line agent rows, `⌥B` chip on the waiting section. |
| Arc | Pinned/attention items rise to the top; calm, colourless chrome with colour only where something needs you. | Yes: waiting on you first, wearing the only wash. |
| Cursor / Zed agent panels | Plan as a checklist with the active step emphasised; a running tool shown as a muted second line; model badge per agent. | Yes: todos with the active row, the agent's current tool and its model's mark. |

Constraints from OMPdesk's own language: no new colours (state colour only: info = working, success = done,
warning = needs you), no cards inside cards, `--sc-*` tokens, reduced motion respected, no layout shift of the
transcript (the board takes its width from the margin, and the columns move together only when it appears).

## Directions compared

All three share one markup and data model; they differ in how the head and the sections are drawn.

- **A — Quiet list.** Small muted head, a plain status sentence, sections divided by hairlines.
  Closest to the first version. Reads fine, but the whole session's state is a sentence: progress is not visible
  at a glance, and the sections blur into one column of rows.
- **B — Status first.** The head carries the session's state: a calm pulse, the status line in the primary text
  weight ("4 working · 1 waiting on you") and a segmented bar for the todo progress with "3/7 done" beside it.
  Sections are separated by space, not rules; only the waiting section wears a wash.
- **C — Rail.** Every section hangs off a thin vertical rail with a node at its header, like a timeline.
  It makes the turn's steps feel connected, but the nodes add a column of marks that compete with the state dots,
  the rail costs 16 px of a 264 px board, and the nodes are hollow rings that read as todo checkboxes.

Captures (1600 px, light/dark × en/ko, running and just-ended turn) were taken for each and compared.

## Pick: B

1. The one thing a margin board must do is answer "what is going on" without reading: B's status line plus bar
   does that in two lines; A needs the reader to scan, C spends the space on decoration.
2. The warning wash plus top position makes "waiting on you" the single loud element, which is the intended
   hierarchy; in C the rail nodes are as loud as the content.
3. Space instead of rules keeps the board quiet next to the transcript, so the colour of state dots and the
   segmented bar are the only colour on it — the same rule the rest of the app follows.
4. It survives Korean: the longest status line ("4개 작업 중 · 1개가 답변을 기다려요") fits the 264 px board at
   `--sc-font-md`; the "3/7 완료" caption sits on the bar's row, not in the sentence.

## What the shipped board does

- Head: pulse (working / waiting / idle), status line, segmented todo bar, hide button.
- Waiting on you first: questions, approvals and a pending plan review; the only live region (polite);
  `⌥B` (`board.focus`) jumps to its first row from anywhere.
- This turn: the last four calls with their tool icon, target and duration; the live one's icon is tinted.
- Running: subagents (state dot, task, elapsed, current step or tool, tokens, the provider mark of the model they
  run on) and background shells; a click opens the subagent in the side panel / Background tasks.
- Todos: finished tasks fold into "N done", the active row is emphasised, finished rows are struck through;
  a click scrolls the todo card in the conversation into view when it is there.
- Goal: objective, status, and budget / time meters from `get_goal` (warning colour from 90 %).
- Last turn (idle): duration, files changed with +/−, a click opens Changes.
- Every section folds to its header; folds persist (`workBoardCollapsed`).
- Motion: one running animation, the head's pulse while something works; rows fade in and out once
  (`usePresence`) and otherwise stay still, so a live row is marked by colour (an info dot, a tinted icon), not by
  movement. Every animated row cost the GPU process about 2 % of a core while the transcript streamed, whatever
  the animation (an earlier version pulsed each live row's dot and swept a 1 px line under it). All motion is off
  under `prefers-reduced-motion`.
- One shared one-second clock (`useNowTick`) drives every timer; the board re-renders once a second only while
  something runs and the window is in view, with tabular numbers so the digits do not jitter.
- The account row and the running section read `get_usage` and `get_jobs` through one poll per tab
  (`hooks/use-tab-poll.ts`), shared with the sidebar's usage lines, Stats › Usage, the Settings model tables and
  accounts and the usage-limit notice (`use-usage-reports.ts`), and with the dock island and the Background tasks
  view (`use-background-jobs.ts`).
- Measured with `e2e/flow-performance.e2e.ts`'s `daily` flow (1600 px, the user's largest session, fake omp, 16 Oct
  2026; share of one core, v0.31.0 without a board in brackets): streaming beside a busy board, GPU process 18 %
  (18 %; 36–40 % with the per-row pulses and sweeps), no frame over 10 ms; agents running after a turn, renderer 9 %
  and GPU 10 % (8 % and 24 %; 28 % and 39 % before this work); idle IPC 30 calls a minute (28), none while hidden.

## Not done

- Exit and reorder animations (rows enter with a fade; leaving rows disappear at once) — a presence layer would
  be needed and the board's rows change rarely.
- A cost line in the idle summary (no per-turn cost is in the renderer's stores; deriving it would break the
  "read, never derive" rule).
