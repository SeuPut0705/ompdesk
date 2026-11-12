# Scope: which session tags' processes OMPdesk ends

## The promise

OMPdesk ends the processes of a tag only when the tab that held it was closed outside a quit, or when the tag's session did not come back at a launch; a tab that is open (started, or restored and not started yet) never has its processes ended; at rest nothing is left in the file that no open tab answers for; and a tag with running processes is never forgotten.

## The harm

`procs.end` kills every process that carries a tag, by force after five seconds. Ended for the wrong tag, a live session loses its omp, its dev server and its unsaved work in the middle of a turn. Not ended, or forgotten, the processes of finished work stay until the computer runs out of memory (the owner's report, 12 Nov 2026: a 16 GB Mac froze).

## Why tests miss it

The risk is in orders: a session reopened while the core is still ending its closed tab's tag, a tab started between the launch's restore and its sweep, a crash while an end is in flight, a quit that disposes every tab. `session-processes.test.ts` pins the orders someone thought of; the model checks every order within the bounds.

## Bounds

2 sessions, 3 tags, 3 launches (`MC.cfg`: 1,817,421 distinct states, depth 23, about 40 s); any interleaving of start, spawn, close, quit, crash, launch, sweep, the core's answers and the retry. With 4 tags (`MC_four_tags.cfg`, run by hand before the retry was modelled, about 7 minutes): 9,802,091 states, depth 24, no violation. 3 sessions and 5 tags did not finish in 10 minutes: not checked. Logs: `evidence/`.

## In the model

`SessionProcesses.open` (takeover or a new tag), `close` with its frozen check, `sessionReleased`, `sweep`, `#endEntry` (the end in flight, its success, its failure and the retry of one that left something running), the file as every non-free entry, `SidecarManager.dispose` as the tab's release, a quit (`quitApproved`, then the teardown), a crash at any moment, the next launch reading the file.

## Not in the model

- The core's `procs.end` itself (which processes carry a tag, the polite step, `keepArg`, `own`): tested on real processes in `crates/core/src/procs/mod.rs` and `session-processes.test.ts`.
- Hosted tabs' delayed sweep (`hostedGraceMs`, `hostedHeld`): the same shape as `Sweep` taken later, with "held now" in place of the keep set; pinned by "gives a hosted session's device the host tab's grace to come back".
- A tab whose session file is not known at its first spawn (it never takes a tag over; its tag is ended at the next launch).
- The file's write (`writeFileAtomicDeferred`): the model reads the file as the registry's entries. A crash between a new tag and its write leaves processes with a tag no file names: never ended, never wrongly ended.
- Liveness (that an end eventually answers): safety only.
