> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# Lean pitfalls

## Vacuous results
- **Contradictory guards or an unsatisfiable `init`** make every safety theorem trivially true.
  Always prove a non-vacuity witness: a `validPath … = true` by `decide`, reaching a state
  where the interesting action happened (both threads done, a message delivered, a task run).
- **An implication whose premise never holds.** `P s → Q s` where no reachable `s` satisfies `P`.
  Witness a reachable `P`-state.
- **A statement weaker than it looks.** `∀ s, Reach Step init s → True`, or a postcondition
  that restates the precondition. Read every frozen statement aloud in plain English, in the
  report.

## Trust base
- `bun <skill-dir>/scripts/lean-check.ts <project>` must exit 0 before any claim of "proven"
  (`<skill-dir>` is the folder that holds `SKILL.md`). It runs `lake build`, then:
  - a source scan for `sorry`, `admit`, and `axiom`;
  - a per-theorem axiom audit over the compiled environment (only `propext`, `Classical.choice` and `Quot.sound`
    are accepted);
  - a `native_decide` gate (`--allow-native` to permit it, and then say so in the report).
  Exit 3 means Lean could not be prepared: the result is "not checked", never "proven".
- **`native_decide` adds an auxiliary axiom and trusts the compiler.** Prefer `decide +kernel`.
  Allow native only when the kernel cannot handle the size, and say so in the report.
- **`bv_decide` also trusts the compiler** (it checks a SAT certificate by running it). Treat it like `native_decide`.
- **`@[implemented_by]`, `@[extern]`, and `unsafe`** mean the runtime behavior is not what the
  kernel checked. They are fine in the replay executable, but never in definitions that theorems mention.
- **`partial def`** is opaque to proofs. Theorems about it are theorems about nothing.
- **The runtime is also trusted.** A proof about the model says nothing about the Lean
  compiler or runtime executing `Replay`. Verified-software projects have found bugs in the Lean runtime itself.

## Model/code drift
- The model is a separate artifact, so it drifts. The defenses are:
  - `@code` tags in the model's docstrings (checked by `verify-all.ts`) and the table in `CORRESPONDENCE.md` (see `correspondence.md`);
  - `next_sound` (the executable and relational twins agree);
  - differential testing against production ("Differential testing" in `lean-patterns.md`);
  - the drift workflow (W6 in `workflows.md`, `verify-all.ts`) on every change to mapped files.
- AWS Cedar keeps its Lean models about 10x smaller than the Rust code and differentially tests them nightly with
  millions of inputs. Small models are what make proofs and drift reviews affordable.

## Over-abstraction
- Atomic read-modify-write where the code has an `await` or a lock gap in the middle.
- Omitting retries, duplicates, or crashes that the environment can produce. Add them as
  constructors; the proof then shows the code tolerates them (or does not).
- Modeling "the queue" as a set when the code relies on order, or as a list when the broker
  reorders.

## Spec gaming (agents)
- Weakening a statement, adding a hypothesis that excludes the bug, or turning a
  postcondition into `True`. Freeze statements in `Properties.lean`; any change needs the
  user's OK and a line in `formal/findings.json`.
- "Proving" the buggy model correct by strengthening the step guard until the bad path is
  impossible. That is modeling a fix that is not in the code. Mark it as a *proposed fix*,
  not a result.

## Performance
- List-based BFS explodes quickly. Keep configurations to 2-3 actors and 2 messages. For
  larger searches, switch to `Std.HashSet` under `#eval`, or move the search to TLC.
- `decide` on big structures can hit kernel limits. Use `decide +kernel`, or shrink the instance.

## Environment
- **Wrong toolchain.** A `lean-toolchain` other than `leanprover/lean4:v4.35.0` makes elan try to download that
  version. Offline, that fails. Fix the file; do not install another toolchain.
- **`lake env lean File.lean` after editing an imported module** uses the stale compiled module. Run `lake build` first.
- **Network-only features.** Packages (`[[require]]`) need `git` and a download at first build. Without a network,
  keep the model dependency-free.
