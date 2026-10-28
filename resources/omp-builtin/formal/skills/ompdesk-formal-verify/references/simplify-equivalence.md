# Showing a simplification is safe

> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

Techniques in increasing strength. Use the strongest that is affordable, and say in the report which one you used. `<skill-dir>` is the folder of SKILL.md; candidates come from [simplify-catalog.md](simplify-catalog.md), and the surrounding workflow is W4 in [workflows.md](workflows.md#w4-proof-guided-simplification).

| Technique | Proves | Preserves | Cost |
|---|---|---|---|
| Re-check | the simplified model satisfies the frozen properties at the checked bounds | exactly the checked properties | minutes |
| Guard implication | a removed guard was always true where it mattered | everything (combined with reachable-state equivalence) | a lemma |
| Refinement (simplified refines current) | every simplified behavior is a current behavior | all safety properties of the current model | a mapping, plus TLC or a simulation proof |
| Reachable-state equivalence | both versions reach exactly the same states | all state invariants of either | an induction proof |
| Function equality | same output for every input | everything observable through the function | a proof |

## Re-check (TLA+ or Lean)

Re-run every config (safety, liveness, sanity and bug-mode) on the simplified model:

```bash
bun <skill-dir>/scripts/tlc.ts formal/<concern>/tla/Spec.tla --matrix formal/<concern>/tla/matrix.json
bun <skill-dir>/scripts/mutate.ts formal/<concern>/tla/Spec.tla formal/<concern>/tla/mutations.json
bun <skill-dir>/scripts/lean-check.ts formal/<concern>/lean
```

The bug-mode runs and the mutations matter here: they show the properties still have teeth after the change. A matrix exits 0 only if every run, including the bug-mode ones that must fail, ended as expected.

## Refinement in TLA+

The simplified spec instantiates the current spec with a refinement mapping that reconstructs any variable the simplification removed. The mapping is then checked as a property:

```tla
Current == INSTANCE CancelOrder WITH
             UseLock <- TRUE, UseCAS <- TRUE,
             lock <- (IF cpc = "decide" THEN "cancel" ELSE "free")
RefinesCurrent == Current!Spec
\* MC_refines.cfg:  SPECIFICATION Spec   PROPERTIES RefinesCurrent ValidTransitions
```

Variables with the same names are substituted implicitly. Verified in [CancelOrderSimple.tla](../assets/simplify/CancelOrderSimple.tla): `matrix-simple.json` runs `MC_refines.cfg` and it passes. [mutations-simple.json](../assets/simplify/mutations-simple.json) shows the checks have teeth with two mutations: removing the CAS guard from the simplified spec makes `ValidTransitions` fail, and a refinement mapping that never reconstructs the lock makes `RefinesCurrent` fail. TLC reports a failed refinement without naming the property, so the second mutation runs with `MC_refines_only.cfg`, a config that lists `RefinesCurrent` alone; `mutate.ts` credits an unnamed temporal failure to the single property of its config. The matching current-spec runs are in [matrix.json](../assets/simplify/matrix.json): both protections pass, CAS alone passes, and the lock alone fails on `ValidTransitions` (expected).

```bash
bun <skill-dir>/scripts/tlc.ts <skill-dir>/assets/simplify/CancelOrderSimple.tla --matrix <skill-dir>/assets/simplify/matrix-simple.json
bun <skill-dir>/scripts/mutate.ts <skill-dir>/assets/simplify/CancelOrderSimple.tla <skill-dir>/assets/simplify/mutations-simple.json
```

Notes:
- A simplified step may correspond to a stuttering step of the current spec (a variable that no longer changes). `[][Next]_vars` allows this.
- One simplified step corresponding to several current steps (merging actions) does not fit a plain refinement. Re-check the properties directly instead, or add an auxiliary variable.
- Refinement preserves safety only. Re-check liveness on the simplified spec with its own fairness.
- The refinement spec must sit in the same folder as the current one (the `INSTANCE` is resolved by file name), and every `CONSTANT` of the current spec must be given by `WITH`.

## Refinement or simulation in Lean

```lean
-- abs maps simplified states to current states
theorem init_ok : abs init' = init := ...
theorem sim : Step' s t → Step (abs s) (abs t) ∨ abs s = abs t := ...
-- Every property proven via Reach Step transfers:
theorem reach_abs : Reach Step' init' s → Reach Step init (abs s) := ...
theorem safe' (h : Reach Step' init' s) : Safe (abs s) := safe_of_reach (reach_abs h)
```

## Reachable-state equivalence in Lean

This is the pattern of [RedundantGuard.lean](../assets/lean-patterns/ProofPatterns/RedundantGuard.lean):
1. `defensive_sub`: every step of the guarded (current) relation is a step of the simplified one.
2. `guard_implied`: the invariant (proven for the simplified relation) implies the guard.
3. `reach_iff` has two directions:
   - (forward) follows from `defensive_sub`;
   - (backward) is induction on `Reach`, using `guard_implied` to supply the guard at each step.

Run `bun <skill-dir>/scripts/lean-check.ts` on the project: the audit must be clean (no `sorry`, no extra axioms), and the report states the unbounded result.

## Function equality in Lean

```lean
theorem simple_eq : ∀ xs, simple xs = current xs := by
  intro xs; induction xs <;> simp_all [simple, current]
-- First check the claim is true on small inputs, e.g.
--   example : ∀ xs ∈ [[], [1], [1, 2], [2, 1, 2]], simple xs = current xs := by decide
```

When a direct induction fails, generalize the accumulator (`Pipeline.foldl_step` in [Pipeline.lean](../assets/lean-patterns/ProofPatterns/Pipeline.lean)), or prove both functions equal to a common specification ([lean-proving.md](lean-proving.md)).
