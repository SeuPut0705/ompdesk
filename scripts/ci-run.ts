/**
 * Dispatch a workflow on GitHub's runners through the check queue's front door.
 *
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true -f mac=true      the landing gate
 *   bun scripts/ci-run.ts e2e-nightly --ref omp/agent/foo -f specs="e2e/a.e2e.ts"
 *   bun scripts/ci-run.ts flake-probe --ref omp/agent/foo -f spec=e2e/a.e2e.ts -f os=macos
 *   options: --ref <branch> (default: the current branch), -f key=value (any number), --wait, --replace, --dry-run
 *
 * The workflows hold the queue themselves (queue-gate.yml: macOS only for main and MAC_REFS branches, a commit's second
 * identical run cancelled; the `mac-dispatch` lane: one holder and one waiting request for every dispatched macOS job),
 * so a raw `gh workflow run` is held to the same rules. This reads the queue first and says no before a run is made
 * that the workflow would refuse, or that would replace another session's waiting macOS request.
 *
 *  - Asking for macOS from a branch that is not in the repository variable MAC_REFS: refused (exit 2). Main sets the list
 *    (`gh variable set MAC_REFS --body "<branch> <branch>"`).
 *  - A branch without queue-gate.yml (cut before the gate landed) runs its own old workflow files, which hold nothing:
 *    refused (exit 2); merge main first.
 *  - The macOS lane has a holder and a waiting request: refused (exit 3) with their run ids, because a dispatch now would
 *    replace the waiting one. `--wait` watches the holder (one `gh run watch`, never a poll loop) and checks again;
 *    `--replace` dispatches anyway.
 *
 * Exit 0: dispatched, the run's URL printed (watch it once: `bun scripts/watch-run.ts <id>`).
 */
import { spawnSync } from "node:child_process";

/** The workflows a session dispatches, and what each asks of the macOS runners from its inputs. */
const WORKFLOWS: Record<string, (inputs: Record<string, string>) => boolean> = {
	ci: inputs => inputs.mac === "true" || inputs.e2e === "true",
	"e2e-nightly": () => true,
	"flake-probe": inputs => (inputs.os ?? "all") === "macos" || (inputs.os ?? "all") === "all",
	formal: () => false,
};
const LANE_WORKFLOWS = ["ci", "e2e-nightly", "flake-probe"];

export interface CiRunArgs {
	workflow: string;
	ref: string | undefined;
	inputs: Record<string, string>;
	wait: boolean;
	replace: boolean;
	dryRun: boolean;
}

export function parseArgs(argv: string[]): CiRunArgs | string {
	const [first, ...rest] = argv;
	const workflow = first?.replace(/\.yml$/, "") ?? "";
	if (!(workflow in WORKFLOWS)) return `workflow must be one of ${Object.keys(WORKFLOWS).join(", ")}`;
	const args: CiRunArgs = { workflow, ref: undefined, inputs: {}, wait: false, replace: false, dryRun: false };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--ref") args.ref = rest[++i];
		else if (arg === "--wait") args.wait = true;
		else if (arg === "--replace") args.replace = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "-f" || arg === "--field" || arg === "--raw-field") {
			const pair = rest[++i] ?? "";
			const eq = pair.indexOf("=");
			if (eq <= 0) return `${arg} needs key=value`;
			args.inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
		} else return `unknown argument ${arg}`;
	}
	return args;
}

/** Whether the dispatch asks for a macOS runner. */
export function asksForMac(workflow: string, inputs: Record<string, string>): boolean {
	return WORKFLOWS[workflow]?.(inputs) ?? false;
}

/** MAC_REFS is a list of exact branch names, separated by spaces or commas. */
export function refAllowed(ref: string, macRefs: string): boolean {
	return ref === "main" || macRefs.split(/[\s,]+/).includes(ref);
}

export interface LaneJob {
	status: string;
	labels: string[];
}

export interface LaneRun {
	id: number;
	workflow: string;
	branch: string;
	jobs: LaneJob[];
}

export interface Lane {
	/** Runs whose macOS jobs are queued or running: they hold the lane. */
	holders: LaneRun[];
	/** Runs with jobs held back by a concurrency group (GitHub's `pending`; such a job shows no runner label yet, observed on run 43443610875). */
	waiting: LaneRun[];
	/** Open macOS jobs of the dispatched runs. */
	openJobs: number;
}

