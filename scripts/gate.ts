/**
 * The local release gate (AGENTS.md › Change workflow) in one command, inside
 * the machine-wide build lock (`scripts/build-lock.ts`):
 *
 *   bun run gate
 *
 * 1. Side by side: typecheck, biome, the surface policy, the full vitest suite
 *    and the app build. None of them reads what another writes, so their order
 *    never changes a result.
 * 2. Only when all of them passed: the full Playwright suite against that build.
 *
 * A failed step prints its output and the gate exits non-zero; the side-by-side
 * steps always all finish, so one run reports every failing check.
 */
import { acquireLock, type RunResult, run } from "./build-lock";

const CHECKS: ReadonlyArray<readonly [string, string[]]> = [
	["types", ["bun", "run", "check:types"]],
	["biome", ["bunx", "biome", "check", "src", "e2e", "resources", "scripts"]],
	["surfaces", ["node", "scripts/lint-surfaces.mjs"]],
	["vitest", ["bunx", "vitest", "run"]],
	["build", ["bun", "run", "build"]],
];
const E2E = ["bunx", "playwright", "test"];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

await acquireLock();
const started = performance.now();
console.log(`[gate] ${CHECKS.map(([name]) => name).join(", ")} side by side`);
const results = await Promise.all(
	CHECKS.map(async ([name, command]): Promise<readonly [string, RunResult]> => {
		const result = await run(command, { capture: true });
		if (result.code !== 0) console.log(`\n[gate] ✗ ${name} (exit ${result.code})\n${result.output.trimEnd()}\n`);
		console.log(`[gate] ${result.code === 0 ? "✓" : "✗"} ${name} ${seconds(result.ms)}`);
		return [name, result];
	}),
);
const failed = results.filter(([, result]) => result.code !== 0).map(([name]) => name);
if (failed.length > 0) {
	console.log(`[gate] FAILED: ${failed.join(", ")} after ${seconds(performance.now() - started)}; Playwright not run`);
	process.exit(1);
}
console.log(`[gate] checks and build passed in ${seconds(performance.now() - started)}; full Playwright suite`);
const e2e = await run(E2E);
console.log(
	`[gate] ${e2e.code === 0 ? "PASSED" : "FAILED: playwright"} — playwright ${seconds(e2e.ms)}, total ${seconds(performance.now() - started)}`,
);
process.exit(e2e.code === 0 ? 0 : 1);
