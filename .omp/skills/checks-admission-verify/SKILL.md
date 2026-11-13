---
name: checks-admission-verify
description: "Checks check control's admission: no pool over its limit, one admission per job, release lane first, FIFO in a lane, cancel only a superseded run, reuse only a green digest, pause, held-entry leases. Use when changing native/ompdesk/crates/core/src/checks/admission.rs or ChecksHub::start, or when asked whether a release job can wait behind a branch job, a job can run twice, or the hub can cancel a person's or a release run."
---

# Check control admission verification

## The promise and the harm

The hub's admission never runs more jobs than a pool holds (GitHub macOS 5, the account's 40 hosted jobs, a computer's heavy slots, outside jobs counted), admits each job once, gives a free place to the higher lane (release, land, branch, local) and then to the earlier arrival, cancels only a run that a newer run of the same repo, ref and workflow superseded (never a release, merge-queue or ungoverned run), answers `reused` only from a green run of the same input digest, starts nothing while the owner paused it, and drops a held entry whose lease lapsed. Broken, 71 macOS jobs queue again and a release waits hours, a job runs twice, a person's run is cancelled, or an agent is told green for inputs nothing tested.

## Coverage

| Check id | Tool | Covers | Model |
|---|---|---|---|
| `checks-admission` | TLC 1.8.0 | `native/ompdesk/crates/core/src/checks/admission.rs` (the actions) and `checks/hub.rs` (the loop and start that call them: `Core::submit`, `Core::pump`, `Core::dispatch`, `Core::settle`, `Core::pause`); each action's `@code` tags name the lines | `formal/checks-admission/tla/ChecksAdmission.tla`; action table `formal/checks-admission/CORRESPONDENCE.md` |

Sync commit: `syncCommit` of `checks-admission` in `formal/manifest.json` (the manifest wins). Stamped by `gh workflow run formal.yml --ref <branch> -f only=checks-admission -f stamp=true` on the final tree; until then null.

## Bounds and assumptions

- One pool of 1 or 2 places with 4 jobs (5 in the deep run); macOS limit 1 under an account limit of 2 with one outside macOS and one outside Linux job, and under an account limit of 3 with two outside Linux jobs; supersede and reuse scenarios of 3 to 5 jobs; liveness under the fairness in `Properties.md` on one pool and on the account. Full list: `formal/checks-admission/SCOPE.md`.
- Assumptions the code must keep (A1 to A5 in `CORRESPONDENCE.md`): one admission step at a time; the place is in the hub's ledger before the dispatch is awaited; a failed dispatch is never requeued; lane, pool, key and digest are fixed at `start`.
- The account hold (F1, decided 14 Nov 2026): a waiting release entry whose own pool is full holds one account place that jobs behind it may not take (`Holds`, `HeldAhead`). P12 `ReleaseKeepsItsAccountPlace`: only two outside jobs started after it can keep such a release job out once macOS frees. Outside jobs are never governed; the hold is one place of slack against them, not a guarantee.

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`. Never on a person's computer (AGENTS.md › Heavy checks): on the pushed branch,

```bash
gh workflow run formal.yml --ref <branch> -f only=checks-admission -f tier=deep
```

Locally only the parse check: `bun <tools-dir>/scripts/tlc.ts formal/checks-admission/tla/ChecksAdmission.tla --sany-only --config formal/checks-admission/tla/MC.cfg`.

`PASS` (exit 0): no counterexample within the bounds, not "the code is correct". `FAIL`: a property broke, a run did not end as the matrix expects, a mutation was MISSED or an `@code` tag no longer resolves. `NOT CHECKED` (exit 3): report "not checked", never a pass.

## A failure: real bug or modeling error?

Replay the trace against the action table. A step the code cannot take is a model error: fix the model and say so. Every step possible is a design or code bug: tell it in the hub's words and pin it with a failing test of `admission.rs` over `FakeGithub`/`FakeLocal` first. Never weaken a frozen property, add a constraint or add fairness to make it pass.

## Tagging the code when admission.rs lands

Put `\* @code native/ompdesk/crates/core/src/checks/admission.rs:<lines> <what>` above each action `CORRESPONDENCE.md` marks **code**, add the file to `covers`, check that each action is still one atomic step of the code (an `await` inside one splits it), rerun, then stamp with `-f stamp=true`.
