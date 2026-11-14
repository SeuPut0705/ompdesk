/**
 * Dispatch a workflow on GitHub's runners through OMPdesk's checks hub (check-control, design §7 criterion 1).
 *
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true -f mac=true      the landing gate
 *   bun scripts/ci-run.ts e2e-nightly --ref omp/agent/foo -f specs="e2e/a.e2e.ts"
 *   bun scripts/ci-run.ts flake-probe --ref omp/agent/foo -f spec=e2e/a.e2e.ts -f os=macos
 *   options: --ref <branch> (default: the current branch), -f key=value (any number), --wait, --replace, --dry-run
 *
 * A thin client: it asks the hub (`ompdesk checks start --workflow <file> --input k=v ... [--macos] --ref <branch>`),
 * which runs the one admission every session's start goes through (the queue, the release lane first, macOS only for
 * main and MAC_REFS branches, a newer start of the same branch replacing the older one, a green run of the same inputs
 * reused) and dispatches with the admission ticket queue-gate.yml checks. It prints the hub's answer; the run id in it
 * is what `ompdesk checks wait <run>` waits on.
 *
 * When no hub answers (OMPdesk closed or restarting, or an `ompdesk` from before check control, which answers
 * `unknown command "checks"`), an app restart or an old install must not stop every CI dispatch: while the ticket gate
 * is off (the repo variable CHECKS_ADMISSION_DEVICES empty or unset) the dispatch goes out directly with
 * `gh workflow run`, macOS included, and says the hub was not used. Only while the gate is on is a macOS dispatch
 * without a hub refused with "open OMPdesk (a version with checks)" (exit 2): queue-gate.yml would refuse it anyway.
 * A hub that answered with an error of its own never has macOS work sent around it.
 *
 * A direct dispatch keeps the workflows' queue rules from before the hub (the `mac-dispatch` lane: one holder and one
 * waiting request for every dispatched macOS job): macOS only for main and MAC_REFS branches (exit 2), a branch without
 * queue-gate.yml refused (exit 2), and a macOS dispatch while the lane has a holder and a waiting request refused
 * (exit 3) with their run ids, because it would replace the waiting one. `--wait` watches the holder (one
 * `gh run watch`) and checks again; `--replace` dispatches anyway.
 *
 * Exit 0: started, held in the hub's queue or reused (the hub's words say which); 2: refused; 1: the dispatch failed.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { nativeBinPath } from "../src/main/native-bin";

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

/** Whether a direct dispatch may go out now, by the workflows' queue rules. */
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

/** The `ompdesk` command line that asks the hub. */
export function hubArgs(args: CiRunArgs, ref: string): string[] {
	const inputs = Object.entries(args.inputs).flatMap(([key, value]) => ["--input", `${key}=${value}`]);
	const macos = asksForMac(args.workflow, args.inputs) ? ["--macos"] : [];
	return ["checks", "start", "--workflow", `${args.workflow}.yml`, ...inputs, ...macos, "--ref", ref];
}

/** What `ompdesk` did: its exit code and output; undefined when there is no `ompdesk` to run. */
export interface HubAnswer {
	code: number;
	out: string;
	err: string;
}

/** The CLI's exit code when OMPdesk is not running or does not accept the call (`EXIT_NOT_RUNNING`). */
const NOT_RUNNING = 3;

export type Route =
	| { via: "hub"; code: 0 | 2; text: string }
	| { via: "direct"; why: string }
	| { via: "refused"; code: 1 | 2; why: string };

/** No checks hub answered: no `ompdesk`, OMPdesk not running, or an `ompdesk` from before check control. */
export function noHub(hub: HubAnswer | undefined): boolean {
	return !hub || hub.code === NOT_RUNNING || /unknown command "checks"/.test(hub.err + hub.out);
}

/** queue-gate.yml's ticket gate for the repo: `on` when it checks tickets, `off` when not, else why it is unknown. */
export type Gate = "on" | "off" | { unknown: string };

/** Where the dispatch goes, given what the hub answered; `gate` is read only for macOS work no hub took. */
export function route(mac: boolean, hub: HubAnswer | undefined, gate: () => Gate): Route {
	if (hub?.code === 0) {
		const text = hub.out.trim();
		return { via: "hub", code: text.startsWith("Checks refused") ? 2 : 0, text };
	}
	// The CLI's first line names what went wrong; the rest is advice for a person (`Run ompdesk help ...`).
	const said = hub ? (hub.err || hub.out).trim().split("\n")[0]?.trim() : undefined;
	const why = hub ? said || `ompdesk exited ${hub.code}` : "no ompdesk command found";
	if (!mac) return { via: "direct", why };
	if (!noHub(hub)) return { via: "refused", code: 1, why: `the checks hub did not start it: ${why}` };
	const state = gate();
	if (state === "off") return { via: "direct", why: `${why}; the ticket gate is off` };
	return {
		via: "refused",
		code: 2,
		why:
			state === "on"
				? "no checks hub answered, and this repository's queue gate admits macOS work only with a hub's ticket: open OMPdesk (a version with checks) and run this again."
				: `no checks hub answered, and whether this repository's queue gate wants a ticket could not be read (${state.unknown}): open OMPdesk (a version with checks) and run this again.`,
	};
}

