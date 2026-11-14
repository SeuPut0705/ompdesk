/**
 * Dispatch a workflow on GitHub's runners through OMPdesk's checks hub (check-control, design §7 criterion 1).
 *
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true
 *   bun scripts/ci-run.ts ci --ref omp/agent/foo -f batch=true -f mac=true      the landing gate
 *   bun scripts/ci-run.ts e2e-nightly --ref omp/agent/foo -f specs="e2e/a.e2e.ts"
 *   bun scripts/ci-run.ts flake-probe --ref omp/agent/foo -f spec=e2e/a.e2e.ts -f os=macos
 *   options: --ref <branch> (default: the current branch), -f key=value (any number), --dry-run
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

export interface CiRunArgs {
	workflow: string;
	ref: string | undefined;
	inputs: Record<string, string>;
	dryRun: boolean;
}

export function parseArgs(argv: string[]): CiRunArgs | string {
	const [first, ...rest] = argv;
	const workflow = first?.replace(/\.yml$/, "") ?? "";
	if (!(workflow in WORKFLOWS)) return `workflow must be one of ${Object.keys(WORKFLOWS).join(", ")}`;
	const args: CiRunArgs = { workflow, ref: undefined, inputs: {}, dryRun: false };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--ref") args.ref = rest[++i];
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

/** No hub took it: the run goes out as `gh workflow run` would send it, with one line saying the hub was not used. */
async function dispatchDirectly(args: CiRunArgs, ref: string, why: string): Promise<number> {
	console.log(`ci-run: dispatched directly, the checks hub was not used (${why}).`);
	if (!gh(["api", `repos/{owner}/{repo}/git/ref/heads/${ref}`]).ok) fail(`${ref} is not pushed: push it first`, 2);
	const fields = Object.entries(args.inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
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

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (typeof args === "string")
		fail(`${args}\nusage: bun scripts/ci-run.ts <workflow> [--ref <branch>] [-f key=value]... [--dry-run]`, 2);
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
