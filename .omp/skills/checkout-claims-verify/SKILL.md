---
name: checkout-claims-verify
description: "Checks that shared-checkout claims stay right: a file a session is writing is never released to a peer before its call ends, a write nobody committed stays its session's claim, a committed file is nobody's claim, and an agent's run end settles only its own calls. Use when changing ClaimBook or judgeClaim in resources/gui-bridge/modes/checkout-claims.ts, CheckoutLedger.settle/settleAll in checkout-peers-core.ts, the journal or hooks in modes/checkout-peers.ts install, or CheckoutPeerCoordinator #pass, #statusOf, #retire, #send in src/main/checkout-peers.ts; or when asked whether a peer can overwrite a session's running write."
---

# Shared-checkout claims verification

## The promise and the harm

A file session A's call is writing is A's to every peer until that call reports back; a write of A's nobody committed stays A's claim; a file A committed is nobody's claim; an agent's run end settles only that agent's calls. If it breaks, a peer may drop or overwrite A's running write, or a peer's own change is guarded as A's. The area regressed four times in three hours (27 Oct 2026) before this model existed.

## Coverage

| Check | Tool | Covers | Model |
|---|---|---|---|
| `checkout-claims` | TLC 1.8.0 | `resources/gui-bridge/modes/checkout-claims.ts` (`ClaimBook`, `judgeClaim`); `modes/checkout-peers.ts` `install` (journal, hooks); `src/main/checkout-peers.ts` `#pass`, `#statusOf`, `#retire`, `#send` | `formal/checkout-claims/tla/CheckoutClaims.tla`, `@code` tag on each action |
| generated sequences | vitest | the same invariants on the real `ClaimBook` and `CheckoutPeerCoordinator`, 3000 seeded sequences of 60 events | `src/main/checkout-claims.test.ts` |

Sync commit: the `syncCommit` of `checkout-claims` in `formal/manifest.json`.

## Bounds and assumptions

- Bounds: one file, a main agent and a subagent, one peer; calls are file tools, shell writes or the session's own `git commit -- F`. Fast: 2 calls, stamps ≤ 5, one restart, 2 commits or peer writes; own-commit: 3 calls, stamps ≤ 7, no restart; deep: 3 calls, stamps ≤ 7, one restart, 3 world events.
- Assumptions: the bridge answers requests in order; every call takes a stamp above every earlier one of its load; files are independent; stock's `agent_end` follows that agent's results. Full list: `formal/checkout-claims/CORRESPONDENCE.md`. Not covered: several files, folders, renames, repo peers, the guard's shell and git rules (`formal/checkout-claims/SCOPE.md`).

## Run it

`<tools-dir>` is the folder of the SKILL.md you see when you read `skill://ompdesk-formal-verify`.

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only checkout-claims            # fast tier: matrix and 10 mutations
bun <tools-dir>/scripts/verify-all.ts formal --only checkout-claims --tier deep
bunx vitest run src/main/checkout-claims.test.ts                                # the generated sequences, about 3 s
```

- `PASS`, exit 0: no counterexample within the bounds. Not a proof the code is correct.
- `FAIL`, exit 1: a property was violated, a mutation was MISSED, or an `@code` tag no longer resolves. The trace lists each step with its `@code` location.
- `DRIFT`: covered code changed since the sync commit; look at the model again.
- `NOT CHECKED`, exit 3: TLC could not be prepared. Never report it as a pass.
- The vitest test prints the seed and the event list of a failing sequence; replay it with `run(<seed>, 60)`.

## Does my change touch this?

It does when it changes when a claim starts, settles, reverts, is retired or restored (`ClaimBook`), how main judges a claim (`judgeClaim`, `#committed`, the `fresh` flag), what main remembers of a bridge (`#statuses`, `#retire`), or which agent's calls a run end settles. `grep -rn "judgeClaim\|ClaimBook\|retireFrom\|agentEnded\|#committed" src resources`.

## A failure: real bug or modeling error?

Replay the trace against the code, step by step, by its `@code` tags. A step the code cannot take is a modeling error: fix the model and say what was wrong. Otherwise it is a bug: write it as a failing test in `src/main/checkout-peers.test.ts` on the unchanged code first (F1 to F3 started that way), then fix. Never weaken a property in `Properties.md`, add a state constraint or fairness to make a run pass.

## Updating the verification for an intended change

1. Change the model from the code first; each action keeps an `@code` tag a reviewer can open, and one step in the code between two awaits stays one action.
2. A property changes only when the promise changed on purpose: write the old and new wording and the evidence.
3. Every new guard gets a mutation in `formal/checkout-claims/tla/mutations.json` that breaks it, and the generated-sequence test must fail on the same break (mutate the code, run it, restore).

## Moving the sync commit

Only after the checks passed on the committed code: `bun <tools-dir>/scripts/verify-all.ts formal --only checkout-claims --stamp`.
