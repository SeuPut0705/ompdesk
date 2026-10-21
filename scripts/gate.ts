/**
 * The local release gate (AGENTS.md › Change workflow) in one command. It holds
 * no lock as a whole (`scripts/build-lock.ts`); each phase takes the slot it
 * needs, and none of them counts against the 15-minute hold limit:
 *
 *   bun run gate
 *
 * 1. Side by side: typecheck, biome, the surface policy and the full vitest
 *    suite in one `vitest` slot, and the app build (`bun run build`, which
 *    reuses an out/ built from the same inputs; `scripts/build-cache.ts`) in
 *    the `build` slot. None of them reads what another writes, so their order
 *    never changes a result.
 * 2. Only when all of them passed: the full Playwright suite in a `playwright`
 *    slot, against an immutable snapshot of that build.
 *
 * A failed step prints its output and the gate exits non-zero; the side-by-side
 * steps always all finish, so one run reports every failing check.
 */
import { acquireLock, describeExit, type RunResult, run, runLocked } from "./build-lock";

const CHECKS: ReadonlyArray<readonly [string, string[]]> = [
	["types", ["bun", "run", "check:types"]],
	["biome", ["bunx", "biome", "check", "src", "e2e", "resources", "scripts"]],
	["surfaces", ["node", "scripts/lint-surfaces.mjs"]],
	["vitest", ["bunx", "vitest", "run"]],
];
const BUILD = ["bun", "run", "build"];
const E2E = ["bunx", "playwright", "test"];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

async function step(name: string, result: Promise<RunResult>): Promise<readonly [string, RunResult]> {
	const done = await result;
	if (done.code !== 0) console.log(`\n[gate] ✗ ${name} (${describeExit(done)})\n${done.output.trimEnd()}\n`);
	console.log(`[gate] ${done.code === 0 ? "✓" : "✗"} ${name} ${seconds(done.ms)}`);
	return [name, done];
}

/** The static checks and vitest side by side, in one vitest slot. */
async function checks(): Promise<Array<readonly [string, RunResult]>> {
	const held = await acquireLock(["bun", "run", "gate"], { kind: "vitest", via: "gate" });
	const results = await Promise.all(CHECKS.map(([name, command]) => step(name, run(command, { capture: true }))));
	held.release(results.some(([, result]) => result.code !== 0) ? 1 : 0);
	return results;
}

const started = performance.now();
console.log(`[gate] ${[...CHECKS.map(([name]) => name), "build"].join(", ")} side by side`);
const results = await Promise.all([
	checks(),
	step("build", runLocked("build", BUILD, { via: "gate", capture: true })).then(result => [result]),
]).then(parts => parts.flat());
const failed = results.filter(([, result]) => result.code !== 0).map(([name]) => name);
if (failed.length > 0) {
	console.log(`[gate] FAILED: ${failed.join(", ")} after ${seconds(performance.now() - started)}; Playwright not run`);
	process.exit(1);
}
console.log(`[gate] checks and build passed in ${seconds(performance.now() - started)}; full Playwright suite`);
const e2e = await runLocked("playwright", E2E, { via: "gate" });
console.log(
	`[gate] ${e2e.code === 0 ? "PASSED" : "FAILED: playwright"} — playwright ${seconds(e2e.ms)}, total ${seconds(performance.now() - started)}`,
);
process.exit(e2e.code === 0 ? 0 : 1);
