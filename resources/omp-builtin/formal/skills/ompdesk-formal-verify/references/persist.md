# Persist: the project-local verify skill and the drift loop

> Adapted from pstack (MIT, Lauren Tan). See LICENSES/MIT-pstack.txt. Adapted in part from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

A formal check proves a property of what it describes. When the code changes and the verification does not, the check can keep passing while it describes code that no longer exists. That pass is the dangerous case, because it looks like a proof. This file covers both halves of keeping a verification alive:

- **A. Create** a project-local verify skill that lets the next agent check a change against the property, together with the manifest entry that lets `verify-all.ts` re-run it.
- **B. Maintain** it: the upkeep loop for changes that skipped the verify skill (merges, edits made without it, drift that builds up across many commits).

`<skill-dir>` is the folder that holds the SKILL.md of `ompdesk-formal-verify`; commands are `bun <skill-dir>/scripts/<name>.ts`.

## Contents
- When to persist
- A. Create the project-local verify skill
- B. Maintain the verification (the drift loop)
- The sync commit

## When to persist

Persist at the end of W1 (the persist step), W3 once code exists, W4, W6 and W7, whenever the user will change this code again. Skip it only for a one-off question, and say that you skipped it. Persisting is two things:

1. A `formal/manifest.json` entry for each model (format below), so `verify-all.ts` can re-run it for CI and for the next agent.
2. A project-local skill that tells an agent who has never seen your work how to check a change against the verification.

Manifest entry (paths are relative to the manifest folder; `covers` is relative to the code root, which is `codeRoot`, default `..`; `tier` is `fast` (default) or `deep`):

```json
{
  "version": 1,
  "codeRoot": "..",
  "models": [
    {
      "id": "job-lease",
      "title": "Job lease",
      "kind": "tla",
      "dir": "job-lease/tla",
      "spec": "JobLease.tla",
      "matrix": "matrix.json",
      "mutations": "mutations.json",
      "covers": ["src/worker.ts"],
      "syncCommit": null,
      "verifySkill": ".omp/skills/lease-verify/SKILL.md"
    }
  ]
}
```

`covers` entries are files or folders (`src/a.ts`), **functions** (`src/a.ts#sync`; a member as `src/a.ts#Pool.sync`; also Rust `fn`, Go `func`, Python `def`; several declarations of one name are all covered) or **line ranges** (`src/a.ts:120-180`, in the lines of the working tree). Prefer a function: the drift check compares its text at the sync commit with its text now, so a 2,500-line file with unrelated edits raises no drift, and the function can move. A range raises drift when a diff hunk touches it or when lines inserted above it moved it ("lines moved by +3: update the range"). A name that matches nothing, now and at the sync commit, is an error (the entry is wrong), not "no drift". A model's drift line lists the `file#name` and `file:a-b` entries that changed.

A `tla` model without `matrix` uses `configs: ["MC.cfg"]`. A `lean` model has `project` (the Lake project folder, usually `.`) instead of `spec`, and `model` (the Lean file that mutations edit, relative to the project folder). A mutation's `file` is relative to the checker's root: the model folder for TLA+, the project folder for Lean. Full examples: [manifest.example.json](../assets/templates/manifest.example.json), [matrix.example.json](../assets/templates/matrix.example.json), [mutations.example.json](../assets/templates/mutations.example.json).

---

## A. Create the project-local verify skill

A test checks the cases that someone thought to write. Formal verification checks every case in a stated scope: every order of steps in a model, every input up to a bound, or every input. The result of W1 is a verified part of the repo; the verify skill is what lets the next agent keep it that way. Write it for an agent who reads it cold, mid-change, and has never seen your work. The user must be able to trust the result and act on it without learning the verification language.

### A.1 Choose the target from the code

Answer from the codebase and ask the user only what you cannot observe. If the user named an area or a bug, start there. A good target is a promise the code makes, where a break harms users and tests rarely reach the case that breaks it. Choose the strongest such target in the repo, not the one that is easiest to verify. (W1.1 and W1.2 produce this; reuse their SCOPE.md and frozen properties.)

### A.2 Let the question choose the tool

