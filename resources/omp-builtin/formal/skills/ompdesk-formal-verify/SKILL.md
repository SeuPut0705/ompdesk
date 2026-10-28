---
name: ompdesk-formal-verify
description: "Model-check races, retries, leases, deadlocks and state machines ('can this ever happen?', prove, TLA+, TLC, Lean 4). Read BEFORE fixing any interleaving, ordering, idempotency, lost-wakeup, retry, lease or shutdown bug, and when asked whether something can never happen, to prove or formally verify code, to keep a spec in step with the code, or to explain a TLC trace. Draws bug paths for a non-technical reader."
---

> Adapted from opum-ai/proof-skills (MIT, Opum AI) and pstack (MIT, Lauren Tan). See LICENSES/proof-skills-MIT.txt and LICENSES/MIT-pstack.txt in the OMPdesk app resources.

# Formal verification: find the bug a test cannot reach, prove it, keep it fixed

A test checks the cases someone thought to write. A model checker explores every order of the steps of a small model of the design; a proof assistant covers every input size. They find races, lost updates, double-applied retries and illegal state changes that reviews and tests miss. The hard parts are choosing what to model, keeping the model honest to the code, and proving a counterexample is real. This skill owns those parts and ships the tools.

A pass means "no counterexample within this model and these bounds". It never means "the code is correct". Say the bounds, and name what the model leaves out.

## Where things are

`<skill-dir>` is the folder that holds this SKILL.md: the path shown when you read it. Everything below is relative to it. Scripts are Bun TypeScript (omp always has Bun) and run the same on macOS and Windows:

```
bun <skill-dir>/scripts/setup.ts tla|lean        prepare TLC or Lean (lazy, idempotent; the other scripts do it themselves)
bun <skill-dir>/scripts/tlc.ts <spec.tla> [--config X.cfg] [--matrix matrix.json]
bun <skill-dir>/scripts/lean-check.ts <lake project> [files.lean]
bun <skill-dir>/scripts/mutate.ts <model file> <mutations.json>
bun <skill-dir>/scripts/report.ts <findings.json>
bun <skill-dir>/scripts/verify-all.ts <formal dir> [--stamp] [--strict-drift]
bun <skill-dir>/scripts/new-lean.ts <dir> <Pkg>
bun <skill-dir>/scripts/statechart/statechart.mjs --help
```

Exit codes, the same in every script: `0` pass, `1` a check ran and failed, `2` usage error or a bad input file, `3` UNAVAILABLE. Exit 3 means a tool is missing and could not be prepared (offline, no disk, unsupported platform). Report that check as **not checked**. Never report it as a pass, and never replace it with reasoning about what TLC would say.

The tools live in `~/.cache/ompdesk/formal` on macOS and `%LOCALAPPDATA%\ompdesk\formal` on Windows (`OMPDESK_FORMAL_CACHE` overrides). Nothing is installed system-wide and nothing needs sudo. The first TLA+ run downloads two pinned jars (about 10 MB, SHA-256 checked) and, only when no working `java` 11+ exists, a portable Java runtime (about 50 MB). The first Lean run downloads elan and the pinned Lean toolchain (about 0.9 GB, no Mathlib), so tell the user before starting it. `OMPDESK_FORMAL_OFFLINE=1` refuses every download. Versions and hashes: `assets/toolchain.json`.

## Pick the workflow

`references/workflows.md` has the full step list of each. Match the request:

| The user wants | Workflow |
|---|---|
| "Find races or bugs in X", "is this safe under concurrency", a retry, lease, ordering or shutdown bug | **W1 Bug hunt** (the loop below) |
| "Review this PR or diff for races" | **W2 PR race review**: model only the delta and what it touches |
| "Check this design or protocol before we build it" | **W3 Design verification**: no code yet, the spec is the design |
| "Simplify this using the proofs", "do we still need this lock, check or retry" | **W4 Proof-guided simplification** (`references/simplify-catalog.md`, `references/simplify-equivalence.md`) |
| "Keep this verified", "add the spec to CI" | **W5 CI guard** (`references/ci-and-drift.md`) |
| "The code changed: is the model still true?" | **W6 Drift check** (`references/persist.md`) |
| "Prove it for every N", "TLC passed but I want certainty" | **W7 TLA+ to Lean escalation** |
| "Explain this TLC trace", a pasted `State 1: ...` listing | **W8 Explain a trace**: `bun <skill-dir>/scripts/tlc.ts --from-log <file>` |
| "Show the PM the bug", a chart for a non-technical reader | **Statechart** (`references/statechart.md`) |

