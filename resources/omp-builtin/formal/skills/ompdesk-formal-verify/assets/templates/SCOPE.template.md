# Scope: <concern>

<!-- Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources. SCOPE.md is required for every concern (SKILL.md step 10). Fill it in before you write the model, update it when the model changes, and delete this comment. -->

## The promise and the harm

<The property in one plain sentence, in the code's words.>
<What breaks for users when it fails, in one plain sentence. Why tests rarely reach it, in one more.>

## Modeled (in scope)

What the model contains, one line each, with the code it stands for (the full map is `CORRESPONDENCE.md`):

- <component or protocol step> (`<path/file.ext:lines>`)

## Abstracted

Real behavior the model reduces. Each is a place a bug could hide, so also list it under Assumptions in `CORRESPONDENCE.md`:

- <what is reduced, and to what: "one key", "the DB read is atomic", "time is a counter">

## Out of scope

Paths, components and failure kinds the model does not look at, and why. A reader must know what a PASS says nothing about:

- <launch marker, retry hand-over, wake window, two tabs at once, disconnect and reconnect, fields the comparison ignores>

## Properties

The frozen set lives in `Properties.md` (`assets/templates/Properties.template.md`); list only the names and kinds here:

| Name | Kind | Source |
|---|---|---|
| `<Property>` | invariant / action / liveness | `<doc, issue, commit, API contract>` |

## Bounds

The concrete bounds of each run (`matrix.json`), and why they are small enough to run and large enough to show the bugs found so far:

| Run | Bounds | States, depth, time |
|---|---|---|
| fast | <2 workers, 3 jobs, at most 2 retries> | <1.2M, 18, 8 s> |
| deep | <bounds> | <...> |

## Tools and files

- Tool: <TLA+ with TLC / Lean 4>, and why this one (`choosing-tools.md`).
- Files: `<tla/Spec.tla>`, `<tla/MC.cfg>`, `<tla/matrix.json>`, `<tla/mutations.json>`, `CORRESPONDENCE.md`, `evidence/`.
- Manifest id: `<id>` in `formal/manifest.json`; covers: `<files, functions (file#name), line ranges (file:10-40)>`.
