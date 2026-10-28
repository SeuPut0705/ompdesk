# Mutations: proving that each property can fail

A model that passes is evidence only if the same model would have failed when the code is wrong. The sanity
config and the bug toggle (`tla-patterns.md`) prove that for one change you thought of. A mutation file proves
it for **every property**, mechanically: for each property it breaks the model in one small, named way and
requires the checker to fail on exactly that property.

`mutate.ts` is the tool: `bun <skill-dir>/scripts/mutate.ts <model file> <mutations.json> [--keep] [--json]`,
where `<skill-dir>` is the folder that holds `SKILL.md`. It works for TLA+ models (TLC), Lean projects and any
checker that can print `VIOLATED: <name>` lines. Use it after the matrix is green and before any report says
"verified".

## Mutation file

```json
{
	"checker": { "kind": "tlc", "config": "MC.cfg" },
	"properties": ["TypeOK", "SingleCommit", "ClaimedEventuallyDone"],
	"waive": { "TypeOK": "Shape check only: no behaviour change breaks it without also breaking a property above it." },
	"mutations": [
		{
			"name": "drop-fencing",
			"why": "Commit no longer compares the claim token: a stale holder can commit.",
			"search": "/\\ UseFencing => wtok[w] = token",
			"replace": "/\\ TRUE",
			"breaks": "SingleCommit"
		}
	]
}
```

| Key | Meaning |
|---|---|
| `checker` | `{"kind":"tlc","config":"MC.cfg"}`, `{"kind":"lean","project":"."}` or `{"kind":"command","command":["bun","x.ts","{dir}","{model}"]}`. TLC: `config` is the config of the baseline and of every mutation (default `<Model>.cfg`, so name `MC.cfg`), `workers` and `timeoutSec` (default 180 s per run) are optional. Lean: `project` is the Lake project folder, `allowNative` permits `native_decide`. `command`: `{dir}` and `{model}` become the mutated copy's folder and model file; the program prints one `VIOLATED: <name>` line per violated property and exits 0 (pass), 1 (violated), 2 (bad input) or 3 (unavailable). All kinds: `root` is the folder to copy (default: the model's folder, or the Lean project) |
| `properties` | The properties that each need a mutation. For `tlc` the default is every `INVARIANT` and `PROPERTY` name in the checker's config; it is required for `lean` and `command` |
| `waive` | `{"Property": "reason"}`: a property accepted without a mutation, with the reason written down. A waiver without a reason is an error |
| `mutations[].name` | Unique label, used in the output |
| `mutations[].why` | One sentence: which real mistake this stands for |
| `mutations[].search` | The exact text to replace. It must occur **once** in the file, or the mutation is `INVALID` unless `all` is true |
| `mutations[].replace` | The new text (empty to delete the text) |
| `mutations[].all` | `true` replaces every occurrence of `search` |
| `mutations[].breaks` | The property, or list of properties, this mutation is meant to break (`deadlock` names a TLC deadlock). The mutation counts as caught if the checker fails on any of them |
| `mutations[].file` | File to change, relative to the model's folder (default: the model file) |
| `mutations[].deadlock` | TLC only: `false` runs this mutation with `CHECK_DEADLOCK FALSE` (same as `-deadlock`). **Liveness mutations need it** (rule 1 below): a mutant that stops the model early deadlocks, TLC reports the deadlock and never reaches the liveness check. `checker.deadlock: false` sets it for every mutation |
| `mutations[].isolate` | TLC only: `true` runs the mutation under a config derived from the base config that keeps only the `INVARIANT`/`PROPERTY` entries named in `breaks`. TLC reports one violated property, the first it finds; with the others left out the report names the one you mean. This replaces a hand-written `MC_<property>.cfg` per property, and the unmutated model is not re-run under it, so a property that fails on the unmutated model shows up in the baseline instead |
| `mutations[].equivalent` | A reason (text): this mutant means the same as the model, so no property can notice it (a redundant re-read, a duplicated `sync()`, a reordering of independent steps). The checker still passes, and the mutant is recorded as `EQUIVALENT` with the reason instead of `MISSED`, so the run does not exit 1. It covers no property. If the checker fails on it, the claim is wrong: the result is `INVALID` (exit 2), so a stale claim cannot hide a real hole. Use it for what you proved by reading the code, keep the reason specific, and list such mutants in the report |
| `mutations[].config` | TLC only: run this config instead of the checker's. Use it to check one property in isolation (an extra config with a single `INVARIANT`). The unmutated model must pass under that config too (it is run first), or the mutations that use it are `INVALID`: a config that fails on its own proves nothing about a mutation |

