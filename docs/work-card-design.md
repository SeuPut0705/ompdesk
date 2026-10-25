# Work card — findings and steps, design record

A finished work card (`chat/ExecutionGroup.tsx`, rules in `chat/work/`) answers three questions without a click:
what the run changed, what its checks said, and — when something failed — why. This records how the row that
answers them was chosen, and how the opened card lists its steps.

## What the row holds

The facts line in the head says *what* ("1 file changed +37 −0 · type check failed · 3 commands"). The findings row
under it says *why* and offers the next click: the failing step's cause, **Tests ✓ N**, **Open Changes**,
**Preview**, and a button that copies the card as plain text. It is built from the run's ledger alone (no model
call) and only for finished cards, so streaming never moves it: a running card has no findings row at all, and the
row appears once, with the head's final facts.

## Directions compared

Captured on the fake omp's "fixture work view" run with `OMP_GUI_TEST_WORK_RICH=1` (search steps share an intent, a
test run, a dev server), passing and with the type check failing, en light and ko dark, at a wide (1440) and a
narrow (420) window. The prototypes were throwaway CSS and a flag on the card, removed once the choice was made.

| | A — chips inline in the head | B — chip row under the head | C — B plus a step list by intent under the head |
| --- | --- | --- | --- |
| Density | Densest: no extra line | One extra line (two when the cause is long) | About seven lines taller (six intent rows and "+5", under the chips) |
| Scannability | Worst. The head's right column is shared with the facts line, which lost its first facts ("1 file changed +37 −0") to the chips; the cause cannot fit, so it is an unlabeled ✕ icon; four bare icons in a row carry no words | Best. The cause is readable in full in the danger colour, chips carry a word and an icon, Copy sits apart at the end | Good for the chips, then noise: without an intent the row is the bare tool name ("write", "read", "task"), and it repeats what the opened card says |
| Clicks to the failing step | 2 (the ✕ icon is guessable, not obvious) | 1 (the cause, a labeled button) | 1, but the list invites reading it instead |
| Reflow while streaming | None if finished-only, but the head's facts line would reflow as chips appear | None: the row is finished-only and appears under an already finished head | None for the same reason, but its height is the largest surprise when a long run ends |
| Narrow window | The head cannot hold both; the narrative went to "Wo…" | The row wraps whole chips onto more lines, nothing is cut | The list truncates every label |

**Pick: B.** The cause is the one thing a person scanning a red card wants, and only B has room to say it in
words; chips are labeled buttons, so each is one click to the thing it names. A hides the cause and squeezes the
facts. C's list is the opened card's job, and without stock intents it is a list of tool names.

## The opened card: steps by intent

Direction C's idea survives where it costs nothing: inside the opened body, `groupSteps` (`work-steps.ts`) lines
consecutive calls of one stock intent (`ToolCallContent.intent`, then the arguments' `intent`/`i`; a generic
"Running requested command" names nothing) under one row — "Checking the types · 3 steps" — and folds two or more
consecutive collapsible reads into the transcript's own read-group card. Rules that keep it honest:

- Every call stays one `ToolCard`; a group is a closed row, never a summary that replaces them. A run of one call,
  and calls with no intent, stay plain rows.
- A group with a failed call opens by itself, and again when a finding asks for a step inside it (Error, Tests).
- Only thinking may sit between two calls of one intent; a visible reply or a note ends the group.
- Only a finished card groups. A running card keeps one bubble per message as it arrives, so the live list never
  rearranges under the reader's eye; it lines up when the run ends.
- `transcriptDetail` full mode has no work card and keeps its own read grouping; its tool rows are `ToolCard`s too,
  so they lead with the intent as below.

### Rows by intent (R3-4, 25 Oct 2026)

Opened, the 165-step v0.73 redesign turn read as tool names: "Read board-cmp-phone.png", "Run command grep -n …",
with a "Thought · 144 words" line between most steps (28 % of its rows). Every one of its 352 calls carried an intent.

