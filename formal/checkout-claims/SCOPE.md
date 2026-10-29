# Scope: shared-checkout claims

Model: `tla/CheckoutClaims.tla` (TLC). Properties: `Properties.md`. Code map: `CORRESPONDENCE.md`. Generated-sequence test of the same invariants on the real code: `src/main/checkout-claims.test.ts`.

## The promise and the harm

Sessions sharing a checkout learn which uncommitted file is whose. A file session A's call is writing is A's to every peer until that call reports back; a write of A's nobody committed stays A's claim; a file A committed is nobody's claim, so a peer's later change of it is never taken for A's; an agent's run end settles only that agent's calls.

If it breaks, a peer is told it may drop or overwrite a file A is writing (A's work lost), or a peer's own change of a file A committed earlier is guarded as A's (the peer cannot restore or commit its own file). The area regressed four times in three hours on 27 Oct 2026 (da0b403, 12ef99a/ca16de6, 323c8ed, dc4bada/089d329).

Why tests miss it: the claim lives in two processes (A's bridge and main), main's pass has three awaits (A's status, git, the retire), and the harm needs an event between them (a call starting while main waits for git, a restart between the read and the retire, a retire that arrives late). Each regression fix pinned one such order.

## In scope

- A's claim state machine: `ClaimBook` (`resources/gui-bridge/modes/checkout-claims.ts`): `begin`, `end`, `agentEnded`, `retire`/`retireFrom`, `restore`/`snapshot`, `#confirm`, `#revert`, `#clean` (a commit, restore or checkout of paths by A's own call that succeeded), `status`.
- The bridge's journal round trip across an omp restart (`modes/checkout-peers.ts` `install`: `session_shutdown`, `session_start`).
- Main's pass for one member with company: `CheckoutPeerCoordinator.#statusOf`, the git listing, `judgeClaim`, `#retire`, `#committed`, `#send` (`src/main/checkout-peers.ts`).

## Abstracted

- One file F, A's main agent and one subagent, one peer B that only receives what main tells it. Calls are file tools, shell writes, or A's own `git commit -- F`. Fast run: at most 2 calls, stamp counter ≤ 5, one omp restart, 2 world events (commits of F, by anyone, or B's own writes). Own-commit run: 3 calls, stamps ≤ 7, no restart. Deep run: 3 calls, stamps ≤ 7, one restart, 3 world events.
- One call per agent at a time (stock runs a batch's calls; a batch of several calls on F is several claims of one file in one step).
- A background job is a call that stays pending until its job ends: `end` with a job id plus `settleJob` is the same as one longer call.
- The guard's refusals and notices are not modeled: they decide which calls start, not what a claim means once taken. Of the git runs that make files clean only the commit is modeled; a restore or checkout of paths takes the same `#clean` path.
- Main's request timeouts are nondeterminism: A's bridge answers or main uses its last answer; a retire is answered, or arrives later, or is lost with a restarting omp.

## Out of scope (not checked)

- Several files, folders and renames (`holds`), submodules, NFD names, paths outside the worktree (pinned by `checkout-peers.test.ts`).
- Repo peers in other worktrees, hidden sessions, paired devices' tabs (the same coordinator; their peers lists only translate paths).
- The guard's shell parsing and git rules (`bridge-checkout-peers-rules.test.ts`).
- Main's own restart: OMPdesk quitting ends every omp, so main's memory and A's instance are lost together.
