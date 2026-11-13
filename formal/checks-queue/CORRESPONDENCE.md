# Correspondence: ChecksQueue.tla ↔ code

Code: `native/ompdesk/crates/core/src/checks/queue.rs` (`LandQueue`). Every method takes `&mut self` and returns the effects to run; whoever owns the queue calls one method at a time, so each method is one atomic step.

| Model | Code | Atomic because |
|---|---|---|
| `Enqueue(e)` | `enqueue`: the entry joins `line` | one method call |
| `Remove(e)` | `remove` → `leave_flight`: refused (`Refusal::Landing`) for an entry in the prefix being pushed; a build or test whose prefix holds the entry is dropped (`abort`) | one method call |
| `Form` | `form`, called by `advance` when the flight is empty: the head of the line and the later entries of its goal, at most `batch_size` | inside one method call |
| `Step` | `next` + `advance`: longest prefix known green → `Effect::Land`; first entry known red alone → failed; else `Effect::Build` of the whole flight or of half the shortest prefix known red | inside one method call |
| `RunDone(c)` | `verdict(commit, green, …)`: taken only when `trial.stage` is `Test` of that commit; `learn` records it under the flight prefix's shas | one method call |
| `Push` | the runner's `git push <commit>:refs/heads/<base>` without `+` | git updates a ref as one compare-and-swap |
| `Landed` | `landed(candidate, tip)`: the prefix leaves the flight; red knowledge of longer combinations is carried only when `tip == commit` | one method call |
| `Moved` | `moved(candidate, tip)`: `forget`, the new tip | one method call |
| `SeeBase` | `base_read(tip)`: ignored when the tip is known or while a push is under way (`landing() > 0`); else `abort`, `forget` | one method call |
| `OutsidePush` | anyone's push to the base | environment |
| `memo` `<<tip, entries, verdict>>` | `memo: Vec<Known>` (`shas`, `outcome`), every entry about the current `tip`: `forget` empties it whenever `tip` changes other than by an exact landing | |
| `trial` | `trial: Option<Trial>` (`candidate`, `len`, `stage`) | |

## Abstractions that could hide a bug

- **The build is folded into `Step`.** The code has a `Build` stage between deciding and testing. A stale `built` answer is refused by candidate name, as a stale verdict is by commit; the unit tests cover the build's own orders, the model does not.
- **Entries are compared by their commit.** `memo` is keyed by the entries' shas, the model's by entry. A branch queued again with a new commit is a new entry to the memo; one queued again with the same commit on the same tip is answered from the memo, as the design asks ("skips combinations already known red").
- **The check is truthful.** A flaky red fails a good entry in the model's terms correctly (`OnlyTestedRedFails` holds: a run did report red). Reruns and quarantine are P4's.
- **`tip` in `landed` is what the runner read after its push.** The model reads `main` in the same step; a runner that answered with an older tip would make the queue test on a stale base, which its next push's refusal (`moved`) corrects, never a wrong landing.
- **One queue per base.** A second queue is the model's `OutsidePush` to the first.

## Found while modelling

- Knowledge carried across a landing is only sound when the base is exactly the landed commit. With someone's push on top, an entry known red "after the landed prefix" was never tested on the real tip (mutation `carry-memo-past-an-outside-push`, code `let exact = tip == commit`).
- A base read must not be taken while the queue's own push is under way: the new tip may be that push, and treating it as a move builds the landed entries again on top of themselves (mutation `base-read-while-landing`, code `self.landing() > 0` in `base_read`).
- A withdrawal must drop the trial whose commit holds the entry, or the result is recorded for entries never built together (mutation `no-abort-on-remove`).