const isMac = (job: LaneJob) => job.labels.some(label => label.startsWith("macos"));

/** The lane as the dispatched runs show it. A run of the same workflow and branch is the one a new dispatch replaces anyway. */
export function laneOf(runs: LaneRun[], replacing: { workflow: string; branch: string }): Lane {
	const lane: Lane = { holders: [], waiting: [], openJobs: 0 };
	for (const run of runs) {
		if (run.workflow === replacing.workflow && run.branch === replacing.branch) continue;
		const active = run.jobs.filter(job => isMac(job) && (job.status === "queued" || job.status === "in_progress"));
		const pending = run.jobs.filter(job => job.status === "pending");
		lane.openJobs += active.length;
		if (active.length > 0) lane.holders.push(run);
		else if (pending.length > 0) lane.waiting.push(run);
	}
	return lane;
}

export type Decision = { go: true; note?: string } | { go: false; code: 2 | 3; why: string };

export function decide(
	args: Pick<CiRunArgs, "workflow" | "inputs" | "replace">,
	ref: string,
	macRefs: string,
	lane: Lane,
): Decision {
	if (!asksForMac(args.workflow, args.inputs)) return { go: true };
	if (!refAllowed(ref, macRefs)) {
		return {
			go: false,
			code: 2,
			why: `${ref} is not in MAC_REFS (${macRefs || "empty"}): macOS runners are for main and release-bound branches. Ask Main to add it (gh variable set MAC_REFS --body "<branch> ..."), or drop mac=true / e2e=true.`,
		};
	}
	if (lane.holders.length > 0 && lane.waiting.length > 0 && !args.replace) {
		const ids = (runs: LaneRun[]) => runs.map(run => `${run.id} (${run.workflow}, ${run.branch})`).join(", ");
		return {
			go: false,
			code: 3,
			why: `the macOS lane has a holder, ${ids(lane.holders)}, and a waiting request, ${ids(lane.waiting)}; a dispatch now replaces the waiting one. Wait for the holder (--wait, or one gh run watch ${lane.holders[0]?.id}) and dispatch again.`,
		};
	}
	if (lane.holders.length > 0) {
		return {
			go: true,
			note: `the macOS lane is held by run ${lane.holders[0]?.id}; this run's macOS jobs wait for it (nothing queues on a runner meanwhile).`,
		};
	}
	return { go: true };
}

function gh(args: string[]): { ok: boolean; out: string; err: string } {
	const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return { ok: result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "").trim() };
}

function fail(message: string, code: number): never {
	console.error(`ci-run: ${message}`);
	process.exit(code);
}

function currentBranch(): string {
	const branch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout.trim();
	return branch || fail("not on a branch: pass --ref <branch>", 2);
}

function readLane(replacing: { workflow: string; branch: string }): Lane {
	const runs: LaneRun[] = [];
	for (const workflow of LANE_WORKFLOWS) {
		const listed = gh([
			"api",
			`repos/{owner}/{repo}/actions/workflows/${workflow}.yml/runs?event=workflow_dispatch&per_page=30`,
		]);
		if (!listed.ok) fail(`could not list ${workflow} runs: ${listed.err}`, 1);
		const rows = (JSON.parse(listed.out) as { workflow_runs: { id: number; status: string; head_branch: string }[] })
			.workflow_runs;
		for (const row of rows.filter(candidate => candidate.status !== "completed")) {
			const jobs = gh([
				"api",
				`repos/{owner}/{repo}/actions/runs/${row.id}/jobs?per_page=100`,
				"--jq",
				"[.jobs[] | {status, labels}]",
			]);
			if (!jobs.ok) fail(`could not list the jobs of run ${row.id}: ${jobs.err}`, 1);
			runs.push({ id: row.id, workflow, branch: row.head_branch, jobs: JSON.parse(jobs.out) as LaneJob[] });
		}
	}
	return laneOf(runs, replacing);
}

/**
 * The runner caps every workflow of this repo shares, in one place (the docs say "this account's caps" and point here):
 * the personal account's 40 jobs and 5 macOS at once. seuoffice moved to the org seuput-inc, so today this repo is the
 * only user; `siblings` (OMPDESK_CI_SIBLINGS, comma separated) names another repo of the account if one lands here later
 * (read-only: no policy of this repo can reserve slots against it).
 */
