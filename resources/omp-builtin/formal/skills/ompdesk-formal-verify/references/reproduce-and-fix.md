# Counterexample, failing test, fix

> Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources.

A counterexample is a claim about the code. Reproduce it before believing it. The best published pipeline (Specula, 2026) reproduced 98.5% of reported bugs with timing-controlled tests and had zero false positives because it required reproduction ([evidence.md](evidence.md)). This file is W1.6 and W1.7 in detail.

## 1. Minimize the trace

- TLC's default breadth-first search returns a shortest trace, and `tlc.ts` runs one worker unless you pass `--workers` (with several workers the trace can be longer and differs between runs). With simulation or depth-first search, re-run breadth-first at the depth where it failed, or shrink the constants (fewer workers or keys).
- `tlc.ts` already drops the variables that did not change. Drop stuttering and irrelevant actors as well: which steps change variables the violated property reads?
- Save the structured trace for the findings file: `bun <skill-dir>/scripts/tlc.ts <spec> --config <cfg> --json formal/<concern>/evidence/<name>.json` (`<skill-dir>` is the folder of SKILL.md). Its `trace` is already in the shape of a finding's `trace[]` (`step`, `action`, `code`, `changed` as `"from -> to"`, `violation`), so paste it into the finding as it is. When the model's action takes a tuple through `\E x \in set : A(x)`, TLC may name the wrapper, and the `code` column then shows the tagged actions it calls: if a row's `code` is empty or looks wrong, pass a scalar to the action or tag the wrapper.
- Write the story in domain terms, one line per step, with the `@code` location of each step.

## 2. Force the interleaving in real code

Pick the lightest control that makes the schedule deterministic:

| Runtime | Technique |
|---|---|
| JS/TS (Node, Bun) | Deferred promises (`let release; const gate = new Promise(r => release = r)`) inside fakes; fake timers (`vi.useFakeTimers()`, `jest.useFakeTimers()`, `setSystemTime` in Bun's test runner) |
| Python asyncio | `asyncio.Event` gates inside mocks or fakes at the modeled `await` points; run with a single loop; `pytest-asyncio` |
| Python threads | `threading.Barrier` or `Event` injected via a hook or monkeypatch at the modeled step |
| Go | Channels as gates in fakes; the `-race` flag; `testing/synctest` (Go 1.24+) for deterministic time |
| Java/Kotlin | `CountDownLatch` or `CyclicBarrier` in fakes; `jcstress` for memory-model races; Lincheck for linearizability |
| Rust | `loom` for exhaustive thread interleavings of small tests; `tokio::time::pause()`; `shuttle` for randomized schedules |
| C/C++ | Barriers via test hooks; ThreadSanitizer; `rr` to record and replay |
| Distributed or services | Fault-injecting fakes (drop, duplicate, reorder, delay), controllable clocks, Testcontainers plus toxiproxy; one test per trace |
| DB transactions | Two connections, explicit `BEGIN`, statements interleaved by hand in the test at the chosen isolation level |

Put the gate at the exact boundary the model treats as the action boundary, which is where the `@code` tag points. If the code gives no seam there, add a minimal test hook, or use a fake of the dependency the code awaits on.

The test asserts the property the model violated (for example "cache equals DB at rest"), not incidental details. Name it after the finding: `test_F1_stale_cache_after_concurrent_invalidate`. Run it against the unchanged code and save the failing log in `formal/<concern>/evidence/` before you fix anything. It must fail on the property assertion, not on a missing function or a changed signature.

Honor the user's stated deliverable. If they said "no more unit tests", keep the reproduction in `formal/<concern>/repro/` as a script and do not touch their suite.

**A reproduction that stays in the suite until the fix lands makes CI red.** When the finding is reported and not fixed yet (the usual end of a verification-only task), mark the reproduction as an expected failure instead of leaving it failing: `it.fails("REPRODUCTION F1: ...", ...)` in vitest and Jest (`test.failing` in Jest 29+), `@pytest.mark.xfail(strict=True, reason="F1")` in pytest, `#[should_panic]` in Rust, `t.Skip("F1: reproduced in formal/<concern>/repro, remove when fixed")` in Go, which has no expected-failure marker. A strict marker turns red again the moment the code is fixed (the test passes unexpectedly), and that is the signal to flip it: remove `it.fails`, so the test passes as a regression test, and move the finding to `fixed`. Name the test after the finding (`REPRODUCTION ... F1`), keep a `control` test that does everything but the interleaving and passes, and record the marker in the finding's `reproduction.test` text. Say in the hand-off that the suite is green only because the reproductions are marked.

## 3. Verdicts

- **Confirmed:** the test fails on current code for the reason in the trace.
- **Suspected:** the test cannot be forced yet (no seam, needs infrastructure). Say why and give the trace. Do not count it as a bug in summaries.
- **Refuted:** the code prevents the trace (the model missed a guard or merged steps wrongly). Fix the model, update the `@code` tags and CORRESPONDENCE.md, and re-check. Record this as a model fix, not a finding.

## 4. Fix

1. Choose the fix by mechanism, not by symptom:
   - make a region atomic (lock, transaction, CAS),
   - add a version or fencing token,
   - reorder the write and the side effect (for example, record the dedup key before the side effect),
   - make the operation idempotent,
   - invalidate after the write, or delay-delete, or use versioned fills.
2. Mirror the fix in the model. Re-run all properties, not only the one that failed: `bun <skill-dir>/scripts/verify-all.ts formal --only <id>`. Fixes often break liveness (a lock added for safety can deadlock).
3. **Mutation-check.** Revert the fix in the model only and confirm the property fails again. Two ways: a `mutations.json` entry whose `search`/`replace` removes the fix and whose `breaks` names the property, run by `bun <skill-dir>/scripts/mutate.ts <spec> formal/<concern>/tla/mutations.json`; or a `BugFixEnabled = FALSE` config that sits in the matrix with `"expect": "violation"` ([mutations.md](mutations.md), [ci-and-drift.md](ci-and-drift.md)). This proves the property guards the bug.
4. The failing test now passes. Keep it (unless the deliverable was a script in `repro/`).
5. One finding per commit or PR when possible. The PR description gives the trace story, the property, the test and the model evidence.
6. Record the result in `formal/findings.json` (`reproduction.result_before_fix`, `fix.model_recheck`, `fix.mutation_check`) and re-render the report ([report.md](report.md)).
