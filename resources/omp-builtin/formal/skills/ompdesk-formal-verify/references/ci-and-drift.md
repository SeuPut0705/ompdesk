# CI guards and drift detection (W5, W6)

> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

A model that runs only once rots. Two mechanisms keep it alive:
- **CI** re-checks the model on every change.
- **Drift detection** re-checks that the model still describes the code.

One script does both: `bun <skill-dir>/scripts/verify-all.ts formal --strict-drift`. `<skill-dir>` is the folder of SKILL.md. It reads `formal/manifest.json` ([persist.md](persist.md)) and, for every model, re-runs the TLC matrix or configs (`tlc.ts`), the Lean build and trust audit (`lean-check.ts`), the mutations (`mutate.ts`), resolves every `@code` tag in the model's folder, and compares the covered files with the model's `syncCommit`. It prints one `ok`, `FAIL`, `skip` or `NOT CHECKED` line per check and a `PASS` or `FAIL` line per model. Exit 0 means all of it passed; 1 means a check failed; 3 means a tool was UNAVAILABLE (not checked); 2 means a bad manifest or arguments. `--only <id>` selects one model, `--skip-mutations` leaves the mutation run out (for a quick PR tier; run the mutations nightly).

## Getting the scripts into CI

The scripts are self-contained TypeScript that need only Bun. They fetch the pinned TLC (tla2tools 1.8.0 and CommunityModules, SHA-256 checked) and a Java runtime only if no working Java exists, or the pinned Lean toolchain, into a cache on first use. A repo that wants CI has two options:

1. **Vendor them (recommended).** Copy the skill's `scripts/` folder and `assets/toolchain.json` into the repo, for example:
   ```
   formal/tools/scripts/        (copy of <skill-dir>/scripts, without scripts/statechart unless you use it)
   formal/tools/assets/toolchain.json
   ```
   The scripts find the pin file at `../assets/toolchain.json` relative to `scripts/`, so keep that layout. `bun formal/tools/scripts/verify-all.ts formal ...` then runs on any machine with Bun. Re-copy when OMPdesk's skill changes the pins, and review the diff (the pin file holds the download URLs and SHA-256 sums).
2. **Check the skill out.** Keep a pinned copy of the skill in another repo or a release asset and fetch it in the job. The commands are the same with another path.

Without Bun, TLC can be called directly: the raw commands are in [tlc-cli.md](tlc-cli.md). That route gives up the matrix, the mutations and the drift check.

Set `OMPDESK_FORMAL_CACHE` to a folder inside the workspace and cache it between runs. Set `OMPDESK_FORMAL_OFFLINE=1` in a sandbox that must not download: the scripts then report UNAVAILABLE (exit 3) and the job fails instead of passing unchecked.

## Config tiers

| Tier | When | Budget | Contents |
|---|---|---|---|
| fast | every PR touching covered files | under 2 min per model | smallest bounds that still catch every past bug; all safety invariants; bug-mode configs that must fail (`"expect": "violation"` in `matrix.json`); the mutation set |
| deep | nightly | under 60 min | larger bounds (`constants` overrides in a second matrix), liveness configs, simulation with `-- -simulate num=100000 -depth 100` in `args` |
| proof | every PR touching `lean/` | `lake build` time | all theorems, zero `sorry`, axiom audit (`lean-check.ts`) |

A tier is a model entry in the manifest. A model has one `matrix`, so the deep tier is a second entry with its own matrix file and an id ending in `-deep`, pointing at the same spec and `covers`. The PR job runs the fast ids with `--only`; the nightly job runs everything.

```json
{ "id": "job-lease", "kind": "tla", "dir": "job-lease/tla", "spec": "JobLease.tla", "matrix": "matrix.json", "mutations": "mutations.json", "covers": ["src/worker.ts"], "syncCommit": "<sha>" },
{ "id": "job-lease-deep", "kind": "tla", "dir": "job-lease/tla", "spec": "JobLease.tla", "matrix": "matrix-deep.json", "covers": ["src/worker.ts"], "syncCommit": "<sha>" }
```

See [matrix.example.json](../assets/templates/matrix.example.json) for a fast matrix with a bug-mode run, and [mutations.md](mutations.md) for the mutation set.

## GitHub Actions: TLA+ (fast tier, every PR)

