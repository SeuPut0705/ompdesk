> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# Lean pattern catalog

All files are in `assets/lean-patterns/ProofPatterns/` (relative to the folder that holds this skill's `SKILL.md`). The
project has no package dependencies. It builds with `lake build` on Lean `v4.35.0` with no `sorry`. To audit it the
same way you audit your own models, run:

```bash
bun <skill-dir>/scripts/lean-check.ts <skill-dir>/assets/lean-patterns
```

`lake build` writes a `.lake/` folder next to the lakefile. In an installed OMPdesk the skill folder is inside the signed app
bundle, so copy the project to a scratch folder first and check the copy. `lean-check.ts` (and so `verify-all.ts`) does that
itself when the project sits inside an app bundle or is read-only, and says so; a copy you make yourself is still the
safer habit.

To reuse a pattern, copy the file into your project (created by `new-lean.ts`), rename the namespace, and replace the
state and steps with your code's.

## Explore.lean: shared machinery
- `Reach step init s` is reachability.
- `Reach.inv Inv h0 hstep` is safety by induction.
- `StepOf next` is the relation induced by an executable successor function.
- `validPath next s path = true` together with `validPath_reach` gives reachability of the path's
  last state. `decide` computes `validPath`, so a counterexample becomes a theorem.
- `bfs next bad init` returns the shortest labeled path to a bad state. `reachable next init`
  returns every reachable state within the fuel bound.

## Counter.lean: interleavings and the lost update
**Shape:** two threads, each with a `pc` and a local register. `RacyStep` has `read` and `write`
constructors, parameterized by thread.
**Bug:** `racy_lost_update` gives an explicit 4-step proof term reaching `x = 1` with both threads done.
**Fix:** `Step` with acquire, read, and write-and-release.
**Proof:** `Inv` states:
- lock ownership matches the holding threads,
- a thread's register is fresh while it holds the lock, and
- `x` equals the number of finished threads.

Then `cases hs … <;> cases t <;> grind [...]`.
**Non-vacuity:** an explicit 6-step path to "both done".
**Bounded version:** `decide +kernel` over `reachK`, relying only on `propext`.

## Idempotency.lean: async check-then-act, retries
**Shape:** inbox (with duplicates), a `seen` set, an `applied` log, and a list of tasks, each
`awaiting k` or `fin`. The event loop dispatches, and tasks resume in any order.
**Bug:** checking `seen` before the await and marking it after. `bfs` finds
`dispatch, dispatch, resume, resume`, and `buggy_double_apply` is that trace as a theorem.
**Fix:** claim `seen` synchronously when dispatching.
**Proof:** `Inv` includes "an awaiting task's key is already in `seen`". This is the
strengthening that `grind` needs; without it, the `dispatch` case fails and prints the
counterexample to induction.
**Adapt:** use the same shape for webhook handlers, message consumers, request dedup, and
"create if not exists".

## Queue.lean: channels
`Inv: recvd ++ chan = sent` gives no loss, reordering, or duplication, and `recvd_prefix` follows.
**Extend:**
- a `drop` constructor, after which the invariant becomes `recvd <+ sent` (sublist);
- a `dup` constructor, after which the consumer must be idempotent (combine with Idempotency);
- several consumers, each with its own program counter.

## Pipeline.lean: dataflow transformations
**Bug:** `batchBuggy` loses the trailing partial batch. `counterexamples` is a small exhaustive generator (every list
over `{0, 1}` up to a length bound) that finds it; `#eval` prints the first hits, and `decide` confirms the bug on
`[0]`. There is no random-testing package here: a bounded exhaustive search is the dependency-free substitute, and an
empty result is not a proof.
**Proof technique:** generalize the fold with an accumulator lemma (`foldl_step`), then
specialize it. When induction on the stated goal fails, generalizing the accumulator is
nearly always the fix.
**Adapt:** use this for any `fold`/`reduce`, windowing, chunking, dedup-by-key, merge, or join
stage. The standard properties are "flatten equals the input", "a permutation of the input",
and "a sublist of the input".

## Graph.lean: certificate checking
Rather than proving a production algorithm correct, prove a tiny checker correct:
`checkRank g rank = true` implies acyclicity and that every path increases in rank. Run the
checker on production output (in tests, or even at runtime). The same idea works for:
- a claimed shortest path (check the triangle inequality on every edge),
- a claimed matching,
- a claimed spanning tree, and
- a claimed schedule.

`reachable` gives executable reachability with fuel.

## StateMachine.lean: lifecycles
- `allowed` is the transition table. Facts about the table are checked by `decide` over
  `Status.all`.
- `last` records the last status change, so the action property "every change is an allowed
  edge" becomes a state invariant.
- **Bug:** a read, decide, then write cancel, found by `bfs` as `cancelRead, pay, cancelWrite`.
- **Fix:** a compare-and-set guard (`s.status = .pending` at write time).
- `transitions_allowed` holds for every reachable state.

## DagScheduler.lean: every graph
- `preds : Nat → List Nat` is an arbitrary dependency function; no acyclicity is needed for
  this safety property.
- `deps_respected`: every running task's predecessors are done, for every graph, every task
  count, and every interleaving.
- The buggy readiness rule (predecessors *started*) is refuted on the graph 1 → 2.
- Liveness (every task eventually runs, which needs acyclicity and fairness) needs a TLA+ model
  (see `tla-patterns.md`); Lean safety proofs do not cover it.

## RedundantGuard.lean: deleting code with a proof (see `simplify-equivalence.md`)
The current handler re-checks `k ∉ applied` before the side effect.
- `guard_implied`: the invariant already implies that check in every reachable state.
- `reach_iff`: the defensive and simplified handlers reach exactly the same states.

Together these justify deleting the check. The recipe: prove the guard follows from the
invariant, then prove equality of the reachable-state sets.

## Replay.lean: differential-testing driver
`lake exe replay < trace.jsonl` reads events and prints the model's outputs. See the next section.

# Differential testing: executable Lean models against production code

A proof covers the model. Differential testing checks that the model *is* the code, by
running both on the same inputs and comparing outputs. AWS Cedar calls this
verification-guided development: prove properties of a small Lean model, then test the
production Rust against it on millions of generated inputs every night.

## 1. Build the oracle

`assets/lean-patterns/Replay.lean` is a working driver (it builds with the project's `lake build replay`). It reads JSON
Lines events from stdin, steps the model, and prints one output per event:

```bash
lake build replay
printf '{"op":"send","m":1}\n{"op":"send","m":2}\n{"op":"recv"}\n' | lake exe replay
# null
# null
# 1
```

Replace `Q` and `apply` with the model's state and executable step. The step must be the
same `next`/`step` function the theorems are about (or one proven equal to it). Otherwise
you are testing a third artifact. Exit code 1 means an event the model could not parse or apply.

## 2. Generate inputs

- **From production:** record real event sequences (requests, messages, operations) in the
  same JSONL format.
- **Random:** a property-based generator in the *production* language (Hypothesis,
  fast-check, proptest, QuickCheck) emits sequences. Both systems consume the same file.
- **From the model:** `Explore.reachable` enumerates short sequences exhaustively, which is
  good for edge cases.

## 3. Compare

```bash
lake exe replay < cases.jsonl > model.out
prod-harness < cases.jsonl > prod.out      # thin wrapper over the real code
diff -u model.out prod.out
```

A difference is either a code bug or a model bug. Shrink it to the smallest failing
sequence (delta debugging, or the generator's shrinker), then decide which one is wrong
with the property statement in hand.

## 4. Put it in CI

Run a small fixed corpus on every PR and a large random corpus nightly. Keep every past
mismatch as a regression case. A passing comparison means no difference on the inputs tried.

## For concurrent code

Differential testing covers sequential semantics well. For interleavings, replay a recorded
*schedule*: log `(actor, action)` pairs from the running system (as in trace validation,
`trace-validation.md`), then check the sequence with
`Explore.validPath next init path` under `#eval`. A `false` means the code took a
transition the model does not allow.
