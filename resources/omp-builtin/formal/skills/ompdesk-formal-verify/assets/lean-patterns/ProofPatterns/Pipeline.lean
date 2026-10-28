/-!
# Pipeline: a batching stage in a dataflow

`batchBuggy` never flushes the trailing partial batch. A bounded exhaustive search
(`counterexamples`, shown with `#eval`) finds counterexamples at once, the shortest being
`[0]`. `batch` is the fix, and `batch_lossless` proves that flattening its output gives
back the input, for every input and every batch size.

This is the Lean analogue of TLA+'s liveness-only bug: a sequential pure function that
loses data. It is proven here without modeling interleavings at all. The project has no
package dependencies, so random testing (the `plausible` package) is not used; the
exhaustive search below covers every list over a two-letter alphabet up to a length bound.
-/
namespace ProofPatterns.Pipeline

def batchBuggy (n : Nat) (xs : List Nat) : List (List Nat) :=
  let (out, _buf) := xs.foldl (init := ([], [])) fun (out, buf) x =>
    if buf.length + 1 = n then (out ++ [buf ++ [x]], []) else (out, buf ++ [x])
  out                          -- BUG: trailing partial batch never flushed

/-- Every list of length exactly `k` over `{0, 1}`. -/
def listsOfLen : Nat → List (List Nat)
  | 0 => [[]]
  | k + 1 => (listsOfLen k).flatMap fun xs => [0 :: xs, 1 :: xs]

/-- Every list over `{0, 1}` of length at most `len`: a tiny exhaustive generator. -/
def smallLists (len : Nat) : List (List Nat) :=
  (List.range (len + 1)).flatMap listsOfLen

/-- Inputs (within the bound) for which the stage loses or reorders data. An empty result
    means no counterexample within the bound, which is not a proof. -/
def counterexamples (f : List Nat → List (List Nat)) (len : Nat) : List (List Nat) :=
  (smallLists len).filter fun xs => (f xs).flatten ≠ xs

-- Prints the first inputs the buggy stage loses; this is output only, so the build stays green.
#eval (counterexamples (batchBuggy 3) 3).take 3

/-- Bounded refutation that stays in the build: the kernel confirms the bug on `[0]`. -/
example : (batchBuggy 3 [0]).flatten ≠ [0] := by decide

def step (n : Nat) : List (List Nat) × List Nat → Nat → List (List Nat) × List Nat
  | (out, buf), x => if buf.length + 1 = n then (out ++ [buf ++ [x]], []) else (out, buf ++ [x])

def batch (n : Nat) (xs : List Nat) : List (List Nat) :=
  let (out, buf) := xs.foldl (step n) ([], [])
  if buf.isEmpty then out else out ++ [buf]

/-- Generalized loop invariant: the classic move when induction on the original goal fails. -/
theorem foldl_step (n : Nat) : ∀ (xs : List Nat) (out : List (List Nat)) (buf : List Nat),
    (xs.foldl (step n) (out, buf)).1.flatten ++ (xs.foldl (step n) (out, buf)).2
      = out.flatten ++ buf ++ xs
  | [], out, buf => by simp
  | x :: xs, out, buf => by
    simp only [List.foldl_cons, step]
    split <;> simp [foldl_step n xs]

theorem batch_lossless (n : Nat) (xs : List Nat) : (batch n xs).flatten = xs := by
  have := foldl_step n xs [] []
  simp only [batch]; split <;> simp_all

/-- The bounded search agrees with the proof: the fixed stage has no counterexample. -/
example : counterexamples (batch 3) 4 = [] := by decide +kernel

end ProofPatterns.Pipeline
