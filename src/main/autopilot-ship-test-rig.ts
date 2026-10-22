/**
 * The world the ShipRunner tests share (never imported by app code): a repository, its bare remote and a run's worktree
 * on its own branch, with a runner wired to recording fakes. The tests are split over files so they run side by side:
 * each runs real git many times, and on a Windows runner the one file took 100 s.
 */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { AutopilotShipActionParams, ShipQueueItem } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { checkLandCandidate, type LandCheckInput } from "./autopilot-land-check";
import { type ShipDeps, ShipRunner, type ShipTarget } from "./autopilot-ship";
import { gitSync, initRepoWithRemote } from "./local/git/test-repos";

export let tmp = "";
export let main = "";
export let remote = "";
export let work = "";
export let actions: AutopilotShipActionParams[] = [];
export let broadcasts: ShipQueueItem[][] = [];
export let reverted: number[] = [];
export let prs: Array<{ cwd: string; title: string; body: string; base?: string; head?: string; draft?: boolean }> = [];

export const branch = "autopilot/2026-10-17";

export function target(over: Partial<ShipTarget> = {}): ShipTarget {
	return { root: work, checkoutRoot: main, branch, baseBranch: "main", remote: "origin", ...over };
}

export function runner(over: Partial<ShipDeps> = {}): ShipRunner {
	let n = 0;
	return new ShipRunner({
		journal: async action => {
			actions.push(action);
		},
		changed: queue => {
			broadcasts.push(queue.map(item => ({ ...item })));
		},
		reverted: async cycle => {
			reverted.push(cycle);
		},
		prText: async () => ({ title: "autopilot/2026-10-17: 2 cycles", body: "# log" }),
		prCreate: async (cwd, input) => {
			prs.push({ cwd, ...input });
			return { url: "https://github.com/o/r/pull/7", number: 7 };
		},
		now: () => 1000 + n,
		id: () => `s${++n}`,
		...over,
	});
}

export async function commit(cwd: string, file: string): Promise<string> {
	await fs.writeFile(path.join(cwd, file), `${file}\n`);
	gitSync(cwd, "add", file);
	gitSync(cwd, "commit", "-q", "-m", file);
	return gitSync(cwd, "rev-parse", "HEAD");
}

export const remoteTip = (ref: string): string => gitSync(remote, "rev-parse", ref);

/** Registers the shared hooks: a fresh repository, remote and worktree for each test. */
export function installShipRig(): void {
	beforeEach(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-ship-")));
		main = path.join(tmp, "main");
		remote = path.join(tmp, "remote.git");
		work = path.join(tmp, "work");
		actions = [];
		broadcasts = [];
		reverted = [];
		prs = [];
		await initRepoWithRemote(main, remote);
		gitSync(main, "worktree", "add", "-q", "-b", branch, work);
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});
}

// Landing on the default branch (autopilot-ship-land*.test.ts).
const landTarget = () => target({ landTo: "main" });
export const land = async (ship: ShipRunner, sha?: string, check?: string) => {
	ship.enqueue({ kind: "land", ...(sha ? { sha } : {}), ...(check ? { check } : {}) });
	const [result] = await ship.drain(landTarget());
	return result;
};
export const worktrees = () => gitSync(main, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length;
export const parents = (sha: string) => gitSync(remote, "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
export const contains = (ancestor: string, tip: string) =>
	gitSync(remote, "merge-base", "--is-ancestor", ancestor, tip) === "";
/** The real temporary-checkout check, recording which commits it ran on; `after` runs once each check ended. */
export function checking(after?: (input: LandCheckInput, n: number) => Promise<void>) {
	const checked: string[] = [];
	const checkCandidate = async (input: LandCheckInput) => {
		const result = await checkLandCandidate(input);
		checked.push(input.sha);
		await after?.(input, checked.length);
		return result;
	};
	return { checked, checkCandidate };
}
/** Someone else's commit on the remote's default branch, made from the user's checkout. */
export async function landElsewhere(file: string, text: string): Promise<string> {
	await fs.writeFile(path.join(main, file), text);
	gitSync(main, "add", file);
	gitSync(main, "commit", "-q", "-m", `elsewhere ${file}`);
	gitSync(main, "push", "-q", "origin", "main");
	return gitSync(main, "rev-parse", "HEAD");
}