Every run works on a copy of the model's folder in a temporary directory; your files are never touched. `--keep`
leaves the copies and prints their location on stderr so you can open a mutated model and read the counterexample.
`--json` prints the whole report (baseline, per-mutation results, per-property coverage and the exit code) as JSON
instead of the lines shown below.

## What the output means

The unmutated model runs first and must pass; if it does not, nothing else is judged and the exit code is 1.
(When you scratch-break the model while proving a verify skill, `mutations.json` stops matching it: see `persist.md` A.5.)
Then, per mutation:

| Verdict | Meaning | What to do |
|---|---|---|
| `DETECTED` | The checker failed on a property the mutation says it breaks | Nothing: that property is shown to be able to fail |
| `MISSED` | The checker still passed, or it failed on a property the mutation did **not** name | See "What MISSED means" |
| `EQUIVALENT` | The mutation carries an `equivalent` reason and the checker passed, as declared | Nothing: it is recorded with its reason, counts toward no property, and does not fail the run |
| `INVALID` | The `search` text does not match (or matches more than once), the file cannot be read, or the mutated model no longer parses (TLC) or no longer elaborates (Lean: an unknown identifier or constant, an unexpected token, an unknown tactic: the model is broken, not a property), hits an evaluation error (for example a variable left unspecified) or runs out of time | Fix the mutation: the file changed, or the replacement is not valid TLA+ |

After the mutations, each property in `properties` is reported as covered (with the mutations that detected it),
`WAIVED` (with the reason) or `UNCOVERED` (no mutation detected it, no waiver).

Exit codes, as for every script of this skill: 0 all mutations DETECTED and every property covered or waived;
1 any `MISSED`, any `UNCOVERED`, or a baseline that does not pass; 2 any `INVALID` mutation (or an unreadable
mutation file); 3 the checker is unavailable (report "not checked", never a pass).

A failing file looks like this (a mutation that changes nothing observable, a `search` text that is not in the
file, and properties left without a mutation):

```
baseline: pass
MISSED   stutter-only: the checker still passes: the properties do not notice this change
INVALID  typo: the search text does not occur in the file
WAIVED   TypeOK: shape
UNCOVERED NoLostUpdate: no mutation makes it fail, so nothing shows it can
UNCOVERED MutEx: no mutation makes it fail, so nothing shows it can
UNCOVERED AllFinish: no mutation makes it fail, so nothing shows it can
0 of 2 mutations detected
```

## Writing good mutations

One mutation per property, each the smallest honest version of a real mistake:

- **Drop the guard.** Remove the condition that keeps the bad state out (the lock wait, the fencing compare, the
  claim-before-effect, the CAS `WHERE status = 'pending'`). The guard you remove is usually the one the bug
  toggle (`UseLock`, `UseFencing`, `ClaimFirst`, `UseCAS`) switches; the mutation proves the *property* sees it
  even when the toggle is on.
- **Reorder two steps.** Swap the order of two actions or the two statements inside one (record before apply,
  invalidate before write).
- **Remove fairness.** Delete the `WF_vars(...)` or `SF_vars(...)` term from `Spec`. The liveness property must
  then fail by stuttering. If it still passes, the property holds trivially.
- **Widen a bound.** Raise the capacity or counter limit a safety property depends on (`Cap`, `MaxClaims`, a
  retry budget), so the bound the property relies on no longer holds.
- **Remove an `UNCHANGED` or a primed assignment.** Only when the result is a *wrong behaviour* the property can
  see. A variable left unspecified is a TLC evaluation error (the mutation is `INVALID`), which proves nothing.
- **Make an action do the wrong thing.** Discard a read, write a stale value, skip a delivery.

Rules that keep the result honest:

1. **A mutation breaks exactly the property it names.** Run it, read the counterexample (`--keep`), and check
   that the reported property is the one in `breaks`. TLC reports only the first violated property, and a
   mutation that opens a race usually trips the safety property that fails earliest. If `NoLostUpdate` and
   `MutEx` both fail, TLC names `MutEx`, the shallower one; a mutation meant for `NoLostUpdate` must keep `MutEx`
   true (see `drop-read` in `assets/patterns/LostUpdate/mutations.json`), or set `"isolate": true` (the other
   properties are left out of the config for that run; see `macrotask-runs-inside-a-turn` in
   `assets/patterns/EventLoop/mutations.json`), or run with a `config` of your own that checks only that property.
   **A liveness property** (`<>`, `~>`) is checked after the safety ones and only on a model that did not stop:
   remove its fairness, or any change that lets the model get stuck, and TLC reports a deadlock first. Give
   those mutations `"deadlock": false`. The output tells you: `failed on deadlock, not on <property>` ends with
   the hint to set it.