/** Reads the ticket gate: the repo variable CHECKS_ADMISSION_DEVICES, as queue-gate.yml's callers pass it. */
export function readGate(read: (args: string[]) => { ok: boolean; out: string; err: string }): Gate {
	const got = read(["variable", "get", "CHECKS_ADMISSION_DEVICES"]);
	if (got.ok) return got.out.trim() === "" ? "off" : "on";
	if (/not found/i.test(got.err)) return "off";
	return { unknown: got.err.trim() || "gh failed" };
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

/** The `ompdesk` on PATH (a session's shell has it), else the one this checkout staged. */
function ompdesk(): string | undefined {
	const onPath = Bun.which("ompdesk");
	if (onPath) return onPath;
	const staged = nativeBinPath("ompdesk");
	return fs.existsSync(staged) ? staged : undefined;
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

/**
 * No hub took it: the run goes out as `gh workflow run` would send it, with one line saying the hub was not used, under
 * the workflows' queue rules (MAC_REFS, queue-gate.yml on the branch, the macOS lane's waiting request).
 */
function dispatchDirectly(args: CiRunArgs, ref: string, why: string): number {
	console.log(`ci-run: the checks hub was not used (${why}); dispatching directly.`);
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
	const mac = asksForMac(args.workflow, args.inputs);
	for (;;) {
		const macRefs = mac ? gh(["variable", "get", "MAC_REFS"]).out.trim() : "";
		const lane = mac ? readLane({ workflow: args.workflow, branch: ref }) : { holders: [], waiting: [], openJobs: 0 };
		const decision = decide(args, ref, macRefs, lane);
		if (mac) {
			console.log(accountLoad());
			console.log(
				`macOS lane: ${lane.holders.length} holder(s), ${lane.waiting.length} waiting, ${lane.openJobs} open macOS job(s) of dispatched runs`,
			);
		}
		const holder = lane.holders[0];
		if (!decision.go && decision.code === 3 && args.wait && holder) {
			console.log(`waiting for run ${holder.id} (one gh run watch, no polling)`);
			gh(["run", "watch", String(holder.id), "--interval", "120"]);
			continue;
		}
		if (!decision.go) fail(decision.why, decision.code);
		if (decision.note) console.log(decision.note);
		break;
	}
	// API 2026-03-10 returns this dispatch's run ID; a recent run on the same ref is never a receipt.
	const fields = Object.entries(args.inputs).flatMap(([key, value]) => ["-f", `inputs[${key}]=${value}`]);
	const dispatched = gh([
		"api",
		"--method",
		"POST",
		`repos/{owner}/{repo}/actions/workflows/${args.workflow}.yml/dispatches`,
		"-H",
		"Accept:application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version:2026-03-10",
		"-f",
		`ref=${ref}`,
		...fields,
	]);
	let id: number | undefined;
	if (dispatched.ok) {
		try {
			const receipt: unknown = JSON.parse(dispatched.out);
			if (receipt && typeof receipt === "object" && "workflow_run_id" in receipt) {
				const returned = receipt.workflow_run_id;
				if (typeof returned === "number" && Number.isSafeInteger(returned) && returned > 0) id = returned;
			}
		} catch {
			// A lost or malformed response does not prove that GitHub refused the dispatch.
		}
	}
	if (id === undefined) {
		const candidates = gh([
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
			"databaseId,displayTitle,headSha,url",
		]);
		fail(
			`dispatch outcome is unconfirmed; it may have started. Do not dispatch it again automatically.${dispatched.err ? ` ${dispatched.err}` : ""}\nCandidates (not attributed): ${candidates.ok ? candidates.out.trim() : candidates.err}`,
			1,
		);
	}
	console.log(`dispatched ${args.workflow}.yml on ${ref}: run ${id}\nwatch it once: bun scripts/watch-run.ts ${id}`);
	return 0;
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (typeof args === "string")
		fail(
			`${args}\nusage: bun scripts/ci-run.ts <workflow> [--ref <branch>] [-f key=value]... [--wait] [--replace] [--dry-run]`,
			2,
		);
	const ref = args.ref ?? currentBranch();
	const mac = asksForMac(args.workflow, args.inputs);
	const command = hubArgs(args, ref);
	if (args.dryRun) {
		console.log(`dry run: ompdesk ${command.join(" ")}`);
		return 0;
	}
	const bin = ompdesk();
	const ran = bin ? spawnSync(bin, command, { encoding: "utf8" }) : undefined;
	const hub = ran ? { code: ran.status ?? 1, out: ran.stdout ?? "", err: ran.stderr ?? "" } : undefined;
	const way = route(mac, hub, () => readGate(gh));
	switch (way.via) {
		case "hub":
			console.log(way.text);
			return way.code;
		case "direct":
			return dispatchDirectly(args, ref, way.why);
		case "refused":
			fail(way.why, way.code);
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
