# Workflows W1-W8

> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

Each workflow lists when to use it, entry criteria, steps, exit criteria and hand-offs. W1 is the backbone. The other workflows reuse its steps by number (W1.1 ... W1.8). `<skill-dir>` is the folder that holds the SKILL.md you read; every command below is `bun <skill-dir>/scripts/<name>.ts`.

## Contents
- Conventions
- W1 Bug hunt (W1.1-W1.8, then the persist step)
- W2 PR race review
- W3 Design verification before code
- W4 Proof-guided simplification
- W5 CI guard
- W6 Drift check after code changes
- W7 Escalate TLA+ to Lean
- W8 Explain a trace
- Chaining workflows

## Conventions

- Every script exits 0 on pass, 1 when a check ran and failed (violation, deadlock, MISSED mutation, drift), 2 on bad usage or input, 3 when the tool is UNAVAILABLE (missing and could not be prepared, for example offline). Exit 3 means "not checked". Never report it as a pass.
- Files in the target repo follow the `formal/` layout in SKILL.md: `formal/manifest.json`, `formal/findings.<concern>.json` (one per concern; a single concern may use `formal/findings.json`), `formal/reports/<concern>.html`, and per concern `SCOPE.md`, `CORRESPONDENCE.md`, `tla/`, `lean/`, `repro/`, `evidence/`. If the repo already has a convention (`specs/`, `tla/`, `proofs/`), use it and record the paths in the manifest.
- Save the output of every check you cite in `formal/<concern>/evidence/` (`tlc.ts --out DIR` keeps TLC's full log, one file per run; redirect the other scripts' output to a file). A claim with no saved log is "not recorded", never "passed".
- A pass means no counterexample within the stated bounds. It never means "the code is correct".

---

## W1 Bug hunt

**Use when** the user asks to find bugs, races or unsafe behavior in existing code. This is the default workflow.

**Entry:** a repository and a named area, or enough context to pick one. If the user names no area, do a 10-minute triage pass. Search for shared mutable state: locks, `async`/`await`, goroutines, channels, threads, queues, caches, retries, `setTimeout`, DB transactions, `SELECT ... FOR UPDATE`, compare-and-swap, event emitters, webhook handlers, schedulers, graph or DAG code. Propose the top three concerns with a one-line risk each and let the user pick. If the user said "just go", pick the highest-risk one.

**Steps:**

### W1.1 Scope one concern

Pick one shared resource or protocol ("cache fill vs. invalidation", "job claim vs. lease expiry", "DAG executor dispatch"). Rank candidates by blast radius times concurrency. Write `formal/<concern>/SCOPE.md` from `assets/templates/SCOPE.template.md`: the promise and the harm, what is in scope, what is abstracted, what is out of scope, the bounds. A whole-system model never converges. A 150-line spec of one concern finds the bug.

### W1.2 Harvest properties before modeling

Pull invariants from docs, comments, issue trackers, past fix commits and API contracts. Cite a source for each (`README.md:40`, `#1234`). Split them into protocol-level properties (any correct implementation must satisfy them) and code-level ones. Freeze the protocol-level set and do not weaken it later without the user's explicit OK. Lean: a separate `Properties.lean` that imports the system. TLA+: a property is a formula over the model's variables, so it cannot sit in a module of its own that exists before the model (the spec would have to `INSTANCE` a module that needs the spec). Freeze it in two places instead: `formal/<concern>/Properties.md` (the template is `assets/templates/Properties.template.md`: statement, meaning, source, the sha it was frozen at) and named definitions in the spec between `\* FROZEN PROPERTIES` and `\* END FROZEN PROPERTIES` banners, listed by name in the configs. `git diff <frozen sha> -- Spec.tla` then shows every change to them. Agents that edit their own success criteria find no bugs.

### W1.3 Choose the tool

Use [choosing-tools.md](choosing-tools.md). Default: TLA+ for anything with interleavings. Lean for algorithmic or data-structure correctness, or when an unbounded proof is wanted. Both when a protocol wraps a non-trivial algorithm. A plain stress test or generated-input test is sometimes the better answer; say so.