Pick the tool that answers the question at the lowest cost ([choosing-tools.md](choosing-tools.md)):
- Whether events can happen in a bad order: a model checker over a small model of the design. TLA+ with TLC is the default, in any language.
- Whether the code itself behaves for every input (memory safety, overflow, a data-structure invariant): a verifier that runs on the code, if one exists for the language. If none does, say so, and test the real code with generated inputs instead of a hand model of the function.
- A property that must hold at every size, where a bound is not enough: a proof in Lean.

Prefer a tool the repo's developers can install and run, and tell the user why you chose it.

### A.3 What makes a verification good

- **True to the code.** Every part of the model or proof points to code that a reviewer can open (`@code` tags, [correspondence.md](correspondence.md)). What the verification treats as one indivisible step is one indivisible step in the code. Names come from this repo.
- **Able to fail.** A check that you have never seen fail proves nothing. Show each property failing on a broken variant of the code it guards: a removed check or a reordered step. `mutate.ts` and bug-mode configs do this ([mutations.md](mutations.md)).
- **Findings stay findings.** When the current code breaks the property, report it with the counterexample in the code's terms. Do not weaken the property or the model until it passes, and do not change product code unless the user asks.
- **Honest about scope.** Say what is verified, under which bounds and assumptions, and what is left out. A pass covers the model or the bound, not the whole system.
- **Readable without the tool.** State the property and the harm in one plain sentence each. Tell a counterexample as a short sequence of steps in the code's words.
- **Cheap to rerun.** One command, a pinned tool version (`assets/toolchain.json` pins TLC and Lean), and a run short enough that the next agent will use it on every relevant change.
- **Kept in step with the code.** Record which files and functions each check covers, and the commit at which you last confirmed that the verification describes them. When the covered code changes after that commit, the next agent can see that the verification needs another look.

### A.4 Write the verify skill

Location: `.omp/skills/<area>-verify/SKILL.md`, or the repo's own skill convention if it has one (check for `.claude/skills/`, `.agents/skills/`, `skills/` and record the path in the manifest's `verifySkill`). **Check that git will keep it:** `git check-ignore -v <path>`. Some repositories ignore `.omp/` (in `.gitignore` or `.git/info/exclude`), and then the skill is never committed and the next agent never sees it. If the path is ignored, choose a tracked location (`.claude/skills/<area>-verify/`, `skills/<area>-verify/`), or keep the path and add it with `git add -f <path>` (the next `git add -A` skips it, so tell the user to commit it with `-f`; do not commit yourself when told not to). Start from [verify-skill.template.md](../assets/templates/verify-skill.template.md). The frontmatter is required: a skill without a `name` (matching its folder) and a `description` that says when to use it never registers, and the next agent will never see it. The description names the area and the trigger: "Use when changing `<files or functions>`, or when asked whether `<area>` still holds".

From the skill alone, the next agent must be able to tell whether a change touches the verified code, run the check, tell a real bug from a modeling error, and update the verification when a change is intended. It contains, under these headings:

