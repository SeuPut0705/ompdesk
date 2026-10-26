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

- Placement: a pane that leaves at least 300 px beside its reading column (`workBoardFits`) docks it, and so does a desktop window or a sideways tablet whose column can narrow to 503 px beside it (`workBoardFitsNarrowed`; from about an 830 px pane, so a 1280 px Windows laptop window beside the sidebar docks it), unless the side panel is open; a board with no section takes no room. Where it cannot dock (a phone, a portrait tablet, a narrow window or split pane, the side panel open) it is a status strip under the header that expands the board in place over the top of the transcript. The expanded panel opens on a summary (round 3, R3-6, 25 Oct 2026): Needs you is listed, and Now, the plan and Current work are one line each, the zone's title, its lead item (the live step or first agent, the active task, the first Current work row) and its figure (Now's from `boardCounts`, the plan's done/total), until a tap opens that zone in place. At 390×844 with the busy harness board the panel shows all 344 px of it, where the full board showed 404 of 1,078 px; Current work's rows are 3 taps away instead of 4. The docked board never summarizes (round 2 ruled out folding by room there). It has no close and no setting (22 Oct 2026: a hidden board had no way back), so a session's work is always one glance away.
- Head (round 2, "four zones", 25 Oct 2026; before it, "tiers" wrote one wrapping sentence of every figure): the pulse, **one clause** of what matters most (what needs the person, else what runs, else "Working…", else what the last turn left) and, beside a "needs you" clause, a short "N running" figure; it never wraps (the clause clips at 264 px), the worktree's project name when the session runs in one, and one meters line: the subscription accounts' gauges and each metered provider's charge side by side (the provider's name gives way to the mark while gauges share the line; its words stay the tooltip). Every figure comes from one `boardCounts` (`work-board.ts`: asks, waiting children, a failed check, running subagents and jobs, children at work), which the head, the Needs you section and its live region and the strip's collapsed label all read, so a count is never stated twice with two values (pinned by `work-board.test.ts`, `WorkBoard.test.tsx`, `WorkBoardChip.test.tsx`). A quiet board's head is not "Idle" after a turn: it reads "Turn finished · 7 files changed +112 −37" (the files, else the passing check, else what the branch has not landed; `quietOutcome` in `WorkBoardSession.tsx`). The board's name is for screen readers. In the phone's strip the head says nothing (the strip above it says the same clause); it keeps the meters.
- Lead marks name the kind of thing (a subagent, a job, a child session, a file, a branch, a preview, sessions sharing the checkout, memory, a check, the goal) as an icon tinted by its state (info = working, success = done, warning = waiting, danger = failed). A dot is kept only where state is all there is to say (a waiting question, a plan step).
- Every row is one line (lead mark, label, one short figure; the rest in its tooltip), and a long section folds into "+N more".
- Four zones, top to bottom, each shown only when it has rows: **Needs you** (the person's: a question or approval, a plan up for review, a failed check, a session the agent opened that waits for an answer; each row begins with a fixed-width word saying which — Ask, Review, Check, Child — and jumps to it; a washed callout, the only live region, `⌥B` (`board.focus`) lands on its first row), the Autopilot run's own sections in an Autopilot tab (right after it), **Now** (the turn's current step, subagents and jobs, the sessions at work, the finished ones folded into "n done"; titled "Child sessions" when nothing runs), the **plan zone** (titled "Goal & todos", "Todos" or "Goal" by what it holds, never "Plan", which is the plan-mode card's word and what Needs you says for a plan up for review; its header carries the one bar and "3/7"; the goal is its first line with its status, budget and time; then the open todos) and **Current work**. Folds are persisted per zone (`workBoardCollapsed`); a pref saved under the earlier ids drops those folds when read (`migrateCollapsed`): one folded old section (a failed check, a child list) would otherwise fold a whole zone, and Needs you must never start folded from an old pref.
- No review buttons: the agent that opened a child compares, merges and closes it itself (`ompdesk_compare`, `ompdesk_merge`, `ompdesk_session_stop`); a child that needs the person is a row of Needs you and a notification.
- Now: the turn's live step with its tool icon, target and clock (the finished calls are the work card's list, on screen beside the board); subagents (task, elapsed; current step, tokens and model in the tooltip) and background shells, the ones a subagent runs itself included (stock's jobs tree; the Background tasks view nests them under their subagent); a click opens the subagent in the side panel / Background tasks; sessions the agent opened (a second muted line with the step or last report, a clock). The Work tree is an icon button in the head of the section that lists the children (Now, or Needs you when every child waits), not a row.
- Plan: finished tasks fold into "N done", the active row is emphasised; the list itself is edited in the todo card (Edit todos), which the board's collapsed dock twin otherwise leaves to the board. The goal row's figure is the larger share of its budget or time (warning colour from 90 %).
- Quota gauges: always in the board's head, beside the session's spend. Round 2 hid them while the sidebar's expanded usage block was on screen (both read `lastUsedAccounts`); the user's report of 26 Oct 2026 (the gauges "disappeared" on the Mac) undid that: the sidebar's block sits at the bottom of a long list, the board is where the person looks while work runs.
- Current work: what the turn's own edit tools changed (and its children's), the newest passing or running check with its verdict, running dev servers, sessions sharing the checkout, the memory the turn recalled.
- Motion: one running animation, the head's pulse while something works; rows fade in and out once
  (`usePresence`) and otherwise stay still, so a live row is marked by colour (an info dot, a tinted icon), not by
  movement. Every animated row cost the GPU process about 2 % of a core while the transcript streamed, whatever
  the animation (an earlier version pulsed each live row's dot and swept a 1 px line under it). All motion is off
  under `prefers-reduced-motion`.
- One shared one-second clock (`useNowTick`) drives every timer; the board re-renders once a second only while
  something runs and the window is in view. Clocks read coarsely (`elapsedLabel`): nothing in the first ten seconds, ten-second steps under a minute, then whole minutes, so a column of running rows changes a few times a minute instead of every second.
- The account row and the running section read `get_usage` and `get_jobs` through one poll per tab
  (`hooks/use-tab-poll.ts`), shared with the sidebar's usage lines, Stats › Usage, the Settings model tables and
  accounts and the usage-limit notice (`use-usage-reports.ts`), and with the dock island and the Background tasks
  view (`use-background-jobs.ts`).
- Measured with `e2e/flow-performance.e2e.ts`'s `daily` flow (1600 px, the user's largest session, fake omp, 16 Oct
  2026; share of one core, v0.31.0 without a board in brackets): streaming beside a busy board, GPU process 18 %
  (18 %; 36–40 % with the per-row pulses and sweeps), no frame over 10 ms; agents running after a turn, renderer 9 %
  and GPU 10 % (8 % and 24 %; 28 % and 39 % before this work); idle IPC 30 calls a minute (28), none while hidden.

