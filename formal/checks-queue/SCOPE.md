# Scope: the merge queue of check control

Model: `tla/ChecksQueue.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`. The same properties on the real code, over generated orders of events: `any_order_of_events_lands_only_tested_commits_in_order_and_drains` in `native/ompdesk/crates/core/src/checks/queue_tests.rs`.

The model was written before the code (design check, 14 Nov 2026) and then tied to it.

## The promise and the harm

The base branch only ever receives, from the queue, a commit the check passed on as exactly that commit, as a fast-forward; entries of one goal land in the order they arrived; an entry is failed only when the check failed on it alone on the tip it was failed on; a withdrawn entry never lands; the queue never sits on work.

If it breaks, `main` gets a combination nobody tested (the reason a queue exists), someone's push to `main` is overwritten, a good branch is reported failed, or a branch its owner took back lands anyway. Why tests miss it: the harm needs an event between two of the queue's steps (a result arriving for a trial dropped meanwhile, a push to the base between the queue's test and its own push, a withdrawal while a trial runs).

## Modeled (in scope)

- The queue of one base branch of one repository: `LandQueue` (`native/ompdesk/crates/core/src/checks/queue.rs`): `enqueue`, `remove`, `form`, `next`/`advance`, `verdict`, `landed`, `moved`, `base_read`.
- Bisection over prefixes of a batch with what is known kept per base tip and entries, and carried over a landing only when the base is exactly the landed commit.
- The world beside it: a check result arrives later, also for a trial dropped since; anyone pushes to the base at any time; an entry is withdrawn at any time; the push and the queue learning how it went are two steps.

## Abstracted

- A commit is its content (the sequence of entries and outside pushes on it): building is concatenation, a fast-forward is "is a prefix of". Git's merge machinery, conflicts and merge commits are not in the model.
- The check is truthful and deterministic: red exactly when the commit holds a bad entry. A flaky check is not modeled.
- `Step` folds the build into the test: the model's test starts with its commit known. In the code a build is asked first and answered (`built`); a withdrawal or base move between the two drops the trial the same way.
- When a batch forms is any time (`Form` has no window): the batch window only delays it.
- Entries are numbered in arrival order and never queued twice.

## Out of scope (not checked)

- A build that does not merge (`built` with a conflict), a run lost without a result (`lost`), a base that refuses every push (`refused`), a branch queued again with a new commit, the save and `resume` after a restart: pinned by the unit tests in `queue_tests.rs`.
- Two queues for one base (two computers): each pushes only fast-forwards of commits it tested, so the base is safe; whether each drains is not checked.
- The runner: git, the queue's own branches, dispatching the check and reading its result.
- Several bad entries whose failures hide each other is in scope (`bad` is any subset); a change that fails only together with another (neither fails alone) is not: the model's check is per entry.

## Properties

| Name | Kind |
|---|---|
| `OnlyTestedLands`, `OnlyTestedRedFails`, `NoBadOnMain`, `LandsOnce`, `LandInOrder`, `WithdrawnNeverLands`, `LandedIsOnMain`, `TypeOK` | invariant |
| `NeverForced` | action property |
| `Drains` | liveness (weak fairness on the queue's own steps only, none on the world) |

## Bounds (formal.yml run 43491497374, 14 Nov 2026, before the `@code` tags)

| Run | Bounds | States, depth, time |
|---|---|---|
| `MC.cfg` | 3 entries, 2 goals, batches of 2, 1 outside push, 1 withdrawal | 18,183 distinct, depth 27, 2.1 s |
| `MC_three.cfg` | 3 entries, 1 goal, batch of 3, 1 push, 1 withdrawal | 40,780, depth 27, 2.8 s |
| `MC_order.cfg` | 3 entries, 1 goal, batches of 2, no interference | 500, depth 22, 0.7 s |
| `MC_moves.cfg` | 2 entries, batch of 2, 2 outside pushes, 1 withdrawal | 16,366, depth 26, 1.9 s |
| `MC_live.cfg` | 2 entries, batch of 2, 1 push, 1 withdrawal, `Drains` | 3,001, depth 20, 1.7 s |
| `MC_four.cfg` (deep) | 4 entries, batch of 4, 1 push, 1 withdrawal | not run yet |

Every `bad` subset is an initial state. Five sanity runs must fail (a batch lands, a culprit fails, a red batch is bisected, a green prefix lands alone, the base moves under a test). 11 mutations, all detected; `TypeOK` waived.

## Tools and files

- TLA+ with TLC: the concern is interleaving (late results, outside pushes, withdrawals), not arithmetic.
- Manifest id `checks-queue`; covers `native/ompdesk/crates/core/src/checks/queue.rs`.