## W1, the core loop

Each step exists because skipping it is how formal-methods efforts fail in practice. The first three are decisions only you can make; make them from the code, and ask the user only what the code cannot tell you.

1. **Pick the target from the code.** One promise the code makes, whose break harms users and which tests rarely reach: "a job is committed once", "a retry never charges twice", "a stopped session never resumes". Rank candidates by harm times concurrency, and pick the strongest, not the easiest. Write down the promise, the harm in one plain sentence, and why tests miss it. A model of the whole system never converges; one concern in 100 to 200 lines finds the bug.
2. **Choose the tool.** See `references/choosing-tools.md`.
   - TLA+ with TLC: interleavings, ordering, retries, leases, shutdown, message loss or duplication, liveness (`references/tla-patterns.md` has seven runnable patterns).
   - Lean 4: properties for every size or input, arithmetic and data-structure invariants, graph algorithms, an executable oracle for differential tests (`references/lean-patterns.md`).
   - Both: TLA+ finds the trace fast, Lean proves the fixed invariant for every size (W7).
   - A bounded function in Rust: Kani is an optional external verifier, not bundled. Mention it; do not install it unasked.
   - None: a simple sequential function wants property-based tests, and one race that a barrier reproduces in 20 lines wants that test first. Say so rather than forcing a model.