1. **The promise and the harm.** The property in one plain sentence, and what breaks for users if it fails, in one more.
2. **Coverage.** A record per check: its id (the manifest model id), tool, the files and functions it covers (the same list as `covers` in the manifest, with function names), and the `@code` tags that tie model steps to lines. Plus the **sync commit**: the commit at which the verification was last confirmed to describe the covered code.
3. **Bounds and assumptions.** The concrete bounds (for example "2 workers, 3 jobs, at most 2 retries; 1.2M states"), the assumptions from CORRESPONDENCE.md (each a place a bug could hide), and what the check does not cover.
4. **Toolchain** (the template puts items 4 and 5 under one heading, "Run it"). Where the scripts are. In OMPdesk, read `skill://ompdesk-formal-verify`; the folder of the SKILL.md it shows is `<tools-dir>`. The commands in the skill are written with `<tools-dir>` spelled out as that lookup, once, at the top of the Run section. For CI and for machines without OMPdesk, say where the repo vendors the scripts (copy the skill's `scripts/` and `assets/toolchain.json` into, for example, `formal/tools/`; see [ci-and-drift.md](ci-and-drift.md)), or give the raw TLC command from [tlc-cli.md](tlc-cli.md). The scripts are self-contained TypeScript and need only Bun; they fetch the pinned TLC (and a JRE if none works) or Lean into a cache on first use.
5. **Run it.** One command, copy-pasteable, with this repo's real paths: `bun <tools-dir>/scripts/verify-all.ts formal --only <id>`. Plus what each outcome looks like: PASS, FAIL with a trace, UNAVAILABLE (exit 3: the tool could not be prepared; report "not checked", never "passed"), and the drift line.
6. **Does my change touch this?** The covered files and functions, plus how to find new code that touches the guarded state (the grep for its identifiers). If the answer is yes, run the check; if the check or the covered code needs to change, go to the intended-change section.
7. **A failure: real bug or modeling error?** Replay the counterexample against the real code, step by step, using the `@code` location on each trace row. If a step cannot happen in the code, the verification is wrong: fix the verification and say what was wrong. If every step can happen, it is a bug: tell the counterexample as steps in the code's words, state the harm in one sentence, and report it. Never weaken the property or the model, add a state constraint, or add fairness to make it pass; if you must change one on purpose, say so as a model change.
8. **Updating the verification for an intended change.** Change the verification from the code, before rerunning, so each changed part points at code a reviewer can open. Keep one indivisible step in the code as one step in the model. Change a property only for a promise that changed on purpose, and cite the evidence (doc comment, tests, changelog, commit message). Rerun, then break the new code the way the property guards against and confirm the check catches it; `mutate.ts` does this when the mutation set is current.
9. **Moving the sync commit.** Move the sync commit forward only after confirming that the verification describes the code at the new commit (see "The sync commit" below).
10. **Known findings** (optional): open findings with the commit that introduced them, so the next agent does not rediscover them.

Use this repo's real commands, paths and nouns. A finished skill contains no angle-bracket placeholders, no template instructions and nothing generic: grep it for `<` and for the words "TODO" and "template" before you move on. The one allowed indirection is the `<tools-dir>` lookup in item 4, spelled out in the text.

### A.5 Prove it before you hand off

Follow the generated skill once, as the next agent would, on a scratch change that breaks the property in the real code. It must catch the break. Then drop the scratch change and confirm the check is back where it started: passing, or failing only on the findings you will report. A verify skill that was never run is a draft. If the skill misses the break or a step does not run, fix the skill or the verification, not the scratch change.

Concretely:

1. Make a scratch change in the covered code that breaks the promise: remove the check or reorder the step the property guards. Work on a throwaway branch (`git switch -c scratch/verify-proof`) so dropping it is one command.
2. Follow the skill as written. Its "Does my change touch this?" section must tell you that the change touches covered code, and its "Updating the verification for an intended change" section must take you to the model: change the model to describe the scratch code as the code now reads (the `@code` tags show which action to edit). Run the skill's command. It must fail on the property the break violates, with a trace whose `@code` rows land on the code you broke, and the drift line must name the changed covered file. For a verifier that runs directly on the code, the command fails without any model edit.
3. If the model cannot see the break because the scratch change is below its abstraction, say so in the skill's Bounds and assumptions section and pick a break the model can see.
4. Drop the scratch change and the model edit (`git switch -`, delete the branch) and rerun: the result must be the pre-break result.

What the scratch break does to the files around it:
- **Editing the model invalidates `mutations.json`.** A mutation's `search` text is matched against the model, so once you changed the lines it points at, the run reports those mutations `INVALID` (the search text does not occur) and the exit code is 2. That is expected during the scratch break; judge only the matrix and the trace, ignore the mutation run (`--skip-mutations`), and restore the model before the final rerun, where every mutation must be `DETECTED` again.
- **The drift line names the changed covered code.** With the scratch change in the working tree the run prints `DRIFT  <id>: drift - DRIFT: 1 covered item(s) changed since <sha>...` (not `ok`), plus a `changed since sync: <file#name>` line. It is a prompt to look, so it does not fail the run unless `--strict-drift` is given.

### A.6 Hand off

Tell the user:
- what you verified, in one plain sentence for the property and one for the harm;
- which tool you used and why;
- the bounds, and the states explored;
- what the check found, in plain words (the counterexample as steps in the code's words, and its status: confirmed, suspected or refuted);
- how to run it (the one command) and how long it takes;
- what it does not cover;
- where the verify skill lives and that the next agent can find it by its description.

Suggest a second target only if you found a close one. Mention that after changes that did not recheck the verification, the maintain loop below brings it back in line.

---

## B. Maintain the verification (the drift loop)

Use this when a project already has a verify skill and the code changed without it being used: merges, edits made without the skill, or drift that built up across many commits. The verify skill handles a change an agent makes while using it. This loop handles the changes that skipped it. It is also workflow W6.

### Outcomes

Give each check exactly one outcome, and say which:

- **in sync**: no change since the last sync alters what the check describes, and the check passes.
- **updated**: the code changed, the verification now describes the new code, and the check passes.
- **bug**: the verification describes the current code, and the code breaks the property. This is a finding about the code, not drift.
- **blocked**: the check could not be brought back in line or could not run (including UNAVAILABLE, exit 3). Say exactly why.

A check can be both updated and bug: the update makes the verification describe the code again, and then the property fails on it.

### Edit scope

Edit only the verification: models, harnesses, property files, `matrix.json`, `mutations.json`, CORRESPONDENCE.md, the manifest and the verify skill. Never edit product code during a run unless the user asks you to. When a property fails on the current code, do not weaken the property or the model to make it pass. Report the failure.

### The pass

1. **Find the checks.** A verify skill has no fixed name, so find it by what it does. Start with `formal/manifest.json`: each model lists its `covers` and its `verifySkill`. Then look for project skills that run a model checker, a prover or another verifier against named code (`.omp/skills/`, the repo's own skill folders). Read each one you find, or the one the user named. For each check collect: the property, the code it covers, the bounds and assumptions, the command that runs it, and the sync commit. If no verify skill exists, stop and run section A instead. If the skill and manifest record no sync commit, use the last commit that changed the verification files (`git log -1 --format=%H -- <model dir>`) and say that you did.

2. **Run it as it is.** Run each check once before you change anything, and record the result:
   ```bash
   bun <skill-dir>/scripts/verify-all.ts formal --only <id>
   ```
   A pass here does not tell you the code is correct. It tells you the old description still holds. A failure here can be drift or a bug. Do not decide which until step 5. The same run prints the drift: each covered file that differs from `syncCommit` (a `changed since sync:` line and a `DRIFT` line, never an `ok`) and any `@code` tag that no longer resolves. It compares the working tree with the sync commit, so uncommitted edits to covered files show up too. A `syncCommit` that is not a commit of this repository is a failure.

3. **Read every change to covered code.** Diff the covered files from the sync commit to the current commit and read each commit message:
   ```bash
   git log --format='%h %s' <syncCommit>..HEAD -- <covers>
   git diff <syncCommit>..HEAD -- <covers>
   ```
   Also look for code that moved: a covered function that is renamed, split or moved to another file is still covered code (`git diff -M --name-status <syncCommit>..HEAD`, and search for the function's body). Also look for new code that touches the state a check guards, such as a new function that writes the same fields (search the state's identifiers across the repo). For each change decide which of these it is:
   - **No effect.** It does not alter anything the verification describes, such as formatting, comments, or code paths the verification does not cover. Check this against the model, not against the commit message.
   - **The verification no longer describes the code.** A step that was one indivisible action is now two, a branch was added or removed, a check moved, a new path reaches the guarded state, or a value now has a different range. The model must change.
   - **The promise changed on purpose.** The change alters what the code promises, and evidence in the change says it is intended: the doc comment, the tests, the changelog or the commit message. The property must change, and you must cite that evidence.
   - **The promise may be broken.** The code changed and no evidence says the promise changed. Treat a failure that follows as a bug candidate.

4. **Update from the code, not from the result.** Change the model so that each changed part again points to code a reviewer can open: fix the `@code` tags (a moved function gets its new location; `verify-all.ts` fails on a tag that does not resolve) and CORRESPONDENCE.md. Keep one indivisible step in the code as one step in the model. Write the update from the code before you rerun, and do not shape it by what makes the check pass. Change a property only for a promise that changed on purpose: write down the old wording, the new wording and the evidence. Keep the bounds unless the change makes them wrong. If you must reduce a bound, say so in the report. Update `mutations.json` too, so each new guard or step has a mutation that breaks it.

5. **Rerun and judge each result.**
   ```bash
   bun <skill-dir>/scripts/verify-all.ts formal --only <id>
   ```
   - **Pass.** The check can now pass on a description that has lost the ability to fail. Break the new code the way the property guards against (remove a new check, reorder a new step) and confirm the check catches it; the mutation run (`mutate.ts`, run by `verify-all.ts`) is that proof when its mutations cover the new code, and a manual break in the model covers the rest. Then drop the break.
   - **Fail.** Replay the counterexample against the real code, step by step, using each trace row's `@code` location. If a step cannot happen in the code, the verification is wrong: fix it and say what was wrong. If every step can happen, it is a bug: name the commit that introduced it, tell the counterexample as a sequence of steps in the code's own words, and state the harm in one sentence. If a cheap test or reproduction against the real code shows the bug ([reproduce-and-fix.md](reproduce-and-fix.md)), add it to the report as evidence. Do not commit it to product code.

6. **Update the verify skill.** Update the covered files and functions, the commands, the bounds, the assumptions and the sync commit. Set the sync commit to the commit you checked (see below). Do not move it for a blocked check, and say so in the report. Then follow the verify skill once as the next agent would, so you know its steps still run.

### Report

Tell the user, for each check:

- the outcome (in sync, updated, bug or blocked) and the commits you read;
- what changed in the verification and why, with a short reason for each change: the code changed shape, or the promise changed on purpose (with the evidence);
- the rerun result, and the break you used to show the updated check can still fail;
- each bug in plain words: the counterexample as steps in the code's words, the harm, and the commit that introduced it;
- what the verification still does not cover, including new code it should cover and does not.

Say outright which failures were drift in the verification and which were bugs in the code. For a check that passed before you updated it and fails after, say that the old pass was on a stale description. Put the verification updates in a change of their own, separate from any product fix.

---

## The sync commit

The sync commit is the commit at which a person or agent last confirmed that the verification describes the covered code. It lives in two places: `syncCommit` of the model in `formal/manifest.json` (what `verify-all.ts` reads) and the line in the verify skill's Coverage section (what the next agent reads). Keep them equal; if they differ, the manifest wins and the skill is stale.

- `verify-all.ts formal --only <id> --stamp` writes the current HEAD into `syncCommit` of every selected model whose checks all passed or were skipped (matrix, mutations, `@code` tags, drift). It refuses, and says so, when a check did not pass or when the **covered code** has uncommitted changes (the covered functions and ranges, not whole files: edits elsewhere in the same file do not count). It cannot judge whether the model describes the code, only that nothing in it fails. So run `--stamp` only after you have done steps 3 and 4 of the pass (or W1.4 for a new model). The write reformats `formal/manifest.json` with tab indentation.
- **What the sha has to contain.** Only the covered code. The model files (`formal/`), the verify skill and the findings may be uncommitted, or not exist at that commit yet: drift compares covered code only, so stamping a sha that predates your model files is fine, and it is the normal state of a first stamp made before anything is committed.
- **When you may not commit** (the task says no commits) **and the covered code is changed**, a HEAD stamp would not describe it, so plain `--stamp` refuses. Use `--stamp --allow-dirty`: it stamps HEAD and also writes `syncDiff`, a digest of the covered code as it is now. The model is then in sync while the covered code still equals what you stamped, whether or not someone has committed it since; any further change is drift. Prefer a real commit when the user allows one: `syncDiff` goes away at the next plain `--stamp`. Never use `--allow-dirty` to hide covered edits you did not check the model against.
- A model that failed, was blocked, or was UNAVAILABLE keeps its old sync commit.
- After `--stamp`, copy the new value into the verify skill's Coverage section in the same change.
- The sync commit moves forward only with a verification change that you can point to; moving it with no model change is a claim that the model was already right, and the report must say that and why.
- CI runs `verify-all.ts formal --strict-drift`, which fails when a covered file changed after `syncCommit`, so a PR that touches covered code must update the model and the stamp, or be explicitly waived ([ci-and-drift.md](ci-and-drift.md)).