2. **List a property in `breaks` only if the counterexample shows it.** A long list of names makes every
   mutation look caught. Use more than one name only when the failing property can legitimately be either.
3. **The mutation changes the model's behaviour, not its text.** Renaming a variable or reformatting is not a
   mutation. `search` and `replace` must both parse.
4. **Keep each mutation to one change.** If it needs three edits, it is three mutations or the wrong
   abstraction.
5. **Write `why`.** A reviewer must see which real bug the change stands for.

## What MISSED means

`MISSED` says the properties do not notice a change that ought to break them. Either the property is vacuous
(its premise never holds, it states less than you think, or it is guarded by a `Quiescent` predicate that never
becomes true) or the model has lost the behaviour (an action that never fires, a bound that is too tight, a
constant that removes the race). **Fix the model or the property. Never loosen the mutation to make it pass:**
changing `search`, `replace` or `breaks` so that the verdict turns green throws away exactly the signal you
asked for.

Triage:

1. `--keep`, open the mutated model, run it with `tlc.ts ... --coverage`. An action with 0 distinct states is dead.
2. If the mutation passes because the property is conditional (`P => Q`), check `~P` as an invariant; if `~P`
   holds, the property is vacuous.
3. If it fails on a *different* property than the one named, the mutation is probably not isolated: fix the
   mutation (rule 1: `"isolate": true`, or `"deadlock": false` when the other name is `deadlock`). That is the only case where changing the mutation is
   right, and the verdict must still come from a run, not from the edit.
4. If the model cannot reach the mutated behaviour within the bounds, raise the bounds, or say in the report that
   the property is untested at the stated size.

## Equivalent mutants

Some changes do not change the behavior the model can show: a second `sync()` where the marker is already set, two
independent steps swapped, a re-read of a value nothing changed in between. No property can notice them, and they
are not a hole in the properties. Do not delete them (the finding that the code does the same thing twice is worth
keeping) and do not leave them `MISSED` (exit 1 forever). Write the reason in `equivalent`: the run records
`EQUIVALENT name: no property notices it, as declared: <reason>` and moves on. The reason must say why the two
models are the same, in terms a reviewer can check; "it passes" is not a reason. An `equivalent` mutant that the
checker does catch turns `INVALID`, so a claim that stopped being true fails the run.

## Waivers

A waiver is an honest "no mutation is useful here", with the reason in the file. Typical: a pure `TypeOK` shape
check, a property that restates another one, a bound that exists only to keep TLC finite. A waiver is not a
way around `MISSED`: if a real property resists every mutation, that is a finding about the property. The report
lists waivers; do not add one without telling the user why.

## Worked example: `examples/job-lease/`

`examples/job-lease/` holds a small worker with a lease (`src/worker.ts`), its TLA+ model, the three configs, the
matrix, a mutation file with one mutation per property of the model, and a `manifest.json`. Everything is under
`<skill-dir>/examples/job-lease/formal/job-lease/tla/`:

```
bun <skill-dir>/scripts/tlc.ts <skill-dir>/examples/job-lease/formal/job-lease/tla/JobLease.tla --matrix <skill-dir>/examples/job-lease/formal/job-lease/tla/matrix.json
bun <skill-dir>/scripts/mutate.ts <skill-dir>/examples/job-lease/formal/job-lease/tla/JobLease.tla <skill-dir>/examples/job-lease/formal/job-lease/tla/mutations.json
```

Smaller files with the same format: `assets/patterns/<Name>/mutations.json` for each of the eight patterns
(`tla-patterns.md`). Among them: a guard dropped, a read discarded, a dedup table pre-seeded, two items
reordered, a lease check removed, fairness removed, and `TypeOK` waived with a reason. Running the one for
LostUpdate prints:

```
baseline: pass
DETECTED drop-lock-guard: failed on MutEx
DETECTED drop-read: failed on NoLostUpdate
DETECTED remove-fairness: failed on AllFinish
WAIVED   TypeOK: Shape check only: ...
covered  NoLostUpdate (by drop-read)
covered  MutEx (by drop-lock-guard)
covered  AllFinish (by remove-fairness)
3 of 3 mutations detected
```

## In the manifest

A model entry names its mutation file (`"mutations": "mutations.json"`), and `verify-all.ts` runs it with the
matrix, the `@code` tag check and the drift check (`ci-and-drift.md`, `persist.md`). Rerun mutations whenever a
property, the model or a constant changes: a new property needs a new mutation or a waiver.
