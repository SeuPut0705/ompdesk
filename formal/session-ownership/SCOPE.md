# Native session ownership order model

## Promise and harm

A tab must not lose its processes because a close, retry, or relaunch sweep overtook an active owner. A closed tab's leftover processes must remain discoverable until cleanup can finish. A bad end can kill an omp and its descendants. A forgotten tag can leave processes running without a later cleanup path. These orders cross receipt waits, the ownership mutex, and timer callbacks, so a finite set of example tests cannot cover all interleavings.

## Included

The model represents `Left`, `Live(owner)`, `Closing(owner)`, and `Ending`, as well as an unused tag. It represents a native owner tombstone, acquisition under a lock, same-session and same-hosted-kind takeover, fresh tags, quit freeze, disposal, an assumed captured exit receipt, release under the lock, the asynchronous end result, one retry with a state recheck, local restored and interrupted-marker keep, and hosted grace with a fresh hosted-held check. A crash and reboot reset volatile state; `Boot` covers only the constructor policy converting supplied saved entries to `Left`. The process end effect can remain in flight while other actions run.

## Bounds and evidence

`MC.cfg` requests two session identities, two symbolic owner IDs per session and kind, three fresh symbolic tags, and two launches. The Cartesian owner set has eight potential owners, not two. The deep matrix entry requests four tags and three launches. Tag symbols are never reused, so the bounds do not model random collision. The model is safety-only and has no fairness assumptions or state constraints. Deadlock checking is disabled in the matrix and mutation checker.

SANY 2.2 parsed and semantically checked the model with tla2tools 1.8.0 on 14 Nov 2026. The first parse found an invalid set-comprehension binder in `Boot`; the corrected parse had no semantic errors. No TLC run, mutation run, state count, depth, passing safety verdict, or mutation detection is claimed. Matrix outcomes remain expectations. Native source and its line references are pinned to `2e2887b77ff8b3a53ecb110f053dfd00a2e588ac`; the later formal coverage clarification does not change that native source. Main reported native unit acceptance under run `43590519539`; that evidence is separate from this unexecuted formal model. Base's lifecycle wiring remains an assumption. Do not stamp until the hosted model and mutation checks pass.

On the hosted runner, after integration, run the two checks with `<tools-dir>` set to the directory of `skill://ompdesk-formal-verify`:

```sh
bun <tools-dir>/scripts/tlc.ts formal/session-ownership/SessionOwnership.tla --matrix formal/session-ownership/matrix.json
bun <tools-dir>/scripts/mutate.ts formal/session-ownership/SessionOwnership.tla formal/session-ownership/mutations.json
```

The model lives in the canonical `formal/session-ownership` folder. Main assigns the shared manifest editor and dispatches the hosted proof on one fixed integrated source. This assignment changes no runner or manifest. Candidate `covers` are limited to `session_ownership/mod.rs:49-90`, `99-155`, `190-229`, and `232-426`, under the effect exclusions above. `journal.rs:11-39` and `sidecar/lane.rs:2056-2078` are assumption references only and must not be included in `covers`.

## Excluded

The model assumes the journal equals the in-memory non-free entries. Deferred or failed `write_kept`, ENOSPC/EDQUOT recovery, partial persistence, malformed records, filesystem identity, and crash timing around journal writes are not modeled. The native quota consumer test does not extend this model's coverage. The exact captured receipt and Base's join before `released(owner)` are environment assumptions; the join implementation and actual Base graph are not verified. It assumes trusted and valid host facts on acquisition; rejection of invalid facts and tag entropy are not verified. A session without a saved file, multiple simultaneous same-session and same-kind owners, reuse of one opaque `Owner` for multiple executions, per-device identity within the hosted kind, and multiple running app instances are outside the bound. Hosted-held is represented by an open hosted tab, not every independent host signal.

The model does not inspect OS process trees, actual `procs::end` signals, worker exemptions, process-list failures, or the scratch journal and disk-care file deletion. It represents left or kept as a retained outcome and own-only as a separate outcome. A transport error and own-only result retain the tag without arming a retry. A retained result arms at most one. The model makes no guarantee that timers fire, an exit receipt resolves, or a process end succeeds. These exclusions can hide defects and require separate tests and integration review.
