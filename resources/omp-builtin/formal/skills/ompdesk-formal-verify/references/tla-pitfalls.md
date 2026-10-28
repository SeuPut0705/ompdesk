> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# TLA+ pitfalls and how to catch them

Commands below are `bun <skill-dir>/scripts/tlc.ts ...`, where `<skill-dir>` is the folder that holds `SKILL.md`.
Flags and exit codes: `tlc-cli.md`. Proving that a property can fail, mechanically: `mutations.md`.

## A spec that cannot fail

| Symptom | Check |
|---|---|
| Invariant holds, but the interesting states are unreachable | Sanity invariant that must fail (`NeverAllDone`, `NoWriteHappens`), run as a matrix entry with `"expect": "violation"` |
| `P => Q` holds because `P` never happens | Check `~P` as an invariant; it must fail |
| An action never fires (a guard is contradictory) | `tlc.ts Spec.tla --coverage`: actions with 0 distinct states |
| The fix "works" but the property never guarded the bug | Bug toggle: with the fix off, the property must fail (`MC_bug.cfg`, matrix entry with the property name) |
| The property cannot fail for any change of the model | `mutate.ts`: a `MISSED` mutation means the property (or the model) is vacuous (`mutations.md`) |
| Liveness holds trivially | TLC warns on trivially true liveness; also check the `<>` target is reachable |

A green run proves nothing until the same model has been seen to fail on purpose. Keep the three configs
(`MC.cfg` passes, `MC_bug.cfg` fails, `MC_sanity.cfg` fails) and list them in `matrix.json` so one command
checks all of them.

## Modeling errors

- **Under-modeling atomicity.** Merging two code steps into one action removes the interleaving
  between them. That is often exactly the bug. MongoDB's Raft conformance effort failed partly
  because the spec made step-down plus step-up atomic when the code does not. Split by default.
- **Over-modeling.** Byte-level data, full retry schedules, and real clocks blow up the state
  space without adding bugs. Abstract to what the properties read.
- **Unbounded growth.** Counters, logs, and sequences that grow forever make TLC run forever.
  Bound them with constants (`MaxClaims`), or with a `CONSTRAINT` (for example
  `TLCGet("level") < 30`), and state the bound in the report. Constraints also change what
  liveness means.
- **Missing `UNCHANGED`.** An unmentioned variable can take any value, so the model is wrong
  silently. TLC usually stops with "Successor state is not completely specified" (an evaluation error, exit
  code 75 with tla2tools release 1.8.0), and `TypeOK` catches the rest.
- **Mixed types.** Comparing a string to an integer is a TLC error. Use a sentinel of the
  same type (`None == -1` with `EXTENDS Integers`), or model values.
- **`IF/THEN/ELSE` and `CASE` swallow the conjuncts that follow them.** Parenthesize:
  `x' = (IF c THEN a ELSE b)`. This holds for an `IF` spread over several lines too: in
  ```tla
  /\ x' = IF c
           THEN a
           ELSE b
  /\ y' = y
  ```
  the `ELSE` branch reads `b /\ y' = y`, so `y'` is never assigned and TLC reports only "Successor state is not
  completely specified". When that message appears and every variable looks assigned, look for an unparenthesized
  `IF`/`CASE` above the missing bullet.
- **`CHOOSE x \in S : TRUE /\ y` swallows the next conjunct.** The body of `CHOOSE`, `\E` and `\A` extends as
  far right as it can, so in `/\ r = CHOOSE x \in S : TRUE` followed by `/\ ok = (r # none)` the second bullet
  becomes part of the `CHOOSE` body and TLC says `identifier r undefined` (or evaluates the wrong predicate). Write
  `r = (CHOOSE x \in S : TRUE)`, or bind the value in a `LET`.
- **SANY accepts what TLC rejects.** `-1` parses without `EXTENDS Integers` (the minus is looked up only when TLC
  loads the module): `tlc.ts --sany-only` first runs SANY, then starts TLC for one simulated step of depth 1 to load
  the module the way a real run does, so this fails there with `Could not find declaration or definition of symbol
  '-.'`. The same holds for `\div` and `..` (Integers or Naturals), `Len` and `Append` (Sequences) and
  `Cardinality` (FiniteSets). Without a config SANY alone decides, and `tlc.ts` says that the load check did not
  run. Fix: add the module to `EXTENDS`, or avoid a negative literal (`None == 0 - 1` also needs Integers; a model
  value or a string sentinel does not).
