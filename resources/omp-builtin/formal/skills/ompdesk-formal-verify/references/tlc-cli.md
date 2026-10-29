> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# TLC, SANY, PlusCal: command-line reference

Two layers: `scripts/tlc.ts`, the wrapper this skill ships (run it with `bun`; it is the normal way to check a
model), and the raw TLC/SANY flags, config keywords and exit codes that stay useful for `-- extra TLC args`,
for reading logs and for CI without OMPdesk. `<skill-dir>` is the folder that holds `SKILL.md`.

## Where the tools live, and lazy setup

Nothing is installed with OMPdesk. `tlc.ts` prepares what it needs on first use by running the same code as
`bun <skill-dir>/scripts/setup.ts tla`:

| Piece | What it is |
|---|---|
| `tla2tools.jar`, release 1.8.0 | TLC, SANY, PlusCal translator, REPL. Pinned by SHA-256 in `assets/toolchain.json`. The pin is the release tag; the jar's own banner reads `TLC2 Version 2026.10.28.<build>` (the release asset is rebuilt), and `tlc.ts` prints the banner version of the run it just made. Quote that version, not the tag, in a report |
| `CommunityModules-deps.jar` | `Json`, `IOUtils` and friends (trace validation needs them); same pin file |
| Java | The first working `java` of version 11 or newer on the machine (a macOS `/usr/bin/java` stub is probed with `java -version`). Only when none exists, a portable Temurin 21 JRE is downloaded into the cache |

Cache folder: `~/.cache/ompdesk/formal` on macOS, `%LOCALAPPDATA%\ompdesk\formal` on Windows. Set
`OMPDESK_FORMAL_CACHE=<dir>` to put it somewhere else (tests and CI should: a temp or shared directory, never
the real home). `setup.ts` prints the exact paths it uses.

```
bun <skill-dir>/scripts/setup.ts tla            # prepare (idempotent); prints READY ... or UNAVAILABLE ...
bun <skill-dir>/scripts/setup.ts tla --check    # report only; downloads nothing
bun <skill-dir>/scripts/setup.ts tla --json     # the same, structured
```

Environment: `OMPDESK_FORMAL_OFFLINE=1` refuses downloads (the scripts then report UNAVAILABLE),
`OMPDESK_FORMAL_JAVA=<java>` picks a Java, `OMPDESK_FORMAL_NO_SYSTEM_JAVA=1` ignores the system Java and uses
the portable one, `OMPDESK_FORMAL_TOOLCHAIN=<pin file>` uses another pin file.

`setup.ts <tla|lean> --json` prints one JSON object on stdout; on failure it is `{"status":"UNAVAILABLE","target":"tla|lean","reason":"..."}` and the exit code is 3. Progress and download lines go to stderr, so stdout stays parseable. Cache leftovers: in-progress files are `*.part-<host>-<pid>` and `*.tmp-<host>-<pid>`, and the next setup removes those of a process that is gone. One installer runs per tool at a time: `.oslock-<name>` in the cache is an OS lock (`flock`, a sharing mode on Windows) that the system frees when its holder dies, so a killed setup never leaves a lock to clean up (a stopped one keeps it until it goes on); it needs Bun (`bun:ffi`), and the cache must be on this computer, not a network drive shared by several. An unusable cache (full or read-only disk, permissions) is reported as UNAVAILABLE, exit 3. The Lean install is large (see [lean-setup.md](lean-setup.md)): run the first `setup.ts lean` on its own.

## `tlc.ts`

```
bun <skill-dir>/scripts/tlc.ts <spec.tla> [--config X.cfg | --matrix matrix.json] [--workers N|auto] [--jobs N]
    [--no-deadlock] [--coverage] [--sany-only] [--out DIR] [--json FILE] [--code-root DIR]
    [--timeout SEC] [--trace] [-- extra TLC args]
bun <skill-dir>/scripts/tlc.ts --from-log <tlc-output.txt> [--spec Spec.tla] [--json FILE]
```

It parses the spec with SANY, runs TLC with `-noTE -XX:+UseParallelGC`, one worker, UTF-8 file and stream encodings
and a temporary metadir (no `states/` folder is left beside the spec; Ctrl-C removes it too), reads TLC's text output and prints:

- `PASS` or `FAIL`, the number of distinct states and the search depth;
- on a violation, deadlock or liveness failure, a reduced trace: one row per step with the action name, its
  `@code` location and only the variables that changed in that step.