## Round 2: four zones (25 Oct 2026)

The user's brief (verbatim, "토큰 아끼지말고 더 개선할래 리디자인급으로": go further, redesign level) after round 1 (v0.73: truthful head, callout blocks, kind icons, coarse clocks) polished the nine-section column without changing it. Defects still on screen: the head sentence wrapped at 320 px even at 1600 ("6개 실행 중 · 1개 답변 대기 · 하위 세션 1개 답변 대기 · 1개 실패", "1개 실패" alone on line two); what needs the person was split over three places (own questions and plan review, a failed check, a child waiting for an answer as a tinted row lower down); nine possible sections in one column, so at 1600×1000 the result (Current work) sat below the fold; "Tools used" repeated the live work card in the transcript beside it; the Goal section repeated the goal dock bar and the quota gauges repeated the sidebar's usage block, both on screen at once; "Open the work tree" was an action row among status rows; a finished board said "Idle" and nothing about what the turn had done.

Hard constraints kept: one line per row (only child rows have a muted second line), no row widens the board, long lists fold into "+N more", no close and no setting, docking by the existing fit rules, the strip expands in place, "Current work" keeps its name and content, the money rule, children at work stay visible in the transcript, nothing visible by default disappears unless it duplicates what is on the same screen, one running animation.

Two structurally different directions were built over the same stores (throwaway prototypes behind the harness's `?design=x|y`), captured in ko dark and en light at 1600×1000, 1300×900 (the narrowest dock, 264 px), 390×844 and in the live "waiting on children" state, and compared:

- **X — four zones.** *Needs you* (every ask in one callout: a question, a plan review, a failed check, a child waiting for an answer; each row says which in a fixed-width word and jumps to it), *Now* (the turn's current step, subagents, jobs and running children in one section), *Plan* (the goal as the lead line, the bar in the header, then the todos) and *Current work*. A one-clause head.
- **Y — glance + drill.** Today's sections, but each says one line in its header when folded ("실행 중 6 · 가장 오래 4분", "할 일 7/12 · Fold every finished step", "현재 작업 · 파일 7개 +112 −37"), and the least urgent open sections fold themselves until the board fits its room (a fold the person opens stays open).

| | Before | X | Y |
| --- | --- | --- | --- |
| Docked, busy, 1600×1000 (952 px of room): board height | 1013 px, Current work's last rows below the fold | **850 px**, every zone above the fold | 931 px, every section above the fold with 21 px to spare |
| Narrow dock, busy, 1300×900 (852 px of room) | 1013 px | 850 px (fits, 2 px spare) | 744 px, because todos and goal fold into summaries |
| Live, waiting on children, 1600×1000 | 991 px | 769 px | 909 px |
| Quiet after a turn | 302 px, head "Idle" | 278 px, head says the outcome | 302 px, head says the outcome |
| Phone strip open, panel capped at 404 px | 1313 px (3.3 panels) | 1078 px (2.7) | 493 px (1.2; only Needs you stays open) |
| Head | 93 px, two lines | 51 px, one | 76 px, one (a plan bar line) |
| Nothing hides behind a click | yes | **yes** | only when the room is short (folded sections show a summary, their rows need a tap) |
| Scannability | nine headers | four zones, one callout | nine headers with summaries |
| Risk | | section ids change (persisted folds are mapped once), tests of the removed sections | a layout measurement that re-folds sections as the room changes (flicker at the edge, hard to test in linkedom) |

### Pick: X

1. It is the shortest board in every state that matters: all of it is above the fold at 1600×1000 and in the narrowest dock, with no measurement, no auto-fold and no state the person did not choose. Y reaches its height by folding, which is the hiding the user ruled out, and it adds a feedback loop between content and room.
2. It answers the one question the board exists for. In X "what needs me" is one block with one count, said the same way by the head, the block, its live region and the strip's collapsed label (`boardCounts`); in Y the same things stay in separate sections and the figure is a chip.
3. It deletes duplication instead of summarising it: "Tools used" (the live work card beside the board lists the same calls; Now keeps the live step), the Goal section (its figure is the plan's lead line; the dock bar says the objective) and the head sentence's repeated figures.
4. Korean fits: the longest clause ("3개 확인이 필요해요") and "실행 6" share the 264 px line; row tags are two syllables in a 2.6 em column.

What replaced what X removed: the head's multi-clause sentence and its "1개 실패" / "하위 세션 … 대기" clauses → Needs you's count and rows; "Tools used" → Now's one live step (the finished calls are the work card's list); Running, Child sessions → Now; Todos, Goal → Plan; the plan bar from the head → the plan's own header; "Open the work tree" row → an icon button in the head of the section that lists the children.

### Quota gauges and the Goal on a desktop

Both are visible twice on a docked desktop (the sidebar's usage block and the goal dock bar over the composer). The gauges are hidden by one CSS rule only while the sidebar's expanded usage block is on screen (the phone's strip, a window whose sidebar is folded and a folded usage block keep them; a metered provider's real charge, which the sidebar does not show, always stays). The goal is not hidden: its dock bar says the objective and its state but not the budget and time meter, so the board keeps it as the plan's lead line (one row, about 26 px) with the larger share of budget or time as its figure.



## Not done

- Reorder animations. Rows fade in and out once through `usePresence`; a row that moves jumps.
- A cost line in the idle summary (no per-turn cost is in the renderer's stores; deriving it would break the
  "read, never derive" rule).
