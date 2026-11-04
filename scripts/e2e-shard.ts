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
 * worker, from nightly run 41817431850 (4 Nov 2026; `responsive-smoke` from run 39749113072, its shard timed out
 * inside it). Measured on a 15-core Mac with 4 workers instead, deep-audit read 184 s and took 672 s on the runner.
 * The costs only steer the split; every file lands in exactly one shard, so a wrong estimate costs wall time, never
 * coverage, except past the shard's `--global-timeout` (25 minutes): the tests left then do not run at all (nightly
 * 41817431850, shard 3: 36 tests did not run). Four shards of that suite sum to ~1430 s each, so it runs in five.
 */
import { spawnSync } from "node:child_process";

const TEST_SECONDS = 8;
const CAPTURE_WEIGHT = 0.1;
/** Specs of 15 s or more, measured on the runner (seconds of test time, one worker). */
const MEASURED_SECONDS: Readonly<Record<string, number>> = {
	"deep-audit.e2e.ts": 596,
	"remote-resume.e2e.ts": 212,
	"mobile-composer.e2e.ts": 191,
	"responsive-smoke.e2e.ts": 187,
	"mobile-shell.e2e.ts": 161,
	"phone-reconnect.e2e.ts": 156,
	"retry-saga-card.e2e.ts": 148,
	"phone-offline-send.e2e.ts": 144,
	"agent-control-across.e2e.ts": 124,
	"no-loading.e2e.ts": 112,
	"mobile-attach.e2e.ts": 109,
	"web-no-reload.e2e.ts": 102,
	"daily-flows.e2e.ts": 100,
	"remote-offline-send.e2e.ts": 78,
	"composer-flows.e2e.ts": 76,
	"composer-queue-view.e2e.ts": 70,
	"bot.e2e.ts": 65,
	"mobile-pages.e2e.ts": 64,
	"mobile-remote-session.e2e.ts": 63,
	"mobile-enter.e2e.ts": 57,
	"autopilot-cycles.e2e.ts": 57,
	"phone-run-sheet.e2e.ts": 55,
	"autopilot-ship.e2e.ts": 53,
	"real-core.e2e.ts": 52,
	"a11y-audit.e2e.ts": 52,
	"remote-flows.e2e.ts": 46,
	"interrupted-resume.e2e.ts": 46,
	"ai-memory.e2e.ts": 45,
	"auto-follow.e2e.ts": 44,
	"send-outbox-remote.e2e.ts": 42,
	"agent-close-web.e2e.ts": 41,
	"fold-summary.e2e.ts": 40,
	"app-auto-update.e2e.ts": 40,
	"app-auto-update-waiting.e2e.ts": 40,
	"row-glow-harness.e2e.ts": 39,
	"preview-agent-remote.e2e.ts": 38,
	"autopilot-restart.e2e.ts": 38,
	"model-wait-together.e2e.ts": 37,
	"device-order.e2e.ts": 36,
	"desktop.e2e.ts": 35,
	"auto-mode.e2e.ts": 34,
	"mobile-suggestions.e2e.ts": 32,
	"remote-stream.e2e.ts": 31,
	"mobile-no-zoom.e2e.ts": 29,
	"windows-caption.e2e.ts": 28,
	"stats-late-server.e2e.ts": 28,
	"agent-studio.e2e.ts": 28,
	"relaunch-child-ids.e2e.ts": 27,
	"bot-identity.e2e.ts": 27,
	"remote-devices.e2e.ts": 26,
	"bot-rules.e2e.ts": 26,
	"bot-rotation.e2e.ts": 26,
	"agent-mail.e2e.ts": 26,
	"mobile-autopilot-rows.e2e.ts": 25,
	"composer-live.e2e.ts": 25,
	"session-menu-captures.e2e.ts": 23,
	"scheduled-retry.e2e.ts": 23,
	"mobile-panels.e2e.ts": 23,
	"bot-identity-remote.e2e.ts": 23,
	"agent-control.e2e.ts": 23,
	"live-work.e2e.ts": 22,
	"mobile-web.e2e.ts": 21,
	"agent-app-control.e2e.ts": 21,
	"sidebar-working-arc.e2e.ts": 20,
	"row-glow.e2e.ts": 20,
	"panel-views.e2e.ts": 20,
	"extension-update.e2e.ts": 20,
	"next-prompt.e2e.ts": 19,
	"memory-sync.e2e.ts": 19,
	"memory-admission-relaunch.e2e.ts": 19,
	"device-prefs.e2e.ts": 19,
	"bot-device.e2e.ts": 19,
	"work-board.e2e.ts": 18,
	"memory-page.e2e.ts": 18,
	"github-sign-in.e2e.ts": 18,
	"oauth-login.e2e.ts": 17,
	"family-fold.e2e.ts": 17,
	"sessions-schedules.e2e.ts": 16,
	"mobile-notification-open.e2e.ts": 16,
	"github-cli-install.e2e.ts": 16,
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
