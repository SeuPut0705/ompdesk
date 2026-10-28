> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

# Trace validation: replay real executions through the spec

Model checking asks "can the *model* go wrong?" Trace validation asks "did the *code* do
something the model forbids?" It is the strongest defense against spec drift. In the
Specula ablation (2026, 5 systems, as cited by proof-skills) the full pipeline with runtime trace feedback
found 62 bugs; an agent that knew TLA+ but had no runtime feedback found 3.

Published use: Microsoft CCF (NSDI 2025, run in CI), etcd raft (`Traceetcdraft.tla`), and
the Cirstea/Kuppe/Loillier/Merz method (SEFM 2024). OmniLink (2026) extends it to
unmodified concurrent code by solving for an event order.

## Working example

`assets/patterns/CacheAside/TraceCacheAside.tla`, with `Trace.cfg` and two logs. `<skill-dir>` is the folder
that holds `SKILL.md`:

```
cd <skill-dir>/assets/patterns/CacheAside
TRACE=trace-ok.ndjson    bun <skill-dir>/scripts/tlc.ts TraceCacheAside.tla --config Trace.cfg   # accepted: PASS
TRACE=trace-drift.ndjson bun <skill-dir>/scripts/tlc.ts TraceCacheAside.tla --config Trace.cfg   # rejected: FAIL
```

On Windows set the variable first (`$env:TRACE = "trace-ok.ndjson"` in PowerShell, `set TRACE=...` in cmd). The
spec reads it through `IOEnv.TRACE` and falls back to `trace-ok.ndjson`.

`trace-drift.ndjson` logs a fill of value 1 after a miss that read 0. The spec says a fill
writes what the miss read, so TLC rejects it: the config's `POSTCONDITION TraceAccepted` is false
(TLC's own exit code 10, see `tlc-cli.md`). `tlc.ts` prints `FAIL`, names the postcondition and exits 1. The
spec's `Trace rejected at event N` line is in TLC's output, which `--out DIR` keeps in
`DIR/TraceCacheAside-Trace.log`. That is either a code bug or a spec that no longer matches the code. Both matter.

## Recipe

1. **Instrument the code.** At each point that corresponds to a spec action (the `@code` locations),
   emit one JSON line: `{"event": "<action>", "actor": "<id>", ...logged values}`.
   Log only the values the spec can check. Use the test or staging build, behind a flag.
2. **Order events.**
   - Single process: log order is fine.
   - Multi-threaded: take a global sequence number from an atomic counter at the linearization point.
   - Distributed: use a logical clock, or (as in etcd/CCF) log per node and merge by causal order.
3. **Write the trace spec:** `EXTENDS Spec, Json, IOUtils, TLC`, plus:
   - a variable `l` (the log index),
   - `TraceNext == l <= Len(Trace) /\ MatchEvent /\ l' = l + 1`,
   - `MatchEvent`, which pairs each event kind with its action *and* constrains primed
     variables to the logged values (`cache' = Ev.cache`),
   - `POSTCONDITION TraceAccepted`, which checks the search reached depth `Len(Trace) + 1`.

   Actor names in the log are JSON strings, so the trace config declares the actor set with strings
   (`Readers = {"r1", "r2"}` in `Trace.cfg`), unlike the model-value sets of `MC.cfg`.
4. **Partial logs.** When the code cannot log some variable, leave it unconstrained; TLC
   searches over the possibilities. When some actions are not logged at all, allow
   `TraceNext` to take unlogged spec actions between logged events (bounded by a small
   stutter budget).
5. **Run it in CI** on logs from integration tests and chaos tests (`ci-and-drift.md`). A rejected trace is a
   finding: reproduce it, then decide whether it is a code bug or spec drift (`reproduce-and-fix.md`).

`Json` and `IOUtils` come from `CommunityModules-deps.jar`. `tlc.ts` prepares it with the rest of the TLA+
tools and puts it on the classpath (`tlc-cli.md`, "Where the tools live").

## Model-based testing (the reverse direction)

Generate behaviors from the spec and drive the implementation with them:
- **TLC:** `bun <skill-dir>/scripts/tlc.ts Spec.tla --config MC.cfg -- -simulate num=1000 -depth 40`
  samples random behaviors. For machine-readable traces add TLC's `-dumpTrace json FILE` after the `--`, or
  generate a trace-explorer spec, and feed them to a small driver you write for the code.
- **Quint (optional external tool, not bundled):** `quint run --mbt --out-itf=trace.itf.json --n-traces=50 spec.qnt`,
  then a driver replays the ITF JSON against the code (`choosing-tools.md`).
- MongoDB's reported experience: tests generated from the spec reached 100% branch coverage of the
  modeled code, against 21% for handwritten tests and 92% for AFL.