### W1.4 Build the correspondence map as you model

Every model action or function points to the code it stands for, and states what was abstracted. Put a `\* @code path:lines` comment above each TLA+ action (a `/-- @code path:lines -/` docstring on each Lean def), and fill in the abstractions and assumptions table in `formal/<concern>/CORRESPONDENCE.md`. See [correspondence.md](correspondence.md). This turns a counterexample into a code-level explanation, and it is what the drift check (W6) reads.

### W1.5 Model and check

Write the model with [tla-patterns.md](tla-patterns.md) and [tla-pitfalls.md](tla-pitfalls.md), or [lean-patterns.md](lean-patterns.md), [lean-pitfalls.md](lean-pitfalls.md) and [lean-proving.md](lean-proving.md). Then run it:

```bash
bun <skill-dir>/scripts/tlc.ts formal/<concern>/tla/Spec.tla --config formal/<concern>/tla/MC.cfg
bun <skill-dir>/scripts/tlc.ts formal/<concern>/tla/Spec.tla --matrix formal/<concern>/tla/matrix.json
bun <skill-dir>/scripts/lean-check.ts formal/<concern>/lean
```

Always run the sanity checks, because a spec that cannot fail proves nothing:

- a must-fail invariant that TLC reports as violated, so the state space is not empty and the checker is wired up;
- action coverage: `tlc.ts ... --coverage`, and every action fires at least once;
- a mutation of each guard or fix: `bun <skill-dir>/scripts/mutate.ts formal/<concern>/tla/Spec.tla formal/<concern>/tla/mutations.json` must print DETECTED for every mutation and UNCOVERED for no property (see [mutations.md](mutations.md)).

A violation prints a reduced trace: one row per step with the action, its `@code` location and the variables that changed. Keep that output as evidence.

### W1.6 Reproduce every counterexample in real code

Do not call a counterexample a bug until it is reproduced. Write a deterministic reproduction that forces the trace's interleaving, run it against the unchanged code, and save the failing log first. It must fail on the property assertion, not on an API or signature change. Honor the user's stated deliverable: if they said "no more unit tests", put the reproduction in `formal/<concern>/repro/` as a script. If it will not reproduce, fix the model, not the verdict. Record unreproduced traces as suspected, never as bugs. See [reproduce-and-fix.md](reproduce-and-fix.md).

### W1.7 Fix, then re-verify

Fix the code, mirror the fix in the model, and re-run the model and the new test. Mutation-check the fix: revert it in the model only (a `mutations.json` entry, or a `BugFixEnabled = FALSE` config in the matrix with `"expect": "violation"`) and confirm the property fails again. This proves the property guards the bug. Ask the user before this step if the fix is non-obvious, touches public API, or has several reasonable designs.

### W1.8 Record and report

Keep a log of every check you cite in `formal/<concern>/evidence/`. Report other problems you noticed along the way (for example an input the code silently mishandles) as separate findings and do not fix them without asking. Then:

```bash
bun <skill-dir>/scripts/verify-all.ts formal --only <id> --stamp   # re-runs everything, records the commit if it all passed
bun <skill-dir>/scripts/report.ts formal                           # one page per findings file, into formal/reports/<concern>.html
```

Write `formal/findings.<concern>.json` first (schema `assets/findings.schema.json`, example `assets/templates/findings.example.json`). [report.md](report.md) says what the report must contain and how to show it. Offer W4 (simplify) and W5 (CI guard) as follow-ups.

### Persist step (after W1.8)

When the user will touch this code again, or asked for something that "stays verified", leave a project-local verify skill and a manifest entry so the next agent can check a change against the property without redoing your work. [persist.md](persist.md) has the full procedure: creating the skill, proving it catches a scratch break, the hand-off text, and the maintenance loop. Skip it only when the user asked for a one-off answer, and say that you skipped it.

