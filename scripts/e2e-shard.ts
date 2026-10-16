/**
 * Prints the e2e spec files of one shard of the full Playwright suite, for
 * release.yml's and e2e-shards.yml's matrix:
 *
 *   bunx playwright test $(bun scripts/e2e-shard.ts 2/4)
 *
 * Why not `playwright test --shard=2/4`: it cuts the ordered list of tests into
 * equal runs of *listed* tests, and the suite lists ~700 tests of which ~300
 * run. Specs that skip inside the test (the `captures:` variants of the
 * `mobile-*` specs, every `OMP_GUI_*=<dir>` audit) still count, so one shard
 * would get a run of near-free tests and another the real work. Here whole files
 * are dealt, heaviest first, to the lightest shard (LPT), by an estimated cost
 * per file: its tests that are not annotated skipped, a `captures:` test counting
 * a tenth, at `TEST_SECONDS` each, but never below the measured file times in
 * `MEASURED_SECONDS` (AGENTS.md; 16 Oct 2026, 4 workers on a 15-core Mac). The
 * costs only steer the split; every file lands in exactly one shard, so a wrong
 * estimate costs wall time, never coverage.
 */
import { spawnSync } from "node:child_process";

const TEST_SECONDS = 4;
const CAPTURE_WEIGHT = 0.1;
/** Slowest specs, measured (seconds of wall time with the suite running). */
const MEASURED_SECONDS: Readonly<Record<string, number>> = {
	"deep-audit.e2e.ts": 184,
	"remote-resume.e2e.ts": 95,
	"a11y-audit.e2e.ts": 80,
	"remote-flows.e2e.ts": 64,
	"usage-resume.e2e.ts": 54,
	"next-prompt.e2e.ts": 54,
};

interface JsonSpec {
	title: string;
	tests: { annotations?: { type: string }[] }[];
}
interface JsonSuite {
	file?: string;
	suites?: JsonSuite[];
	specs?: JsonSpec[];
}
function listSuites(): JsonSuite[] {
	const result = spawnSync("bunx", ["playwright", "test", "--list", "--reporter=json"], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (result.status !== 0) throw new Error(`playwright --list failed (exit ${result.status})`);
	// Playwright's own JSON reporter output (the documented list report shape).
	const report: { suites: JsonSuite[] } = JSON.parse(result.stdout);
	return report.suites;
}

function cost(suite: JsonSuite): number {
	let seconds = 0;
	for (const spec of suite.specs ?? []) {
		for (const test of spec.tests) {
			if (test.annotations?.some(annotation => annotation.type === "skip")) continue;
			seconds += TEST_SECONDS * (/^captures?\b/i.test(spec.title) ? CAPTURE_WEIGHT : 1);
		}
	}
	for (const child of suite.suites ?? []) seconds += cost(child);
	return seconds;
}

/** Deals `files` (heaviest first, ties by name) to the currently lightest of `total` shards. */
export function deal(files: ReadonlyArray<{ file: string; seconds: number }>, total: number): string[][] {
	const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] as string[] }));
	const ordered = [...files].sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
	for (const { file, seconds } of ordered) {
		const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
		lightest.seconds += seconds;
		lightest.files.push(file);
	}
	return shards.map(shard => shard.files.sort());
}

if (import.meta.main) {
	const match = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
	const current = Number(match?.[1]);
	const total = Number(match?.[2]);
	if (!match || current < 1 || current > total) {
		console.error("usage: bun scripts/e2e-shard.ts <shard>/<total>   (e.g. 2/4)");
		process.exit(2);
	}
	const files = listSuites()
		.filter(suite => suite.file)
		.map(suite => {
			const file = suite.file as string;
			const base = file.split("/").pop() as string;
			return { file: `e2e/${file}`, seconds: Math.max(cost(suite), MEASURED_SECONDS[base] ?? 0) };
		});
	const shards = deal(files, total);
	const mine = shards[current - 1] ?? [];
	if (mine.length === 0) {
		console.error(`shard ${current}/${total} has no spec files (${files.length} in all)`);
		process.exit(1);
	}
	const seconds = new Map(files.map(entry => [entry.file, entry.seconds]));
	for (const [index, shard] of shards.entries()) {
		const sum = shard.reduce((acc, file) => acc + (seconds.get(file) ?? 0), 0);
		console.error(`[e2e-shard] ${index + 1}/${total}: ${shard.length} files, ~${Math.round(sum)} s estimated`);
	}
	console.log(mine.join(" "));
}
