/**
 * Wait on a GitHub Actions run and stop at the first failed job, not at the end of the run.
 *
 *   bun scripts/watch-run.ts <run-id>
 *   bun scripts/watch-run.ts --release [--sha <commit>]   newest release.yml run on main
 *
 * `gh run watch --exit-status` returns only when the whole run ends, so a 90 s lint failure cost the
 * ~9 minutes the slowest job needs before anyone could start the fix. This polls
 * `gh run view --json jobs,status,conclusion` every 15 s (`--interval <s>`), prints one line per job
 * state change, and on the first job that concludes `failure` or `timed_out` prints that job, its failed
 * step and the first error lines of its log, then exits 1 while the other jobs still run. A run that
 * ends in success exits 0; one that ends otherwise (cancelled) exits 1.
 *
 * Run it as a background job (bash `async: true`, then `wait`), never as a foreground poll.
 * `--release` alone takes the newest run, which right after a push can still be the previous release's:
 * pass `--sha` (the pushed commit) and it waits for that commit's run to show.
 */
import { spawnSync } from "node:child_process";

const DEFAULT_INTERVAL_S = 15;
const LOOKUP_ATTEMPTS = 20;
const LOOKUP_INTERVAL_MS = 3_000;
const ERROR_LINES = 15;
const TRANSIENT_ATTEMPTS = 5;

export interface WatchedJob {
	databaseId: number;
	name: string;
	status: string;
	conclusion: string;
	steps: { name: string; conclusion: string }[];
}

interface RunView {
	status: string;
	conclusion: string;
	jobs: WatchedJob[];
}

/** What a job shows as: its conclusion once finished, its status before. */
export function jobState(job: Pick<WatchedJob, "status" | "conclusion">): string {
	return job.status === "completed" && job.conclusion ? job.conclusion : job.status;
}

/** One `name: state` line per job whose state differs from the last poll (every job on the first). */
export function changedLines(previous: ReadonlyMap<string, string>, jobs: readonly WatchedJob[]): string[] {
	const lines: string[] = [];
	for (const job of jobs) {
		const state = jobState(job);
		if (previous.get(job.name) !== state) lines.push(`${job.name}: ${state}`);
	}
	return lines;
}

const ERROR_LINE =
	/(^| )(FAIL|✗|×|error TS[0-9]+|error:|Error:|AssertionError|TypeError|ReferenceError|Timed out|Timeout|Process completed with exit code|##\[error\])|^(Error|error)|^\S+:\d+:\d+ \S+/;

/** The first error lines of a job log: what `scripts/ci-failure.sh` greps, plus `file:line:col rule` diagnostics (biome, tsc). */
export function errorLines(log: string, limit = ERROR_LINES): string[] {
	const clean = log.split("\n").map(line =>
		line
			.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
			.replace(/^\S*Z /, "")
			.trimEnd(),
	);
	const hits = clean.filter(line => ERROR_LINE.test(line));
	return (hits.length > 0 ? hits : clean.filter(line => line.trim() !== "").slice(-limit)).slice(0, limit);
}

function gh(args: string[]): { ok: boolean; out: string; err: string } {
	const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { ok: result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() };
}

function usage(message: string): never {
	console.error(
		`watch-run: ${message}\nusage: bun scripts/watch-run.ts <run-id> | --release [--sha <commit>] [--interval <s>]`,
	);
	process.exit(2);
}

function say(line: string): void {
	console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);
}

async function findReleaseRun(sha: string | undefined): Promise<number> {
	for (let attempt = 0; attempt < LOOKUP_ATTEMPTS; attempt++) {
		const listed = gh([
			"run",
			"list",
			"--workflow",
			"release.yml",
			"--branch",
			"main",
			"--limit",
			"10",
			"--json",
			"databaseId,headSha",
		]);
		if (listed.ok) {
			const rows = JSON.parse(listed.out) as { databaseId: number; headSha: string }[];
			const row = sha ? rows.find(r => r.headSha.startsWith(sha)) : rows[0];
			if (row) return row.databaseId;
		}
		if (!sha) break;
		await Bun.sleep(LOOKUP_INTERVAL_MS);
	}
	console.error(`watch-run: no release.yml run on main${sha ? ` for ${sha}` : ""}`);
	process.exit(2);
}

function viewRun(id: number): RunView {
	let last = "";
	for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt++) {
		const viewed = gh(["run", "view", String(id), "--json", "status,conclusion,jobs"]);
		if (viewed.ok) return JSON.parse(viewed.out) as RunView;
		last = viewed.err;
		// A bad id never recovers; a dropped connection does.
		if (/could not resolve|not found|HTTP 404/i.test(last)) break;
		Bun.sleepSync(2_000);
	}
	console.error(`watch-run: gh run view ${id}: ${last}`);
	process.exit(2);
}

function failedJobLog(jobId: number): { log: string } | { error: string } {
	// The log of a finished job is there while the run still goes (`gh run view --log-failed` refuses until
	// the whole run ends). gh 2.97+ refuses a body holding terminal escapes without --allow-escape-sequences,
	// which older gh does not know.
	const path = `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`;
	const first = gh(["api", "--allow-escape-sequences", path]);
	const fetched = first.ok ? first : gh(["api", path]);
	return fetched.ok ? { log: fetched.out } : { error: fetched.err || fetched.out.trim() };
}

function reportFailure(runId: number, job: WatchedJob): void {
	const failedSteps = job.steps.filter(step => step.conclusion === "failure").map(step => step.name);
	say(`FAILED ${job.name} (${job.conclusion}) — run ${runId}`);
	if (failedSteps.length > 0) console.log(`  failed step: ${failedSteps.join(", ")}`);
	const fetched = failedJobLog(job.databaseId);
	if ("error" in fetched) console.log(`  log unavailable: ${fetched.error}`);
	else for (const line of errorLines(fetched.log)) console.log(`  ${line}`);
	console.log(`  full log: gh run view ${runId} --log-failed --job ${job.databaseId}`);
}

async function main(argv: string[]): Promise<number> {
	let runId: number | undefined;
	let release = false;
	let sha: string | undefined;
	let intervalS = DEFAULT_INTERVAL_S;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--release") release = true;
		else if (arg === "--sha") sha = argv[++i] ?? usage("--sha needs a commit");
		else if (arg === "--interval") intervalS = Number(argv[++i]);
		else if (/^\d+$/.test(arg)) runId = Number(arg);
		else usage(`unknown argument ${arg}`);
	}
	if (!Number.isFinite(intervalS) || intervalS <= 0) usage("--interval needs seconds above 0");
	if (sha && !release) usage("--sha goes with --release");
	if (release === (runId !== undefined)) usage("give a run id or --release, not both or neither");
	const id = runId ?? (await findReleaseRun(sha));
	say(`watching run ${id}`);

	const seen = new Map<string, string>();
	for (;;) {
		const run = viewRun(id);
		for (const line of changedLines(seen, run.jobs)) say(line);
		for (const job of run.jobs) seen.set(job.name, jobState(job));
		const failed = run.jobs.find(job => job.conclusion === "failure" || job.conclusion === "timed_out");
		if (failed) {
			reportFailure(id, failed);
			return 1;
		}
		if (run.status === "completed") {
			say(`run ${id}: ${run.conclusion}`);
			return run.conclusion === "success" ? 0 : 1;
		}
		await Bun.sleep(intervalS * 1_000);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