export const RUNNER_LIMITS = {
	owner: "SeuPut0705",
	jobs: 40,
	macos: 5,
	siblings: (process.env.OMPDESK_CI_SIBLINGS ?? "").split(",").filter(Boolean),
};

/** Open runs of this repo and its siblings, for the wait to be expected, not a mystery. */
function accountLoad(): string {
	const count = (repo: string, status: string) => {
		const counted = gh(["api", `repos/${repo}/actions/runs?status=${status}&per_page=1`, "--jq", ".total_count"]);
		return counted.ok ? counted.out.trim() : "?";
	};
	const here = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).out.trim();
	const parts = [here, ...RUNNER_LIMITS.siblings]
		.filter(Boolean)
		.map(repo => `${repo} ${count(repo, "in_progress")} running, ${count(repo, "queued")} queued runs`);
	return `${RUNNER_LIMITS.owner} (${RUNNER_LIMITS.jobs} jobs and ${RUNNER_LIMITS.macos} macOS at once, shared by this account's repos): ${parts.join("; ")}`;
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (typeof args === "string")
		fail(
			`${args}\nusage: bun scripts/ci-run.ts <workflow> [--ref <branch>] [-f key=value]... [--wait] [--replace] [--dry-run]`,
			2,
		);
	const ref = args.ref ?? currentBranch();
	if (!gh(["api", `repos/{owner}/{repo}/git/ref/heads/${ref}`]).ok) fail(`${ref} is not pushed: push it first`, 2);
	if (
		args.workflow !== "formal" &&
		!gh(["api", `repos/{owner}/{repo}/contents/.github/workflows/queue-gate.yml?ref=${ref}`]).ok
	) {
		fail(
			`${ref} has no .github/workflows/queue-gate.yml: its workflow files predate the check queue and hold nothing. Merge main into it first.`,
			2,
		);
	}
	let decision: Decision;
	for (;;) {
		const mac = asksForMac(args.workflow, args.inputs);
		const macRefs = mac ? gh(["variable", "get", "MAC_REFS"]).out.trim() : "";
		const lane = mac
			? readLane({ workflow: `${args.workflow}`, branch: ref })
			: { holders: [], waiting: [], openJobs: 0 };
		decision = decide(args, ref, macRefs, lane);
		if (mac) console.log(accountLoad());
		if (mac)
			console.log(
				`macOS lane: ${lane.holders.length} holder(s), ${lane.waiting.length} waiting, ${lane.openJobs} open macOS job(s) of dispatched runs`,
			);
		const holder = lane.holders[0];
		if (decision.go || decision.code !== 3 || !args.wait || !holder) break;
		console.log(`waiting for run ${holder.id} (one gh run watch, no polling)`);
		gh(["run", "watch", String(holder.id), "--interval", "120"]);
	}
	if (!decision.go) fail(decision.why, decision.code);
	if (decision.note) console.log(decision.note);
	const fields = Object.entries(args.inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
	if (args.dryRun) {
		console.log(`dry run: gh workflow run ${args.workflow}.yml --ref ${ref} ${fields.join(" ")}`);
		return 0;
	}
	const started = Date.now();
	const dispatched = gh(["workflow", "run", `${args.workflow}.yml`, "--ref", ref, ...fields]);
	if (!dispatched.ok) fail(`gh workflow run failed: ${dispatched.err}`, 1);
	for (let attempt = 0; attempt < 10; attempt++) {
		await Bun.sleep(2_000);
		const listed = gh([
			"run",
			"list",
			"--workflow",
			`${args.workflow}.yml`,
			"--branch",
			ref,
			"--event",
			"workflow_dispatch",
			"--limit",
			"5",
			"--json",
			"databaseId,createdAt,url",
		]);
		const rows = listed.ok
			? (JSON.parse(listed.out) as { databaseId: number; createdAt: string; url: string }[])
			: [];
		const mine = rows.find(row => Date.parse(row.createdAt) >= started - 5_000);
		if (mine) {
			console.log(
				`dispatched ${args.workflow}.yml on ${ref}: ${mine.url}\nwatch it once: bun scripts/watch-run.ts ${mine.databaseId}`,
			);
			return 0;
		}
	}
	console.log(
		`dispatched ${args.workflow}.yml on ${ref}; the run is not listed yet (gh run list --workflow ${args.workflow}.yml --branch ${ref})`,
	);
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
