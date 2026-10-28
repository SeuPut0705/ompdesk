---
name: <area>-verify
description: <One sentence naming what this verifies and when to use it. Example shape: "Checks that <property> still holds for <area>. Use when changing <files or functions>, or when asked whether <area> is still correct.">
---
<!-- Adapted from pstack (MIT, Lauren Tan; LICENSES/MIT-pstack.txt) and opum-ai/proof-skills (MIT, Opum AI; LICENSES/proof-skills-MIT.txt). This is the skeleton of a project-local verify skill (references/persist.md, section A.4). Replace every <placeholder> with this repo's real values, delete the headings that do not apply, and delete this comment. A finished skill has no angle brackets left except the <tools-dir> lookup in "Run it", no instructions to the author, and nothing generic. -->

# <Area> verification

## The promise and the harm

<The property in one plain sentence, in this repo's words.>
<What breaks for users if it fails, in one plain sentence.>

## Coverage

| Check id | Tool | Covers (files and functions) | Model and tags |
|---|---|---|---|
| `<manifest model id>` | <TLC2 Version 2026.10.28.x (tla2tools release 1.8.0) / Lean 4.35.0 / other; quote the version `tlc.ts` prints> | `<path/file.ext>`: `<function>`, `<function>` | `<formal/.../Spec.tla>`, tags `@code <path:lines>` on `<Action>`, ... |

Sync commit: `<git sha>`. This is the commit at which the verification was last confirmed to describe the covered code. It mirrors `syncCommit` of `<id>` in `formal/manifest.json`; if they differ, the manifest wins and this line is stale.

## Bounds and assumptions

- Bounds: <concrete bounds, for example "2 workers, 3 jobs, at most 2 retries; 1.2M states, depth 18">.
- Assumptions (each is a place a bug could hide): <A1 ...>; <A2 ...>. The full table is `formal/<concern>/CORRESPONDENCE.md`.
- Not covered: <what the check does not look at>.

## Run it

`<tools-dir>` is the folder of the SKILL.md that you see when you read `skill://ompdesk-formal-verify`. <If the repo vendors the scripts: "In CI and on machines without OMPdesk it is `formal/tools`.">

```bash
bun <tools-dir>/scripts/verify-all.ts formal --only <id>
```

It takes about <duration>. Read the result like this:
- `PASS`, exit 0: no counterexample within the bounds above. It does not mean the code is correct.
- `FAIL`, exit 1: a property was violated, a mutation was MISSED, or an `@code` tag no longer resolves. A violation prints a trace with one row per step: the action, its `@code` location and the variables that changed.
- A `DRIFT` line (not `ok`): covered code differs from the sync commit, so the model needs another look (CI adds `--strict-drift` and fails on it). It names what changed: a file, `file#function` or `file:lines`. A sync commit that is not in this repository fails.
- `NOT CHECKED`, exit 3: the tool could not be prepared (for example offline). Report "not checked". Never report it as a pass.

## Does my change touch this?

It does when it changes `<covered files and functions>`, or adds code that reads or writes `<the guarded state: identifiers to search for>`. If it does, run the check below. If it does not, the check is not needed.

## A failure: real bug or modeling error?

Replay the counterexample against the real code, step by step, using the `@code` location on each trace row. If a step cannot happen in the code, the verification is wrong: fix the verification and say what was wrong. If every step can happen, it is a bug: tell the counterexample as steps in the code's own words, state the harm in one sentence, and report it. Never weaken the property or the model, add a state constraint or add fairness to make the check pass. If a change to the property is intended, say so as a model change and cite the evidence.

## Updating the verification for an intended change

1. Change the model from the code, before you rerun: each changed part must again point to code a reviewer can open (`@code` tags, `formal/<concern>/CORRESPONDENCE.md`). One indivisible step in the code stays one step in the model.
2. Change a property only when the code's promise changed on purpose. Write down the old wording, the new wording and the evidence (doc comment, tests, changelog, commit message).
3. Keep the bounds unless the change makes them wrong. If you must reduce one, say so.
4. Update `<mutations file>` so each new guard or step has a mutation that breaks it. Rerun. Then break the new code the way the property guards against and confirm the check catches it.

## Moving the sync commit

Move the sync commit forward only after you confirmed that the verification describes the code at the new commit. Commit the code first when you may, then run `bun <tools-dir>/scripts/verify-all.ts formal --only <id> --stamp`, and copy the new sha into the Coverage section above in the same change. The sha only has to contain the covered code: the model files may be uncommitted. When you may not commit and the covered code changed, `--stamp --allow-dirty` stamps HEAD plus those changes. Do not move it for a check that failed, was blocked or was UNAVAILABLE.

## Known findings

- <F1: title, status, the commit that introduced it, the counterexample as short steps. Delete this section if there are none.>
