> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# Lean setup: elan, lake, the pinned toolchain

`<skill-dir>` is the folder that holds this skill's `SKILL.md`.

## Install (automatic)

```bash
bun <skill-dir>/scripts/setup.ts lean            # idempotent; prints READY or UNAVAILABLE
bun <skill-dir>/scripts/setup.ts lean --check    # report only, never downloads
```

`setup.ts lean` installs into a per-user cache, with no sudo and nothing system-wide:

| Platform | Cache folder |
|---|---|
| macOS | `~/.cache/ompdesk/formal` |
| Windows | `%LOCALAPPDATA%\ompdesk\formal` |
| any | `OMPDESK_FORMAL_CACHE=<dir>` overrides the folder |

What it fetches (versions and SHA-256 hashes live in `assets/toolchain.json`):
- **elan** 4.2.4, placed in `<cache>/elan` (`ELAN_HOME`).
- **Lean `v4.35.0`**, a zip archive of about 0.9 GB (about 2 GB unpacked), placed where elan keeps toolchains. No Mathlib.

The first install needs the network and takes a few minutes. Later runs find the files and download nothing.
`OMPDESK_FORMAL_OFFLINE=1` refuses every download. If the tools are missing and cannot be fetched, `setup.ts` exits 3
(`UNAVAILABLE`). Report that as "not checked", never as a pass.

Other environment switches: `OMPDESK_FORMAL_SYSTEM_LEAN=1` uses a `lake` already on `PATH` instead of the cache (the
only route on Linux, which has no pin), and `OMPDESK_FORMAL_TOOLCHAIN=<file>` selects an alternate pin file.

You rarely run `lake` yourself. `lean-check.ts` calls the setup code and sets `ELAN_HOME` and `PATH` for you. To run
`lake` by hand, point both at the cache:

```bash
export ELAN_HOME=<cache>/elan
export PATH="$ELAN_HOME/bin:$PATH"
```

## Scaffold and check a project

```bash
bun <skill-dir>/scripts/new-lean.ts formal/queue/lean Queue     # UpperCamelCase package name
bun <skill-dir>/scripts/lean-check.ts formal/queue/lean         # lake build + trust audit
```

`new-lean.ts` copies `assets/lean-template/` (no dependencies, `lean-toolchain` = `leanprover/lean4:v4.35.0`) and
refuses to overwrite an existing lakefile. `lean-check.ts` fails on `sorry`, `admit`, user `axiom`, `native_decide`
(unless `--allow-native`), and any theorem whose axioms go beyond `propext`, `Classical.choice` and `Quot.sound`.

## Project layout and commands

| Command | Effect |
|---|---|
| `lake new foo` | new project (std template: library plus executable, TOML config). Other templates: `exe`, `lib`, `math` |
| `lake build` | build the default targets and their dependencies |
| `lake build replay` | build one named target (here the replay executable from `assets/lean-patterns`) |
| `lake env lean F.lean` | elaborate one file with the project's search paths set. It does **not** rebuild the project's own modules, so run `lake build` first when `F.lean` imports them. |
| `lake exe replay` | run an executable target |
| `lake update` | refresh `lake-manifest.json` (only relevant once a `[[require]]` exists) |

The `lean-toolchain` file pins the exact Lean version, and elan honors it. A project whose `lean-toolchain` names a
different version makes elan try to install that version, which needs the network. Keep `leanprover/lean4:v4.35.0` in
every project you scaffold. Toolchain drift is the most common source of friction in Lean work.

## No packages by default

The template and the pattern project have no `[[require]]` blocks. A dependency means `git` and a network at
`lake build` time, and a package tag must match `lean-toolchain`. Everything in this skill is written against core Lean
and `Std`: `List`, `Array`, `Std.HashMap`, `omega`, `grind`, `decide`, `bv_decide`, `simp`, `mvcgen`,
`Relation.TransGen`. Two consequences:
- Random testing with the `plausible` package is not available. Use `#eval` over `Explore.reachable`, or an exhaustive
  bounded generator (see `Pipeline.lean` in `lean-patterns.md`).
- `aesop` is not in core. Use `grind`.

If a model really needs a package (Mathlib for probability or algebra, for example), add the `[[require]]` block with a
`rev` that matches the toolchain, say so in the report, and expect a network download at first build:

| | No Mathlib (the template) | Mathlib |
|---|---|---|
| First build | seconds | downloads about 8 GB of prebuilt `.lake` |
| Available | List/Array/HashMap, `omega`, `grind`, `decide`, `bv_decide`, `simp`, `mvcgen`, `Relation.TransGen` | Finset, combinatorics, probability, `aesop`, a much larger lemma library |
| Use when | software models: state machines, protocols, pipelines, graph algorithms | real mathematics |

## Optional external tools (not installed by this skill)

- **lean-lsp-mcp:** an MCP server that gives an agent goal states, diagnostics, multi-tactic attempts and lemma search.
  Useful for long proof work, and only if the user has it configured. Run `lake build` first.
- **Veil** (verse-lab): a Lean DSL for transition systems with model checking and SMT automation. It pins its own
  toolchain, so keep it in a separate project.
- **Iris-Lean:** separation logic for fine-grained concurrent memory. More than a bug hunt usually needs.

## Toolchain version in this skill

The template and every file in `assets/lean-patterns` were built with Lean `v4.35.0`. To move to another version, edit
`assets/toolchain.json` and every `lean-toolchain` together, then rerun `lean-check.ts` on `assets/lean-patterns`.