```yaml
name: formal
on:
  pull_request:
    paths: ["formal/**", "src/**"]        # narrow "src/**" to the manifest's covers
jobs:
  tla:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        model: [job-lease]                # one entry per fast TLA+ model id in formal/manifest.json
    env:
      OMPDESK_FORMAL_CACHE: ${{ github.workspace }}/.formal-cache
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # drift runs git diff from syncCommit; a shallow clone cannot see it
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "21" }
      - uses: actions/cache@v4
        with:
          path: .formal-cache
          key: formal-tla-${{ hashFiles('formal/tools/assets/toolchain.json') }}
      - name: Model check, mutations, drift
        run: bun formal/tools/scripts/verify-all.ts formal --only ${{ matrix.model }} --strict-drift
```

The pin file fixes the TLC version, so a nightly upstream release cannot turn CI red with no code change. Bump the pin on purpose, in its own PR.

## GitHub Actions: Lean (proof tier)

```yaml
name: formal-lean
on:
  pull_request:
    paths: ["formal/**/lean/**", "src/**"]
jobs:
  lean:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        model: [queue]                    # one entry per Lean model id in formal/manifest.json
    env:
      OMPDESK_FORMAL_CACHE: ${{ github.workspace }}/.formal-cache
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v2
      - uses: actions/cache@v4
        with:
          path: .formal-cache
          key: formal-lean-${{ hashFiles('formal/tools/assets/toolchain.json') }}
      - name: Build, trust audit, mutations, drift
        run: bun formal/tools/scripts/verify-all.ts formal --only ${{ matrix.model }} --strict-drift
```

The Lean toolchain is a 0.9 GB download and about 3 GB on disk (about 4 GB at the peak while it unpacks), so cache it. The job fails on `sorry`, `admit`, user axioms, `native_decide`, or any theorem whose axioms go beyond `propext`, `Classical.choice` and `Quot.sound` (the audit of `lean-check.ts`).

## GitHub Actions: deep tier (nightly)

```yaml
name: formal-deep
on:
  schedule: [{ cron: "17 3 * * *" }]
  workflow_dispatch: {}
jobs:
  deep:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      OMPDESK_FORMAL_CACHE: ${{ github.workspace }}/.formal-cache
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "21" }
      - uses: actions/cache@v4
        with:
          path: .formal-cache
          key: formal-all-${{ hashFiles('formal/tools/assets/toolchain.json') }}
      - run: bun formal/tools/scripts/verify-all.ts formal --strict-drift
```

## Drift detection

Drift has two layers.

**Mechanical (`verify-all.ts`, runs on every PR).**
- Every `@code path:lines` tag of every model is resolved. The run fails if the file is missing or the line range runs past the end of the file. This catches moved and deleted code.
- `git diff --name-only <syncCommit> -- <covers>` lists the covered files that differ from the model's `syncCommit`, committed or not. Without `--strict-drift` the run prints each file and a `DRIFT:` note but still passes: it is a prompt to look. With `--strict-drift` it fails: the PR author must update the model, confirm it describes the new code, and move the stamp (`verify-all.ts formal --only <id> --stamp`), or explicitly waive it ([persist.md](persist.md#the-sync-commit)). A model with covered files and no `syncCommit` yet fails under `--strict-drift` and is skipped otherwise.
- A `syncCommit` that is not a commit of the checked-out repository fails the drift check in both modes. Use a full clone (`fetch-depth: 0`). A squash or rebase merge removes the stamped commit from the main branch, so after such a merge re-stamp on the main branch in a follow-up commit (the `--stamp` rule: only after confirming the model describes the code at that commit), or merge with merge commits.

**Semantic (needs more than a diff).** The code at the same lines can start doing something else while every tag still resolves. Use one of:
- **Review.** The drift loop in [persist.md](persist.md#b-maintain-the-verification-the-drift-loop): read every change to covered code against the model.
- **Trace validation.** Implementation logs replayed through the spec ([trace-validation.md](trace-validation.md)). The strongest option, and it runs continuously.
- **Model-based testing.** Traces generated from the spec drive the real code: TLC's `-- -simulate` output or a small driver that walks the matrix's traces, one test per trace.
- **Differential testing.** A Lean executable model compared with the real function on random or enumerated inputs ([lean-patterns.md](lean-patterns.md), section "Differential testing").

## PR nudge

A CODEOWNERS entry for the covered paths, or a PR template checkbox:

```
- [ ] This PR touches files listed in formal/manifest.json `covers` or in formal/*/CORRESPONDENCE.md → model updated and re-stamped / not needed because …
```

## Proving the CI job has teeth

After adding a job, push a deliberately broken scratch change (for example remove the guard that a mutation targets in the model, or alter a covered file without touching the model) on a throwaway branch and confirm the job turns red for the right reason. Then drop the branch. A guard that was never seen failing is a draft.
