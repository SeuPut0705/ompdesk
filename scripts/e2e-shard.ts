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
 * (LPT), by an estimated cost per file: its tests that are not annotated skipped,
 * a `captures:` test counting a tenth, at `TEST_SECONDS` each (the hosted runner's mean test time), but never below
 * the measured file times in `MEASURED_SECONDS`: each file's summed test time on the hosted macOS runner with one
 * worker, from nightly run 39749113072 (22 Oct 2026). Measured on a 15-core Mac with 4 workers instead, deep-audit read
 * 184 s and took 672 s on the runner, so its shard ran past the 30-minute step limit while the others finished in 10
 * to 15. The costs only steer the split; every file lands in exactly one shard, so a wrong estimate costs wall time,
 * never coverage.
 */
import { spawnSync } from "node:child_process";

const TEST_SECONDS = 8;
const CAPTURE_WEIGHT = 0.1;
/** Specs of 15 s or more, measured on the runner (seconds of test time, one worker). */
const MEASURED_SECONDS: Readonly<Record<string, number>> = {
	"deep-audit.e2e.ts": 672,
	"responsive-smoke.e2e.ts": 187,
	"remote-resume.e2e.ts": 160,
	"daily-flows.e2e.ts": 138,
	"mobile-shell.e2e.ts": 110,
	"composer-queue-view.e2e.ts": 99,
	"mobile-composer.e2e.ts": 94,
	"a11y-audit.e2e.ts": 90,
	"no-loading.e2e.ts": 83,
	"agent-control-across.e2e.ts": 78,
	"mobile-remote-session.e2e.ts": 72,
	"composer-flows.e2e.ts": 68,
	"agent-studio.e2e.ts": 66,
	"mobile-pages.e2e.ts": 59,
	"ai-memory.e2e.ts": 55,
	"phone-run-sheet.e2e.ts": 55,
	"autopilot-cycles.e2e.ts": 49,
	"auto-follow.e2e.ts": 49,
	"mobile-attach.e2e.ts": 49,
	"autopilot-restart.e2e.ts": 46,
	"remote-flows.e2e.ts": 42,
	"autopilot-ship.e2e.ts": 38,
	"mobile-enter.e2e.ts": 33,
	"desktop.e2e.ts": 32,
	"remote-devices.e2e.ts": 30,
	"stats-late-server.e2e.ts": 28,
	"agent-control-autopilot.e2e.ts": 27,
	"remote-stream.e2e.ts": 27,
	"auto-mode.e2e.ts": 26,
	"row-glow-harness.e2e.ts": 25,
	"device-order.e2e.ts": 25,
	"interrupted-resume.e2e.ts": 25,
	"real-core.e2e.ts": 24,
	"preview-tools.e2e.ts": 23,
	"agent-app-control.e2e.ts": 23,
	"family-fold.e2e.ts": 22,
	"desktop-tabs.e2e.ts": 22,
	"agent-control.e2e.ts": 21,
	"agent-mail.e2e.ts": 20,
	"mobile-web.e2e.ts": 20,
	"figures.e2e.ts": 20,
	"scheduled-retry.e2e.ts": 18,
	"app-auto-update.e2e.ts": 18,
	"composer-live.e2e.ts": 18,
	"github-sign-in.e2e.ts": 17,
	"device-prefs.e2e.ts": 17,
	"mobile-panels.e2e.ts": 17,
	"live-work.e2e.ts": 17,
	"first-run-no-omp.e2e.ts": 17,
	"mobile-suggestions.e2e.ts": 16,
	"files-tools.e2e.ts": 16,
	"mobile-autopilot-rows.e2e.ts": 15,
	"pwa-install.e2e.ts": 15,
	"pstack.e2e.ts": 15,
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