3. **Harvest and freeze the properties before modeling.** Take invariants from docs, comments, issues, past fix commits and API contracts; cite a source for each. Split protocol-level properties (any correct implementation must hold them) from code-level ones. Freeze the protocol-level set. Do not weaken a frozen property, add a state constraint or add fairness to make a check pass without reporting it as a model change; an agent that edits its own success criteria finds no bugs.
4. **Model it with every action tied to code.** One atomic step in the model is one atomic step in the code: the code between two `await`s, a locked section, one SQL statement, one message handler. When unsure, split the step; more interleavings cost states, never correctness. Put `\* @code path/to/file.ts:40-58 what this step does` directly above each TLA+ action (Lean: `/-- @code path:lines -/` on the constructor). Environment steps (a crash, time passing, a duplicate message) are explicit actions without a `@code` tag. Start from the closest pattern in `assets/patterns/` or the worked example in `examples/job-lease/`. Details: `references/correspondence.md`.
5. **Check with small bounds and a matrix.** Two workers, two or three values, then grow one bound at a time. Write a `matrix.json` that holds the passing run, a larger run, and every bug-mode run that must fail (the unfixed variant, the sanity invariant). `bun <skill-dir>/scripts/tlc.ts Spec.tla --matrix matrix.json` exits 0 only when every run ended as expected, so a model that lost its teeth fails the matrix. Lean: `bun <skill-dir>/scripts/lean-check.ts <project>` builds and rejects `sorry`, `admit`, new axioms, `native_decide` and any theorem that depends on an axiom beyond propext, Classical.choice and Quot.sound.
6. **Prove each property can fail.** A check you have never seen fail proves nothing. Write `mutations.json` (a search/replace pair per property: drop the guard, reorder two steps, remove fairness) and run `bun <skill-dir>/scripts/mutate.ts <model> mutations.json`. Every mutation must be `DETECTED` and no property may be `UNCOVERED`. A `MISSED` mutation means the property or the model is vacuous: fix the model or the property, never the mutation. See `references/mutations.md`.
7. **Map each counterexample to code and reproduce it before believing it.** `tlc.ts` prints the shortest trace with the variables that changed and the `@code` location of every step. Tell it as a short story in the code's own words. Then force the same interleaving in the real code (barriers, fake clocks, injected delays, two connections) as a **failing test on the unchanged code**, and save the failing run. A counterexample the code cannot reproduce is a model error or a suspected finding, never a bug. `references/reproduce-and-fix.md` has the technique per runtime.
8. **Fix only when the user asked, or inside a bug-fix flow.** Verification alone changes no product code. Choose the fix by mechanism (make the region atomic, add a fencing token, record the dedup key before the side effect, make the operation idempotent), mirror it in the model, rerun every property (a lock added for safety can deadlock), and rerun the mutations: the mutation that removes the fix must be detected again.
9. **Re-verify.** The matrix, the mutations, the Lean audit, and the new failing test, now passing.
10. **Persist.** Leave the next agent a working check, not a transcript.
    - `formal/<concern>/` with the spec or project, `SCOPE.md`, `CORRESPONDENCE.md` (abstractions and assumptions), `matrix.json`, `mutations.json`, `evidence/` with the logs you cite.
    - `formal/manifest.json`: for each model its files, the code files it covers, and `syncCommit`, the commit at which you confirmed the model describes that code. `bun <skill-dir>/scripts/verify-all.ts formal --stamp` reruns everything and stamps passing models.
    - A **project-local verify skill** (`.omp/skills/<area>-verify/SKILL.md`, or the repo's own convention) that says what the model covers, how to run it, how to tell a real bug from a modeling error, and when the sync commit may move. This works with or without pstack. `references/persist.md` has the template (`assets/templates/verify-skill.template.md`), the "prove it before you hand off" run, and the drift loop with its four outcomes: in sync, updated, bug, blocked.
11. **Report.** Write `formal/findings.json` (schema `assets/findings.schema.json`, example `assets/templates/findings.example.json`) and run `bun <skill-dir>/scripts/report.ts formal/findings.json`. It writes one self-contained HTML page to `formal/reports/<concern>.html`. Show it in the Preview panel with the `gui_visualize` tool when that tool exists; otherwise give the user the path. In chat, lead with the verdict, then the bounds, then each finding. `references/report.md` has the required content. A subagent that may not write files puts the same content in its final message.

**Match the depth to the question.** One scoped model, the matrix, the mutations, one reproduction and the report is the floor. Add a second tool only when the user wants an unbounded guarantee or the bounded result leaves a real doubt. Keep the user informed at step boundaries, and ask before step 8 when the fix is non-obvious, touches a public API, or has several reasonable designs.

## Worked examples that pass on this machine

```
bun <skill-dir>/scripts/verify-all.ts <skill-dir>/examples/job-lease/formal       # TLA+: lease and fencing token, 4 mutations
bun <skill-dir>/scripts/verify-all.ts <skill-dir>/examples/bounded-queue/formal   # Lean: capacity and conservation for every size, 3 mutations
```

`examples/job-lease/` is a complete small target repo: the toy code in `src/worker.ts`, the spec with `@code` tags, the cfgs, `matrix.json`, `mutations.json` and `manifest.json`. Copy its shape.

## Honesty rules

- Say exactly what was checked: the bounds ("2 workers, 3 jobs, at most 3 claims"), the states and depth, which properties, which `sorry` or axioms remain. "Verified" with no bounds is a false claim.
- Name the abstractions that could hide a bug (`CORRESPONDENCE.md` assumptions). A model that makes a read-modify-write atomic when the code has an `await` in the middle hides exactly the race you wanted.
- Never call a counterexample a bug before step 7 reproduced it. Unreproduced traces are *suspected*.
- Never report a check that exited 3 as passed. Say "not checked" and why.
- Findings stay findings. When the current code breaks the property, report it with the trace in the code's words; do not weaken the property or the model until it passes.

## Optional: pstack and the statechart

For a reader who will not read TLA+, `references/statechart.md` draws the model as a Mermaid statechart (gray states work, red are wrong, green are fixed, each TLC bug a numbered path). It renders inline in chat as a ```mermaid block, and the PNG or HTML can go to the Preview panel. When the pstack engineering mode is on, its bug-fix playbook sends race and ordering bugs here before the fix.

## Reference index

- `references/workflows.md`: W1 to W8 step lists, entry and exit criteria, how to chain them.
- `references/choosing-tools.md`, `references/tla-patterns.md`, `references/tla-pitfalls.md`, `references/tlc-cli.md`, `references/trace-validation.md`, `references/mutations.md`.
- `references/lean-patterns.md`, `references/lean-pitfalls.md`, `references/lean-proving.md`, `references/lean-setup.md`.
- `references/correspondence.md`, `references/reproduce-and-fix.md`, `references/persist.md`, `references/report.md`, `references/ci-and-drift.md`, `references/evidence.md`.
- `references/simplify-catalog.md`, `references/simplify-equivalence.md`: safe deletions justified by a proof.
- `references/statechart.md`: charts for non-technical readers.
