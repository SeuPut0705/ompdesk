/**
 * Prints the e2e spec files of one shard of the full Playwright suite, for
 * e2e-shards.yml's matrix (called by ci.yml's manual `e2e=true` and by the nightly e2e workflow):
 *
 *   bunx playwright test $(bun scripts/e2e-shard.ts 2/4)
 *
 * Why not `playwright test --shard=2/4`: it cuts the ordered list of tests into
 * equal runs of *listed* tests, and the suite lists ~380 tests of which ~200
 * run. Specs that skip inside the test (the real-omp and `OMP_GUI_*=<dir>` audits)
 * still count, so one shard would get a run of near-free tests and another the
 * real work. Here whole files are dealt, heaviest first, to the lightest shard
 * (LPT), by an estimated cost per file: its tests that are not annotated skipped, a `captures:` test counting a tenth,
 * at `TEST_SECONDS` each, but never below the file's time in `scripts/e2e-shard-costs.json`: each spec file's summed
 * test time on the hosted macOS runner with one worker (nightly 41817431850, 4 Nov 2026, every shard; deep-audit read
 * 596 s there and 702 s in the next run, kept at 700; `responsive-smoke` from run 39749113072, whose shard timed out
 * inside it). Measured on a 15-core Mac with 4 workers instead, deep-audit read 184 s. Most tests of an unmeasured
 * file skip inside their body, so `TEST_SECONDS` is the mean of the rest, not of all tests: at 8 s the estimate was
 * ~1546 s a shard against 907 to 1494 s measured, and the split put the heaviest shard past the timeout.
 * The costs only steer the split; every file lands in exactly one shard, so a wrong estimate costs wall time, never
 * coverage, except past the shard's `--global-timeout` (25 minutes): the tests left then do not run at all (nightly
 * 41817431850, shard 3: 36 tests did not run; 41880669356, shard 1: one). Update the JSON from a nightly's per-file
 * times when specs are added or slow down.
 */
import { spawnSync } from "node:child_process";
import costs from "./e2e-shard-costs.json";
import { deal } from "./shard-deal";

const TEST_SECONDS = 3;
const CAPTURE_WEIGHT = 0.1;
/** Spec files of 8 s or more, measured on the runner (seconds of test time, one worker). */
const MEASURED_SECONDS: Readonly<Record<string, number>> = costs;

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
