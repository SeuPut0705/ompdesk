---
name: checks-queue-verify
description: "Checks that check control's merge queue lands only a commit tested green as exactly that commit, as a fast-forward, in order, and that a red batch's bisection fails only an entry tested red alone. Use when changing native/ompdesk/crates/core/src/checks/queue.rs (LandQueue: batches, bisection, the memo, landed/moved/base_read), or when asked whether an untested combination, a withdrawn branch or a forced push can reach main through the queue."
---

# Merge queue verification

## The promise and the harm

The base branch receives from the queue only a commit the check passed on as exactly that commit, as a fast-forward; entries of one goal land in arrival order; an entry is failed only when the check failed on it alone on the current tip; a withdrawn entry never lands; the queue drains. Broken, `main` gets a combination nobody tested, someone's push is overwritten, a good branch is reported failed, or a branch its owner took back lands.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `checks-queue` | TLC (tla2tools 1.8.0) | `native/ompdesk/crates/core/src/checks/queue.rs` (`LandQueue`) | `formal/checks-queue/tla/ChecksQueue.tla`, `@code` tags on each action |

Sync commit: see `syncCommit` of `checks-queue` in `formal/manifest.json` (the manifest wins).

The same properties run on the real code over 3,000 generated orders of events: `any_order_of_events_lands_only_tested_commits_in_order_and_drains` in `queue_tests.rs` (`cargo test -p ompdesk-core --lib checks::queue`).

## Bounds and assumptions

- 3 entries in 1 or 2 goals, batches of 2 or 3, 1 outside push and 1 withdrawal; 2 entries with 2 outside pushes; every subset of entries bad; 11 mutations. The batch of 4 is the deep tier. State counts: `formal/checks-queue/SCOPE.md`.
- Assumptions: one method of the queue at a time; the check is truthful; a commit is its content; the runner pushes without `+`. Full table: `formal/checks-queue/CORRESPONDENCE.md`.
- Not covered: build conflicts, lost runs, a refused base, a branch queued again, save and resume (unit tests), the runner's git, two queues on one base draining.

## Run it

Heavy checks run on GitHub's runners (AGENTS.md): push the branch, then

```bash
bun scripts/ci-run.ts formal --ref <branch> -f only=checks-queue
```

Locally only the parse check: `bun resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/tlc.ts formal/checks-queue/tla/ChecksQueue.tla --config formal/checks-queue/tla/MC.cfg --sany-only`.

`PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL` (exit 1): a property broke, a mutation was MISSED or an `@code` tag no longer resolves. `DRIFT`: `queue.rs` changed since the sync commit. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## Does my change touch this?

Yes when it changes `queue.rs`: how a batch forms, what `next` decides, when `memo` is kept or forgotten, what `verdict`, `landed`, `moved` or `base_read` accept, or when `leave_flight` refuses or aborts. A change only to `entries()` (what the page shows) or to the wording of a failure does not.

## A failure: real bug or modeling error?

Replay the trace against `queue.rs` with each row's `@code` location. A step the queue cannot take (two methods at once, a push that is not a fast-forward) is a model error: fix the model and say so. Every step possible is a bug: tell it in the code's words and pin it first as a failing case in `queue_tests.rs`, whose `World` holds builds, runs and pushes until the test answers them in the trace's order. Never weaken a property, add a constraint or fairness to make it pass.

## Updating it for an intended change

Change the model from the code first (one action per method; a new stage of a trial is a new value of `trial.stage`), change a property only when the promise changed on purpose (old wording, new wording, evidence in `Properties.md`), add a mutation for each new guard, run `bun formal/checks-queue/retag.ts` (a Rust location is a line range, which every edit of `queue.rs` moves), run it on the branch, then move the sync commit with `-f stamp=true` after committing.