A `Warning:` line TLC prints is shown as `WARN` (and written to `--json` as `warnings`). Two of them mean the "no error" does not cover what the config asks for, so `tlc.ts` reports them as a **failure** (outcome `unsound`, exit 1) instead of a pass: a state-level formula under `PROPERTY` (TLC checks it only in the initial state: use `INVARIANT`, or write `[]P`), and `SYMMETRY` together with a liveness property (TLC may miss a violation: check liveness without symmetry). A model with no initial state (`Init` is empty) is an error, not a pass.

| Flag | Effect |
|---|---|
| `--config X.cfg` | Config file; default is `<Spec>.cfg` next to the spec. `MC.cfg` is the convention, so pass it. Exclusive with `--matrix` |
| `--matrix matrix.json` | Run every entry of a matrix file (below); each entry names its own config. Exit 0 only if every run matched its expectation |
| `--workers N\|auto` | TLC worker threads for each run (default 1: the counterexample is the shortest and the same on every run; with `auto` it varies between runs). Use `auto` for one big model; liveness checks gain less. A run that asks for more than one worker is not run beside others unless `--jobs` says so |
| `--jobs N` | How many matrix runs go at once, each in its own TLC process (default: half the cores; `OMPDESK_FORMAL_JOBS=N` sets it too). Results are printed in matrix order whichever run ends first. `mutate.ts --jobs N` does the same for the mutations of a TLC checker |
| `--no-deadlock` | Do not check for deadlock (adds `-deadlock`, TLC's confusingly named flag). Prefer an explicit `Terminated` disjunct |
| `--coverage` | Per-action coverage: actions that were never enabled are listed as a warning (a guard that is never true, dead code in the model) |
| `--sany-only` | The fast inner loop while writing a spec: SANY run with `-error-codes` (parse and level-check; a semantic error such as `-1` without `EXTENDS Integers` fails here, exit 2), then TLC loads the config for one simulated step of depth 1 (`<Spec>.cfg`, or the first run of `--matrix`), which catches an INVARIANT, PROPERTY or CONSTANT the spec does not define. No config: only SANY runs, and the output says so |
| `--out DIR` | Keep TLC's full output in `DIR` (one `<Spec>-<config>.log` per run) |
| `--json FILE` | Write the structured result (outcome, violated property, statistics, `warnings` (TLC's `Warning:` lines), `tlcVersion`). `trace` is already in the shape of a finding's `trace[]` (`step`, `action`, `code`, `changed` as `"from -> to"`, `violation`): paste it as it is. `rows` holds the same states as `tlc.ts` prints them (`n`, `code` list, `{from, to}`); `report.ts` accepts those too |
| `--code-root DIR` | Root for `@code` paths. Default: the nearest ancestor folder with `.git`, else the spec's folder |
| `--timeout SEC` | Stop TLC after this long (default 600 s, 10 minutes; `0` = no limit; a matrix run may set `timeoutSec`). The run ends as "timed out (no verdict)" and says which limit stopped it: a failed check, never a pass. While TLC runs, `tlc.ts` prints each `Progress(...)` line TLC emits (a run shorter than 10 s prints none) and a "still running" line after 30 s of silence |
| `--trace` | In a matrix, also print the trace of runs that were expected to fail and did (normally only mismatches print one) |
| `--from-log FILE` | Explain a saved or pasted TLC output without running TLC (workflow "explain a trace"). Add `--spec Spec.tla` so the `@code` tags resolve; no other positional argument is needed |
| `-- ...` | Everything after `--` goes to TLC unchanged, e.g. `-- -simulate num=200000 -depth 60` |

TLC runs with the spec's folder as its working directory, so relative file names read by a spec (the `TRACE`
log of `trace-validation.md`) resolve there, not in your shell's folder. A `@code` whose file or line range
does not exist prints a `WARN` line and does not fail the run (the sample patterns use made-up paths, so they
warn).

### Exit codes (every script of this skill)

| Code | Meaning |
|---|---|
| 0 | Pass: no counterexample within the stated bounds (for `--matrix`: every run met its expectation). Also READY for `setup.ts` |
| 1 | A check ran and failed: invariant, action or temporal property violated, deadlock, a matrix entry that did not match, a stuck or timed-out run, or a run TLC passed while warning that the check is unsound |
| 2 | Usage error or a bad input file (spec or config that does not parse or load, matrix or log not found or not parseable; a SANY parse or semantic error) |
| 3 | UNAVAILABLE: TLC or Java could not be prepared (offline, download refused, unsupported platform). Report it as **not checked**, never as a pass |

`tlc.ts` does not return TLC's own exit codes (those are in "Raw TLC exit codes" below); it prints which kind of
failure happened.

### `@code` tags: tying steps to code

A comment line directly above an action definition, or inside its body, links the action to the code it stands
for:

```tla
\* @code src/worker.ts:40-58 UPDATE jobs SET owner=$1 ... (optional note)
Claim(w) == ...
```

The path is relative to the code root (the nearest ancestor with `.git`, else `--code-root`); lines are
optional. Several tags above one action are allowed. One TLA+ atomic step must be one atomic step in the code.
Traces from `tlc.ts` show the location next to each action; `verify-all.ts` checks that every tag still
points into an existing file and line range (`ci-and-drift.md`). Leave environment actions (`Expire`, `Crash`,
`Drop`) untagged: they are not code.

### Matrix file

A matrix lists several runs of one spec: the passing model, the bug toggle that must fail, the sanity check that
must fail, larger bounds. It is the unit a manifest points at (`persist.md`).

```json
{
	"runs": [
		{ "name": "fast", "config": "MC.cfg", "expect": "pass" },
		{ "name": "3w", "config": "MC.cfg", "constants": { "Workers": "{w1, w2, w3}" }, "workers": 4 },
		{ "name": "bug", "config": "MC_bug.cfg", "expect": "violation", "property": "SingleCommit" }
	]
}
```

| Key | Meaning |
|---|---|
| `name` | Label in the output |
| `config` | Config file, relative to the spec's folder |
| `expect` | `pass` (default), `violation` (any), `invariant`, `deadlock`, `temporal`, `action` |
| `property` | Optional name of the property that must be the one reported as violated |
| `constants` | Optional overrides of cfg `CONSTANT` lines, written to a temporary cfg (the original is untouched) |
| `deadlock` | `false` adds `-deadlock` (no deadlock check) for this run |
| `workers`, `args`, `timeoutSec` | Worker count, extra TLC arguments (array of strings) and a time limit for this run |
| `tier` | `"fast"` (default) or `"deep"`. `verify-all.ts --tier fast` skips a run marked `"deep"` inside a fast model (it prints "N deep runs skipped"); `--tier deep` and `--only` run it. `tlc.ts` itself ignores the field |

Why bug and sanity configs belong in the matrix: the run is "green" only when the buggy model **does** fail on
the right property. A spec whose bug config stops failing has lost its power, and the matrix exit code says so.
Use `temporal` for liveness violations and `action` for action-property violations (`[][...]_vars`); `tlc.ts`
reports the two separately, so the wrong one does not match. `violation` accepts any of invariant, deadlock,
temporal, action or `Assert`.

Run it: `bun <skill-dir>/scripts/tlc.ts Spec.tla --matrix matrix.json`.

## Raw TLC and SANY

Checked against tla2tools release 1.8.0 (TLC2 Version 2026.10.28). Everything below is what `tlc.ts` runs; use it directly only when you
need a flag the wrapper lacks (then prefer `-- extra args`) or when you read someone else's log.

```
CP=tla2tools.jar:CommunityModules-deps.jar          # on Windows use ; as the separator
java -cp $CP tla2sany.SANY -error-codes Spec.tla     # parse + level-check (exit 0 ok, 4 semantic error, 255 parse error; without -error-codes a semantic error still exits 0)
java -cp $CP pcal.trans -nocfg Spec.tla              # PlusCal -> TLA+ (in place, between BEGIN/END TRANSLATION)
java -XX:+UseParallelGC -cp $CP tlc2.TLC -workers auto -config MC.cfg Spec.tla
java -cp $CP tlc2.REPL                               # evaluate expressions interactively
```

### TLC flags that matter

| Flag | Effect |
|---|---|
| `-workers N\|auto` | worker threads (default 1) |
| `-config F` | config file (default `<Spec>.cfg`) |
| `-deadlock` | **disable** the deadlock check (prefer an explicit `Terminated` action) |
| `-dumpTrace json F` | write the counterexample as JSON: `counterexample.action[i] = [[n, state], {name, location, context, parameters}, [n+1, state]]`. Other formats: `tla`, `tlc`, `tlcplain`, `tlcTESpec`, `tlcaction`, `dot` |
| `-difftrace` | print only the changed variables per state |
| `-simulate [num=N,file=F,stats=full]` | random behaviors instead of BFS; pair with `-depth N` (default 100) and `-seed` |
| `-coverage M` | per-action coverage every M minutes, printed as `<Action line ...>: distinct:generated`; an action with 0 generated is never enabled (0 distinct alone is not: it may only lead back to states already seen) |
| `-continue` | keep going after a violation (collect several) |
| `-dfid N` | depth-first iterative deepening |
| `-fpmem F`, `-metadir D`, `-checkpoint M`, `-recover D` | memory, state dir, checkpointing |
| `-lncheck final` | check liveness once at the end (faster on big graphs) |
| `-maxSetSize N` | enlarge the enumerable set limit (default 1e6) |
| `-postCondition Mod!Op` | same as the `POSTCONDITION` keyword |
| `-inv expr` | ad-hoc invariant without editing the config |
| `-noGenerateSpecTE`, `-teSpecOutDir D` | control the generated trace-explorer spec (`tlc.ts` turns it off and uses its own metadir) |

TLC writes a `states/` folder next to the spec unless `-metadir` points elsewhere, and a `*_TTrace_*` spec after a
violation. `tlc.ts` avoids both. If you run TLC by hand, add them to `.gitignore`.

### Config (`.cfg`) keywords

`SPECIFICATION Spec` or `INIT Init` + `NEXT Next` · `CONSTANT(S) X = {a, b}` (bare identifiers
are model values; `"s"` strings and numbers are allowed) · `INVARIANT(S)` · `PROPERTY/PROPERTIES`
(temporal and action properties) · `SYMMETRY Perms` (with `Perms == Permutations(S)`, `EXTENDS TLC`;
safety only) · `CONSTRAINT` (state constraint that prunes exploration; report it) · `ACTION_CONSTRAINT` ·
`VIEW` (fingerprint projection) · `ALIAS` (a record of derived values shown in traces) · `POSTCONDITION` ·
`CHECK_DEADLOCK FALSE`.

### Raw TLC exit codes

The first five are the ones to rely on. The rest were observed with tla2tools release 1.8.0 on small throwaway specs
(an `Assert` that fails, an action that leaves a variable unspecified, a type error, a syntax error, a missing
config, an unknown `SPECIFICATION` name).

| Code | Meaning |
|---|---|
| 0 | no violation within bounds |
| 10 | ASSUME false, or POSTCONDITION false (for example, a trace rejected in trace validation) |
| 11 | deadlock |
| 12 | invariant violated |
| 13 | temporal property **or action property** violated |
| 14 | failed `Assert` |
| 75 | evaluation error, including "Successor state is not completely specified" (a missing `UNCHANGED`) and operand type errors |
| 150 | the spec does not parse |
| 151 | config error (file not found, unknown name) |
| 255 | SANY (not TLC): parse error |
| 4 | SANY with `-error-codes` (not TLC): semantic error |

Treat any other nonzero code as "the check did not run to a verdict", never as a pass.

### Performance checklist

1. Use the smallest constants that still show the behavior (2 actors).
2. Replace large sets with small symbolic ones; avoid `SUBSET` of anything bigger than about 6 elements.
3. Use `SYMMETRY` over interchangeable model values (safety configs only).
4. Use a `VIEW` that drops history or auxiliary variables from fingerprints.
5. Merge steps that cannot interleave meaningfully. Only merge after arguing why, and record it in CORRESPONDENCE.md.
6. Split into several scenario configs (several matrix entries) rather than one giant one.
7. Switch to `-- -simulate num=200000 -depth 60` for deep bugs in big models; a simulation that finds nothing is
   not a proof. For bounded symbolic checks see "Optional external tools" in `choosing-tools.md`.
8. Give the JVM memory through the environment: `JAVA_TOOL_OPTIONS=-Xmx8g bun <skill-dir>/scripts/tlc.ts ...`. Putting `-Xmx8g` after `--` fails with "unrecognized option", because everything after `--` is a TLC argument, not a JVM one. `tlc.ts` already sets `-XX:+UseParallelGC`.

### ALIAS for readable traces

```tla
Alias == [ db |-> db, cache |-> cache, stale |-> (cache # None /\ cache # db),
           inFlight |-> {r \in Readers : rpc[r] = "fill"} ]
```
Add `ALIAS Alias` to the config; each trace state then shows these fields instead of the raw variables.
