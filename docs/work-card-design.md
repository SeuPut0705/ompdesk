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
narrow (420) window. The side-by-side sheets are `/tmp/work-card/proto-compare-{pass,fail}-{wide,narrow}-{en-light,ko-dark}.png`
(the single shots are `proto-{A,B,C}-…`); the prototypes were throwaway CSS and a flag on the card, removed once the
choice was made.

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
"Running requested command" names nothing) under one row — "Checking the types · 3 steps" — and folds consecutive
collapsible reads into the transcript's own read-group card. Rules that keep it honest:

- Every call stays one `ToolCard`; a group is a closed row, never a summary that replaces them. A run of one call,
  and calls with no intent, stay plain rows.
- A group with a failed call opens by itself, and again when a finding asks for a step inside it (Error, Tests).
- Only thinking may sit between two calls of one intent; a visible reply or a note ends the group.
- Only a finished card groups. A running card keeps one bubble per message as it arrives, so the live list never
  rearranges under the reader's eye; it lines up when the run ends.
- `transcriptDetail` full mode is unchanged: it has no work card, and its own read grouping is untouched.

## Chips

- **Tests ✓ N**: the last test run passed (N is the runner's own count); opens the steps at that run. No chip for a
  failing run: the cause covers it.
- **Error / cause**: the failing check's or command's first error line, else the word "Error" for a failed call of
  any other tool; opens the steps, opens a closed group around the failing call, opens the call and scrolls it to
  the middle (`reveal-step.ts` looks for the card by its `data-tool-call-id` for two seconds, because a big card
  mounts its rows in slices).
- **Preview**: a bash result that printed a loopback address with a port from a server-looking command or banner
  (`devServerUrl`, the same rule that opens the Preview by itself); opens the Preview panel on that address.
- **Open Changes**, as before.
- **Copy summary**: the head's facts and time, the cause, each changed file with its `+N -M`, each check as the head
  words it, and the preview address, as plain text through the clipboard helper.
