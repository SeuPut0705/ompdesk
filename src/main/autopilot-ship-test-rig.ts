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
import { landShell } from "./autopilot";
import { CorePort } from "./core/ports";
import { type CoreAnswer, core } from "./core/process";
import { coreGit, gitRunner } from "./local/git/exec";
import { gitSync, initRepoWithRemote } from "./local/git/test-repos";
import { prepareWorktree } from "./local/git/worktree-seed";

/**
 * The ShipRunner and the land check are the core's (`crates/core/src/autopilot/{ship,land_check}.rs`); these are their
 * typed clients for the parity suites, over the stateless wire the core serves for them (`autopilot.ship.*`,
 * `autopilot.landCheck`). A ship queue lives in the core, so each call that read a queue's state synchronously is a call.
 */
export interface ShipTarget {
	root: string;
	checkoutRoot: string;
	branch: string;
	pushTo?: string;
	baseBranch: string;
	remote: string;
	landTo?: string;
}

export interface LandCheckInput {
	root: string;
	primary: string;
	sha: string;
	base?: string;
	command: string;
	timeoutMs?: number;
}

export interface LandCheck {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	tail: string;
}

export type LandOutcome =
	| { kind: "landed"; sha: string; merge?: { onto: string; check: string; advanced: boolean } }
	| { kind: "behind"; ahead: number | null; conflicts: string[] | null }
	| {
			kind: "red";
			candidate: string;
			onto: string;
			check: string;
			exitCode: number | null;
			timedOut: boolean;
			tail: string;
	  }
	| { kind: "pr"; url?: string; created: boolean; reason: string };

export interface ShipResult {
	item: ShipQueueItem;
	failure?: "rejected" | "network";
	pushed?: boolean;
	land?: LandOutcome;
}

export interface ShipDeps {
	journal(action: AutopilotShipActionParams): Promise<void>;
	changed(queue: readonly ShipQueueItem[]): void;
	reverted(cycle: number): Promise<void>;
	prText(): Promise<{ title: string; body: string }>;
	prCreate(
		cwd: string,
		input: { title: string; body: string; base?: string; head?: string; draft?: boolean },
	): Promise<{ url: string; number: number }>;
	now(): number;
	id(): string;
	checkCandidate?(input: LandCheckInput): Promise<LandCheck>;
	/** The git runner the core asks for (what stays main's); a test makes one call never answer. */
	gitRunner?(): ReturnType<typeof gitRunner>;
}

/** The handlers a port serves the core's land check and ship queue: what stays main's (the checkout's preparation and shell). */
const checkoutHandlers = {
	gitRunner: (): ReturnType<typeof gitRunner> => gitRunner(),
	prepareWorktree: ({ primary, tree }: { primary: string; tree: string }) => prepareWorktree(primary, tree),
	landShell: ({ command }: { command: string }) => landShell(command),
};

/** `checkLandCandidate`: the core checks `sha` out on its own, runs `command` there and removes the checkout. */
export async function checkLandCandidate(input: LandCheckInput): Promise<LandCheck> {
	const port = new CorePort(checkoutHandlers);
	try {
		return await coreGit<LandCheck>(
			"autopilot.landCheck",
			{ port: port.id, ...port.first(), input },
			2,
			(input.timeoutMs ?? 30 * 60_000) + 60_000,
		);
	} finally {
		port.close();
	}
}

export class ShipRunner {
	readonly #deps: ShipDeps;
	readonly #port: CorePort;

	constructor(deps: ShipDeps) {
		this.#deps = deps;
		this.#port = new CorePort({
			...checkoutHandlers,
			...(deps.gitRunner ? { gitRunner: () => deps.gitRunner?.() } : {}),
			shipJournal: (action: AutopilotShipActionParams) => deps.journal(action),
			shipChanged: (queue: ShipQueueItem[]) => deps.changed(queue),
			shipReverted: ({ cycle }: { cycle: number }) => deps.reverted(cycle),
			shipPrText: () => deps.prText(),
			shipPrCreate: ({ cwd, input }: { cwd: string; input: Parameters<ShipDeps["prCreate"]>[1] }) =>
				deps.prCreate(cwd, input),
			shipCheck: (input: LandCheckInput) => (deps.checkCandidate as NonNullable<ShipDeps["checkCandidate"]>)(input),
		});
		void core().call("autopilot.ship.open", {
			port: this.#port.id,
			...this.#port.first(),
			customCheck: deps.checkCandidate !== undefined,
		});
	}

	async #call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
		const answer: CoreAnswer<T> = await core().call<T>(
			`autopilot.ship.${method}`,
			{ port: this.#port.id, ...params },
			timeoutMs === undefined ? {} : { timeoutMs },
		);
		return answer.result;
	}

	queue(): Promise<ShipQueueItem[]> {
		return this.#call("queue");
	}

	enqueue(request: {
		kind: "push" | "pr" | "merge" | "land" | "revert";
		cycle?: number;
		sha?: string;
		mode?: "ff" | "merge_commit";
		check?: string;
	}): Promise<ShipQueueItem> {
		return this.#call("enqueue", { request, id: this.#deps.id(), at: this.#deps.now() });
	}

	track(entry: { kind: "release"; detail?: string }): Promise<ShipQueueItem> {
		return this.#call("track", { detail: entry.detail, id: this.#deps.id(), at: this.#deps.now() });
	}

	async finish(id: string, state: "done" | "failed", detail?: string, url?: string): Promise<void> {
		await this.#call("finish", { id, state, detail, url });
	}

	cancel(id: string): Promise<boolean> {
		return this.#call("cancel", { id });
	}

	/**
	 * Runs the queue; a land's check can take as long as the check's own bound. `maxMs` bounds this drain alone (the
	 * app's is 3 h, which no test waits for).
	 */
	drain(target: ShipTarget, options: { maxMs?: number } = {}): Promise<ShipResult[]> {
		return this.#call(
			"drain",
			{ target, ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }) },
			2 * 60 * 60_000,
		);
	}

	/** Closes the port: what the core still asks of this client fails. */
	close(): void {
		this.#port.close();
	}
}

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
	await ship.enqueue({ kind: "land", ...(sha ? { sha } : {}), ...(check ? { check } : {}) });
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