**Exit:** every finding is confirmed (reproduced, and fixed or a fix proposed), suspected (counterexample, no reproduction yet, with the reason), or refuted (a model error that was found and fixed). The report exists. Follow-ups are offered: W4, W5.

**Match the depth to the question.** One scoped model, the sanity checks, one reproduction and the report is the floor. Add a second tool (for example Lean after TLA+) only when the user asks for an unbounded guarantee, or when the bounded result leaves a real doubt.

**Budget guidance:** a first model should check in minutes. If TLC runs over about 10 minutes at the smallest meaningful bounds, the model is too detailed; abstract more before scaling up. `tlc.ts` enforces that number: a run with no `--timeout` stops after 10 minutes as "timed out (no verdict)" (`--timeout SEC` or `timeoutSec` in a matrix run raises it, `0` lifts it), and prints TLC's progress while it runs. Stop and report partial results if a concern is not converging after several modeling rounds, and say what blocked it. Keep the user informed at step boundaries.

---

## W2 PR race review

**Use when** the user asks whether a PR, branch or diff introduces races or breaks invariants.

**Entry:** a diff (`git diff <base>...HEAD`) and the repo.

1. Read the diff. List the shared state it touches and the call paths that reach that state.
2. If a verified model of the area already exists, find it from `formal/manifest.json`: a model whose `covers` list contains a changed file. Update the model to the new code (mirror the diff, update CORRESPONDENCE.md and the `@code` tags) and re-run it:
   ```bash
   bun <skill-dir>/scripts/verify-all.ts formal --only <id>
   ```
   This is the cheapest and strongest review. Use the update rules of [persist.md](persist.md#b-maintain-the-verification-the-drift-loop) so you do not shape the model to the result.
3. If no model exists, model only the changed protocol plus the minimum context the properties need (W1.1-W1.5 with a tight scope).
4. When a finding appears, also model the pre-change code and check the property there. "New in this PR" and "pre-existing" call for different reviewer actions.
5. Report per finding: introduced, pre-existing, or fixed by this PR.

**Exit:** a review verdict with evidence. Optional inline PR comments if the user asks. A pre-existing bug found here becomes a full W1 on that concern.

---

## W3 Design verification before code

**Use when** there is a design doc, RFC, ADR or whiteboard protocol and no code yet, or the user wants to validate an idea before a rewrite.

1. Extract actors, messages, state and failure assumptions (crash? message loss? duplication? reordering? clock skew?) from the doc. List the assumptions explicitly and confirm them with the user. Wrong failure assumptions are the most common design-spec mistake.
2. Write the spec at design granularity ([tla-patterns.md](tla-patterns.md)). PlusCal is fine if the team reads pseudocode more easily. If the design is a state machine, [statechart.md](statechart.md) gives a chart-first route.
3. Check safety, then liveness under explicitly stated fairness:
   ```bash
   bun <skill-dir>/scripts/tlc.ts formal/<concern>/tla/Spec.tla --matrix formal/<concern>/tla/matrix.json
   ```
4. Iterate the design with the user on counterexamples. Each round: counterexample, design change, re-check. Run `bun <skill-dir>/scripts/tlc.ts <spec> --from-log <file>` (W8) to explain each one.
5. Output: the spec as the executable design, a list of invariants the implementation must preserve, and a test plan derived from the spec: one test per interesting trace, or model-based tests (see [trace-validation.md](trace-validation.md)). There is no code yet, so the manifest entry has `covers: []`; fill it in and add `@code` tags once the code exists.

**Exit:** a design that passes at the stated bounds, plus a hand-off package for implementers. Recommend W5 once code exists, and W6 as the code lands.

---

## W4 Proof-guided simplification

> The method, catalog and safe-deletion rules below are adapted from proof-skills' proof-simplify skill.

**Use when** a model has passed (W1 or W3 output, or an existing spec or proof) and the user wants to remove complexity, or asks "do we still need this lock, check, retry or state?".

A proof says what is always true of the system. Code written without that knowledge defends against states that cannot happen: guards that never fail, locks that protect nothing, retries that never fire, flags that duplicate other state. Each costs reading time, test time and latency, and each is a place for new bugs. W4 turns proven facts into deletions. It proves every deletion safe before making it and re-verifies afterwards. The standard of evidence: **a simplification is justified only by a property the model proved, under assumptions the code actually enforces.** Anything less is a guess in proof vocabulary.

**Entry (all four are required; if one is missing, run W1 first, otherwise nothing justifies a deletion):**
- a model that passes (TLA+ at stated bounds, or Lean with a clean `lean-check.ts` audit);
- frozen properties (`Properties.md` with the banner-delimited definitions in the spec; Lean: `Properties.lean`);
- the sanity checks passed (must-fail invariants fail, bug-mode configs fail, `mutate.ts` reports no MISSED);
- `CORRESPONDENCE.md`, including its Assumptions list.

**Steps:**

1. **Harvest candidates.** Read the model and the code side by side. Use [simplify-catalog.md](simplify-catalog.md) for the eight kinds: a guard implied by the invariant, redundant synchronization, a dead branch or unreachable state, a dead retry or timeout path, a redundant variable or flag, mergeable (bisimilar) states, an implementation replaceable by a simpler proven-equal one, an invariant that can be encoded in types. List each candidate with its code location, the model element it maps to, and the fact that would justify it.
2. **Prove each candidate in the model before touching code.** Use the cheapest technique that is strong enough ([simplify-equivalence.md](simplify-equivalence.md)): re-check, guard implication, refinement, reachable-state equivalence, function equality. Say in the report which one you used.
3. **Audit assumptions.** For each candidate, list which Assumptions from CORRESPONDENCE.md the proof relies on, then decide:
   - **Remove** when every assumption is enforced by code or infrastructure you control (a type, a DB constraint, a single-writer design).
   - **Downgrade to an assertion** (a debug assert, a metric, or log-and-continue) when the proof holds but an assumption is only conventional. The next person who breaks the assumption gets a signal instead of silent corruption.
   - **Keep** when the code sits on a trust boundary (network input, user input, disk, another team's service, a rolling deploy with mixed versions), or when the assumption is outside your control. Internal invariants never justify deleting validation of external input.
4. **Apply one simplification at a time.** For each accepted candidate: make the code change; update the model to match (the simplified model is now the model); update CORRESPONDENCE.md and the `@code` tags; run the project's tests and the reproductions from earlier findings; re-run `bun <skill-dir>/scripts/verify-all.ts formal --only <id>`. Use one commit per simplification, with a message that names the justifying property.
5. **Report.** Add `simplifications[]` to `formal/findings.json`, then render the report ([report.md](report.md), section "Simplifications"). For each change it shows the diff, the justifying property or theorem and its evidence, the assumptions relied on, the decision (removed, downgraded or kept) and the lines-of-code delta. Include the candidates you rejected, with the reason; they are useful knowledge ("the lock looks redundant but protects the cron path, which is not modeled").

**What not to do:**
- Do not simplify on the strength of a model that never failed. Sanity checks come first.
- Do not carry a bounded check into an unbounded claim. "Holds for 2 workers" does not justify deleting a lock that matters at 3. Argue that the bound covers it (symmetry, or the property is per-pair), prove it in Lean, or re-check at larger bounds.
- Do not merge several simplifications into one unverified leap. Two individually safe deletions can be jointly unsafe. Re-verify after each.
- Do not delete observability (logs, metrics) because a state is "unreachable". Consider turning the branch into an alert.
- Do not let a refinement proof stand in for liveness. Refinement preserves safety; re-check liveness separately.

**Worked examples (both ship with this skill):**
- **TLA+, a lock that does nothing.** [CancelOrder.tla](../assets/simplify/CancelOrder.tla) models a cancel handler that takes a row lock and also uses a conditional UPDATE, while the payment webhook never takes the lock. The matrix runs three configs: both protections (passes), CAS only (passes), lock only (must fail, because the lock alone never prevented `paid -> cancelled`). [CancelOrderSimple.tla](../assets/simplify/CancelOrderSimple.tla) removes the lock, and its matrix proves it refines the current spec under a mapping that reconstructs the lock. Decision: remove the lock, keep the CAS, and write the model's finding into the code comment.
  ```bash
  bun <skill-dir>/scripts/tlc.ts <skill-dir>/assets/simplify/CancelOrder.tla --matrix <skill-dir>/assets/simplify/matrix.json
  bun <skill-dir>/scripts/tlc.ts <skill-dir>/assets/simplify/CancelOrderSimple.tla --matrix <skill-dir>/assets/simplify/matrix-simple.json
  bun <skill-dir>/scripts/mutate.ts <skill-dir>/assets/simplify/CancelOrderSimple.tla <skill-dir>/assets/simplify/mutations-simple.json
  ```
  The first command exits 0 because the lock-only run is expected to fail. The second also exits 0: the simplified spec refines the current one. The mutation run drops the CAS guard from the simplified spec (`ValidTransitions` fails) and breaks the refinement mapping (`RefinesCurrent` fails), so both checks have teeth. Expect `WARN @code ... does not exist` lines: the tags point into an imaginary Rails app. For the same reason `verify-all.ts` would fail these assets on unresolved tags; in a real repo the tags resolve.
- **Lean, a defensive guard the invariant makes dead.** [RedundantGuard.lean](../assets/lean-patterns/ProofPatterns/RedundantGuard.lean): `guard_implied` shows the `k ∉ applied` re-check follows from the idempotency invariant, and `reach_iff` shows that with or without it exactly the same states are reachable. Decision: delete it, citing `applied_nodup`.

**Exit:** each accepted simplification is applied, re-verified and reported, each rejected one has a reason, and the model, CORRESPONDENCE.md and manifest match the new code. Then run the persist step to move the sync commit.

---

## W5 CI guard

**Use when** a model exists and the user wants it enforced going forward.

1. Split the checks into a fast tier (smallest bounds that still catch every past bug, under about 2 minutes) and a deep tier (nightly). Both are runs in `matrix.json`; see [ci-and-drift.md](ci-and-drift.md).
2. Add every confirmed bug's trace as a regression. In TLA+, the fixed spec must pass, and a bug-mode config (`BugFixEnabled = FALSE`) must fail: put it in the matrix with `"expect": "violation"` and the property name, so the run exits 0 only while the check still has teeth. In Lean, keep the theorem and keep a `#guard` or `decide` test for the concrete bad input.
3. Add the code-level reproductions to the normal test suite (unless the user said no new tests).
4. Register the model in `formal/manifest.json` (`covers`, `matrix`, `mutations`, `syncCommit`), then run `bun <skill-dir>/scripts/verify-all.ts formal --stamp` once.
5. Add the CI job from [ci-and-drift.md](ci-and-drift.md) (it calls `verify-all.ts formal --strict-drift`), and a CODEOWNERS or PR-template nudge: changes to files in CORRESPONDENCE.md or in a manifest `covers` list require the model to be updated or explicitly waived.

**Exit:** CI is green on a clean tree, and a deliberately broken scratch change turns it red (try it, then drop it).

---

## W6 Drift check after code changes

**Use when** code changed since the model was written, or before trusting an old model.

1. Run the drift report: `bun <skill-dir>/scripts/verify-all.ts formal --only <id>`. It re-runs the model and lists the covered files that changed since the model's `syncCommit`, and any `@code` tag that no longer resolves (file missing or line range past the end of the file). Add `--strict-drift` to make drift a failure.
2. Read the diff of each changed covered file from the sync commit (`git diff <syncCommit>..HEAD -- <file>`) and classify every change as no effect, the model no longer describes the code, the promise changed on purpose, or the promise may be broken. The full six-step loop and its rules are in [persist.md](persist.md#b-maintain-the-verification-the-drift-loop).
3. Look for new code paths that touch the modeled state but have no `@code` tag (search the state's identifiers). These are the dangerous drifts.
4. Update the model from the code, re-run, and report drift items next to any new findings. Move the sync commit with `--stamp` only after the model describes the code at the new commit.
5. Where feasible, add trace validation or model-based testing ([trace-validation.md](trace-validation.md)). It detects drift continuously instead of by audit.

**Exit:** each model has one outcome: in sync, updated, bug or blocked.

---

## W7 Escalate TLA+ to Lean

**Use when** TLC passed at small bounds and the user needs the property for all sizes, or the core of the protocol is an algorithm whose correctness TLC can only sample.

1. Keep the TLA+ spec as the interleaving model. Identify the property that needs to be unbounded (for example "the dispatcher never starts a task before its predecessors", for any DAG).
2. Scaffold a Lean project (`bun <skill-dir>/scripts/new-lean.ts formal/<concern>/lean <Pkg>`), encode the same state and step relation, and state the invariant ([lean-patterns.md](lean-patterns.md), [lean-proving.md](lean-proving.md)). First use `decide` on small instances to check that the invariant is true before trying to prove it. Prove it by induction over steps.
3. When the proof gets stuck, the missing lemma often shows a real edge case. Bring it back to TLA+ as a new invariant and check it there quickly.
4. Audit: `bun <skill-dir>/scripts/lean-check.ts formal/<concern>/lean`. It fails on `sorry`, `admit`, user axioms, `#exit`, `debug.skipKernelTC` and `native_decide` (unless `--allow-native`, which makes `implemented_by` and `extern` blocking), and on any theorem whose axioms go beyond `propext`, `Classical.choice`, `Quot.sound`. It re-checks the build with the toolchain's `leanchecker`, audits every module of the project's libs (not only what the root imports), and fails when it audited zero declarations.
5. Report both: the TLC results (bounded, all interleavings) and the Lean theorems (unbounded, with the axiom audit). Add a manifest entry of `"kind": "lean"` next to the `"tla"` one, with `mutations.json` for the Lean side ([mutations.md](mutations.md)).

The reverse direction also works: a Lean-verified algorithm that is then used concurrently goes to TLA+ with the algorithm as one atomic action.

**Exit:** theorems proven with a clean audit, the TLA+ model unchanged or tightened, and both recorded in the report.

---

## W8 Explain a trace

**Use when** the user pastes TLC output (or a Lean counterexample) and wants to understand it.

1. Save the pasted text to a file and parse it without running TLC:
   ```bash
   bun <skill-dir>/scripts/tlc.ts formal/<concern>/tla/Spec.tla --from-log <file>
   ```
   Passing the spec lets the output attach each action's `@code` location. The output has one row per step: the action, its `@code` location and only the variables that changed.
2. Tell the story in the user's domain terms ("worker A claims job 1, the lease expires, worker B claims job 1, both commit"). Name the step where the invariant becomes false and the earliest step where the run was already doomed.
3. Say whether this is a real bug, a modeling error (over-abstraction, a missing guard, missing fairness), or a property that is too strong (for example, it should hold only at quiescence).
4. For more than a few steps, add a Mermaid `sequenceDiagram` of the trace in your chat reply, and for a longer write-up use a trace-only report ([report.md](report.md)).

**Exit:** the verdict (real bug, modeling error, property too strong) with the story. If it is a real bug, continue at W1.6.

---

## Chaining workflows

- **W1, W4, W5**: find and fix bugs, simplify using what was proven, lock it in CI.
- **W3, implement, W6, W5**: verify the design, build it, confirm the code matches the spec, guard it.
- **W2, W1**: a PR review that finds a pre-existing bug becomes a full hunt on that concern.
- **W1 (TLA+), W7 (Lean), W4**: bounded check, unbounded proof, then simplify with confidence.

At the end of any workflow, name the next useful workflow in one line and let the user choose.
