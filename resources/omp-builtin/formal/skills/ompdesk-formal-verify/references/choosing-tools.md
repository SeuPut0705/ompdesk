> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# Choosing the tool

Pick based on what can go wrong and what kind of evidence the user needs. Two checkers are bundled and
prepared on first use: TLC for TLA+ (`bun <skill-dir>/scripts/tlc.ts`) and Lean 4
(`bun <skill-dir>/scripts/lean-check.ts`). `<skill-dir>` is the folder that holds `SKILL.md`. Nothing is
installed until a script first needs it (see `tlc-cli.md`, "Where the tools live").

| Bug class / need | First choice | Why |
|---|---|---|
| Races, lost updates, check-then-act, TOCTOU | TLA+ (TLC) | Exhaustive interleavings at small bounds; shortest counterexample via BFS |
| Deadlock, lock ordering, starvation | TLA+ (TLC) | Deadlock detection is built in; liveness with explicit fairness |
| Message loss/duplication/reordering, retries, idempotency | TLA+ (TLC) | Network nondeterminism is natural to model |
| Distributed protocol (leases, leader election, 2PC, replication) | TLA+ | Industry-standard practice (AWS, Azure, MongoDB, Datadog); Apalache is an optional external tool for inductive invariants |
| Liveness ("eventually drains", "no request waits forever") | TLA+ (TLC) | Apalache/Quint temporal support is limited |
| Persisted or in-memory lifecycle (status field, session phases, UI mode) | TLA+ `OrderStateMachine` pattern, or a statechart (`statechart.md`) | Action property over the allowed transitions; the statechart port can derive the TLA+ |
| Big integer/data domains, long bounded traces | Apalache or Quint `verify` (optional external, see below) | SMT handles large domains that TLC must enumerate |
| Team reads pseudocode, not math | PlusCal or Quint | Same checkers, more familiar syntax |
| Pure function / algorithm correctness (parser, merge, diff, scheduler ordering) | Lean 4 | Theorems over all inputs; `decide` on small instances |
| Graph properties (reachability, acyclicity, topological order) for *all* graphs | Lean 4 | Induction over graphs; TLA+ can brute-force every graph of up to 4 nodes first (`DagScheduler`) |
| State machine with a finite transition table | Either: TLA+ for concurrency, Lean for exhaustive `decide` over the table | |
| "Holds for every N", certified result | Lean 4 (after TLA+ at small N) | TLC is bounded; Lean proofs are not |
| Reference implementation for differential testing | Lean 4 (`#eval`, compiled model) | Executable spec; compare outputs with the real code |
| Unbounded safety of a protocol | An inductive invariant (Lean, or Apalache as an optional external tool) | Induction: `Init ⇒ Inv` and `Inv ∧ Next ⇒ Inv'` |

A TLC pass means "no counterexample within the stated bounds". Say so in every report. Only a Lean theorem
without `sorry` and with the audited axioms (see `lean-pitfalls.md`) holds for all inputs.

## Combining them

The strongest pattern splits by concern: **TLA+ for the protocol, Lean for the algorithm inside it.**
Model the algorithm as one atomic action in TLA+ (for example, `Schedule == ready' = TopoReady(dag, done)`),
and prove that operator's correctness in Lean. The TLA+ checks catch interleaving bugs
around the algorithm; the Lean proof covers the algorithm itself for all inputs. Record the seam in
`CORRESPONDENCE.md` (`correspondence.md`).

## When formal methods are the wrong tool

Say so rather than forcing a model:
- The bug class is performance, resource leaks, or UI behavior → profiling, load tests.
- The logic is simple and sequential → property-based testing (Hypothesis, fast-check,
  proptest, QuickCheck) is cheaper and runs on real code.
- The system is deterministic and simulatable → deterministic simulation testing (DST,
  FoundationDB/TigerBeetle style) exercises real code; a spec can still guide it.
- The concern is one race in one function and a stress test with a barrier reproduces it
  in 20 lines → write the test first; model only if the fix is subtle.

A model is worth it when interleavings or input space are too large for a human to
enumerate, the cost of a bug is high, or the fix needs to be *proven* rather than *tested*.

## Bounds cheat sheet (TLC)

Start tiny, then grow one dimension at a time:
- Processes/workers: 2, then 3. Many real races need only 2.
- Values/keys: 2. Jobs/messages: 2–3. Retries/crashes: 0 → 1 → 2.
- Queue/channel capacity: 1–2 (capacity 1 often shows backpressure bugs).
- Graph nodes: 3 exhaustively (every DAG on 3 nodes), 4 if fast.

Counterexamples are usually short: the Specula study (2026, as reported by proof-skills) puts the median at 9
steps and the 90th percentile at 18, so small bounds find most bugs. That is a published observation, not a
guarantee for your system. State your bounds in the report.

## Optional external tools (not bundled)

OMPdesk does not install or run these. Use one only when it is already on the machine or the user asks for it,
and report its result as coming from that tool, not from the bundled checkers.

- **Apalache** (SMT-based checker for TLA+, https://apalache-mc.org) and **Quint** (typed syntax over
  Apalache or TLC, `npm i -g @informalsystems/quint`): for large or unbounded integer domains, bounded
  symbolic checks ("no bug in at most k steps for any values") and inductive-invariant proofs. Their
  liveness and fairness support is limited, so keep liveness in TLC. Apalache needs type annotations on
  `CONSTANTS` and `VARIABLES`, so a spec written for TLC is not accepted unchanged. Quint can also generate
  traces for model-based testing (`quint run --mbt`).
- **Kani** (bounded model checker for Rust, https://github.com/model-checking/kani): for a Rust function with
  bounded inputs where the code itself, not a model of it, should be checked (overflow, panics,
  `assert!`ed invariants). It checks real code up to loop-unwinding bounds; it does not replace a protocol
  model.

When none of these is available, say what the bundled tools cannot reach (unbounded domains, large data) and
state the bounds that were checked instead.