- A row leads with what the agent meant to do (`stepIntent`: "Montaging board captures side by side"), and the
  call's target (file name first, command, pattern) follows muted. The target starts from no width and takes only
  the room the intent leaves (`AFTER_INTENT_CLASS`), so a narrow row clips the target first and the intent only when
  it alone does not fit. A clipped target left under about four characters (32 px; at 390 px, 16 rows of the long
  turn showed "g." or ":") is not drawn (`useSliverGuard`: one shared `ResizeObserver` marks it `data-sliver`, no
  re-render), and the opened body then names the file or command. A row with no other target names the tool that
  ran after the intent (an MCP server's tool, a device). A call with no intent, a generic one, and a call inside an
  intent group (whose row already says it; reads in a read group there too) keep the tool's label and target. A
  target that only restates the intent (a wait's `i`, a subagent's, also when the row cut it to its first line or
  160 characters) is said once. A screen reader hears the kind of tool first, then the intent, the target and the
  state ("Run command, Checking the types, bun run check:types, Done"); failed and interrupted rows and groups show
  their state in words.
- An opened body starts with what its row did not say. `ToolCard` measures its target while the body is open (a
  `ResizeObserver` on the target's own box, so a narrowed window, split, side panel or rotation counts, and so does a
  longer intent, state or time beside it in a row already at its widest; a new target text is measured again) and passes
  `rowShowsTarget` only while the target shows whole. Then edit, write and read bodies keep an "Open file" link (the
  file name read aloud with it, an edit's first changed line beside it) instead of the path and `+N −M`; a URL or
  internal resource read keeps nothing about it; bash keeps its exit, timeout and wall-time badges without the
  `$ command` line (a multi-line command always keeps it), and says "(no output)" when nothing else is left. The
  wall time stays because the row's time counts from the assistant message and so includes the model's turn. A
  write body no longer repeats the row's diagnostics chip.
- Thoughts fold into the step after them: the row counts their thinking blocks ("1 thought") and, opened, shows
  them first, each its own collapsed Thought line. A run of thoughts no step follows (the card's end, or before a
  reply) stays one row, their thinking joined and their usage summed. With thinking hidden (`hideThinkingBlock`) a
  row neither counts nor opens to them. On the long turn no "Thought · N words" line is left between steps.
- A lone read is a plain row that opens straight to the file; two or more consecutive reads still fold into the
  read-group card, which leads with their intent when they came as one run of it.

## Chips

- **Tests ✓ N**: the last test run passed (N is the runner's own count); opens the steps at that run. No chip for a
  failing run: the cause covers it.
- **Error / cause**: the failing check's or command's first error line, else the word "Error" for a failed call of
  any other tool; opens the steps, opens a closed group around the failing call, opens the call and scrolls it to
  the middle (`reveal-step.ts` looks for the card by its `data-tool-call-id` for two seconds, because a big card
  mounts its rows in slices).
- **Preview**: a bash result that printed a loopback address with a port from a server-looking command or banner
  (`devServerUrl` in `lib/panel-auto-open.ts`, the rule the opt-in **Open dev servers in Preview** setting also uses);
  opens the Preview panel on that address.
- **Open Changes**, as before.
- **Copy summary**: the head's facts and time, the cause, each changed file with its `+N -M`, each check as the head
  words it, and the preview address, as plain text through the clipboard helper.

## Redesign (24 Oct 2026): the stat strip

The card's problems at the time: a failed type check showed a green ✓ and "Work complete" with only the cause line red;
the head's fact line was a six-part gray sentence that lost parts from the end on a narrow card; "128 tests passed"
and the "Tests ✓ 128" chip said the same thing, and so did "1 file changed" and "Open Changes"; five bands were separated by
full-width rules; the tool strip was twelve unlabeled icons; the opened steps hung outside the card on a rail.

Two structures were prototyped on the fake omp's rich run and compared at 1440 and at the app's narrowest window:

| | A: stat strip | B: receipt |
| --- | --- | --- |
| Shape | head, then one row of labeled metric buttons | head, then one sentence per outcome, each its own button |
| Height, wide, failed / passing | 355 / 323 px (before 468 / 436) | 451 / 437 px |
| Narrow | chips wrap whole, the cause takes two lines | the cause drops under its sentence |

**Pick: A.** It is the shortest, and a failing run reads in one pass: the danger ✕, the one loud chip, the cause. B reads
well for the cause but is as tall as the card it replaced for a passing run.

What shipped: the head is mark, headline, time and toggle, and its mark tells the truth (a run whose own check or
command failed is a danger ✕, "Done, but a check failed" or, for a command that is no check, "Done, but a step
failed", with a danger-edged frame). The row of facts is one button per
check kind, the changed files, the preview and Copy, the cause under it. The head keeps only the facts the strip and the
agent lanes do not say; all of them stay in its accessible name and in Copy summary. The lanes stay listed (their
conclusions are content), the card is one frame with no rule inside, the replay strip is labeled, and opened steps sit
inside the frame on a quiet well. B's idea of folding the agents behind a metric was dropped: nothing visible by default
hides behind a click.

## Redesign round 2 (25 Oct 2026): one surface

Round 1 polished the structure. Its problems, from the card on the harness (`?card=pass|fail|cmd|one|live`, `?board=busy&children=wait`):
three views of the same commands (metric row, the "Outcome" disclosure, the opened steps), with the disclosure a
collapsed row that said nothing until opened; a row of unlabeled tool icons repeating the head's toggle; a head that said
"39.0s 1 command" beside chips that already said it; "✕ Tests 2" (2 what?); a live card whose ~270 px stage dumped a
coordination call's raw arguments over empty space, with the goal and todo drawn inside it while the dock and the board
showed them too; a cause line that `truncate` cut to one line though its two-line clamp was written; and a one-command
card 105 px tall. Two directions were built as throwaway prototypes (CSS keyed on `html[data-design]`, one harness flag)
and captured at 1440 and 390, Korean dark and English light:

| | before | X: one surface | Y: outcome list |
| --- | --- | --- | --- |
| Finished, shape | head, chips, cause, lanes, Outcome, media, strip | head, **verdict block** (failed), chips, lanes, media | head, one always-visible row per file group, check and failed command, lanes, media |
| Passing run, 1440 / 390 | 321 / 411 px | **259 / 303** | 344 / 413 |
| Failed check, 1440 / 390 | 353 / 449 | **312 / 383** | 344 / 413 |
| Failed non-check command | 353 / 449 | **330 / 383–421** | 373 / 450 |
| One-command card | 105 / 111 | 43 / 41 | 43 / 41 |
| Live, several steps | 483 / 514 | 282 / 317 | **180 / 215** |
| Live, waiting on children | 484 / 493 | **123 / 136** | 123 / 136 |
| Cause readable | one line, cut | two lines, whole | one line in a row, cut at about 40 characters |
| Live output | stage, 270 px | stage, 160 px, every tool's surface | last three lines of a command only; diffs and reads not shown |

**Pick: X.** A passing run is the common one, and Y's rows make it taller than today (344 against 321) because it always
shows three or four rows; X is 259. A failing run reads in one pass in X: the verdict, the exit code and the whole cause in
one block. Y keeps the cause to the width of one row (the user's one-line rule), so the thing a person scanning a red card
wants is cut. Y's live card is the shortest, but only because it drops the stage: an edit or a read in progress would no
longer be visible, which is the live card's reason to exist. X keeps every tool's own surface in a stage that is 160 px
for every step (a measured 483 to 282 px in the harness, the head and the stage the same height across five kinds of
step) and removes what was wrong with it.

What shipped, and where the facts of what was deleted live now:

- **The head** draws its time, one step-count toggle and the copy button (`omp-work-copy`, 36 px to reach, over nothing of
  the toggle's tap), plus the token meter. "N commands", "N failed" and the read/search counts are gone; every fact stays in
  the toggle's accessible name and in Copy summary.
- **A failed check or command is a verdict block** (`data-work-finding="error"`): its sentence ("2 tests failed", "git push
  failed"), the exit code on its right, the cause under it up to two lines (the `truncate` class that defeated the clamp is
  gone), one button that opens the failing step. Passing checks stay short chips (Tests 128), then Files N +a −r, Preview,
  and a chip for a stopped command or one whose result never arrived.
- **The Outcome disclosure is deleted.** Its exit code is on the verdict block; its per-file +/− is in Changes (the Files chip
  opens it) with the total on the chip; its per-command verdicts are the chips and, per call, each `ToolCard` in the opened
  steps. It was collapsed by default, so nothing visible by default went. Pictures, audio and video it also drew stay
  (`WorkMedia`).
- **The replay strips are deleted**, finished and live, with the "while you were away" chip (`chat.work.catchUp`): the strip
  repeated the head's toggle, and a card that is open lists every step. The strip of an agent lane the reader opened stays.
- **The live card draws no goal and no todo row.** The dock above the composer and the work board carry them
  (`WorkspaceDock` no longer yields to the card: `carriedByWork` and `stores/live-work.ts` are gone, with `GoalDockBar`'s and
  `AutopilotDockRow`'s inline mode and `WorkTodo`). A finished card keeps its recorded todo as one read-only row.
- **A coordination call is said in words** (`work/coordination.ts`): "Continues when one of 2 sessions reports", "…all 3
  sessions report", "Waiting on Skill packs", "Waiting on your sessions", else "Working with your sessions". Raw arguments
  are never drawn, and the stage keeps the last real surface dimmed (or never opens) instead of an argument table.
- **A command that has printed nothing** sits as a prompt line at the top of the stage, not as a pill in the middle of an
  empty one.

Phone: the facts start at the card's inset, the chips are compact and the dev-server chip is its globe alone, so the usual
three chips fit one row; with four chips (files, two checks, preview) they still wrap, because a phone's chips keep their
14 px touch gap.