- **Too-strong properties.** Coherence and consistency often only hold at rest. Guard them
  with `Quiescent`, or state them as `[]<>` or `~>`.
- **Unmarked code locations.** An action without an `@code` tag cannot be mapped back to the code, shows no
  location in a trace, and is not covered by drift checks. Tag every action that stands for code; leave
  environment actions (`Expire`, `Crash`, `Drop`) untagged on purpose.

## Liveness traps

- Without fairness, every `<>` and `~>` property fails by stuttering. That counterexample is
  meaningless; add fairness.
- Too much fairness hides starvation. Put fairness only on what the real scheduler or runtime
  guarantees. Use `SF` for actions that are enabled only intermittently (for example, lock
  acquisition contended by others).
- **A global `pc` lock makes every action intermittently enabled, so `WF` stops working.** When one variable
  (`pc = "idle"`, `busy = FALSE`) must hold for every action to fire, each action is enabled only while no other
  component holds it. An environment action that keeps taking and releasing the lock (a repeated `UserStop`) can
  keep the action you care about disabled at every moment it would be checked, and `WF` does not forbid that:
  TLC reports a starvation counterexample that the real scheduler would not produce. Either model the lock as what
  it is (the component's own state, so the action stays enabled until it fires), or use `SF`.
- **`SF` per quantified action is slow; fairness per component is not.** `\A x \in S : SF_vars(A(x))` gives TLC one
  fairness constraint per `x`, and the liveness check multiplies them: 236 s for a 4 155-state model, against
  4 s when the same guarantee was written once per component (`SF_vars(\E x \in S : A(x))`, or one `SF` over the
  component's whole `Next`). State fairness for the component (the scheduler runs this component's enabled
  step), not for each instance, unless two instances really can starve each other. `tlc.ts` prints a `Progress`
  line while a liveness run goes on, and stops it after 10 minutes with "timed out (no verdict)"; raise it with
  `--timeout SEC` (a matrix run: `timeoutSec`) only after you have narrowed the fairness.
- Never put fairness on environment faults. "The network eventually stops dropping" is an
  assumption; if you need it, state it as one.
- **Symmetry plus liveness is unsound.** Use separate configs.
- `-deadlock` (config `CHECK_DEADLOCK FALSE`) hides stuck states. Model termination explicitly with a
  `Terminated == Done /\ UNCHANGED vars` disjunct instead. The exception is a mutation run of a liveness property:
  a mutant that stops the model early deadlocks before the property can fail, so give that mutation
  `"deadlock": false` (`mutations.md`).
- A bug that violates no safety property (the last partial batch is never flushed) is found only by a liveness
  property. `BatchPipeline` is the example: pair every "nothing bad" property with a "something good happens".

## Agent-specific failure modes

Published evaluations (Hillel Wayne 2025; the Specula ablation 2026; arXiv 2606.05792, as cited by
proof-skills) report that language models are good at TLA+ syntax, `UNCHANGED` bookkeeping, and explaining
long traces. They are poor at:
- **proposing properties.** They pick trivial ones, or ones that restate the implementation.
  Harvest properties from requirements, docs, and bug history instead, cite a source for
  each, and freeze them.
- **"fixing" the spec instead of the code.** For example, assuming the race cannot happen,
  weakening a guard, or adding a constraint that excludes the trace. Diff every change to
  `CONSTRAINT`, fairness, and the frozen properties, and report it.
- **trusting unvalidated specs.** In the cited evaluation, across 30 models at most 26.6% of generated specs
  parsed and 8.6% were semantically right. Treat every new spec as a hypothesis until the sanity
  checks, the bug toggle, the mutations and (ideally) trace validation pass.

The fix is always evidence from outside the model: reproduction in code, trace validation (`trace-validation.md`),
or the sanity, toggle and mutation checks above.
