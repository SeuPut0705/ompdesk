/**
 * Autopilot's ShipRunner: what main does to git on the run's behalf, one queue per autopilot tab. The agent
 * never pushes (the bridge guard blocks it); the runtime does, at the end of a turn, from the sha it pins
 * then: the push after a green cycle and the buttons on the screen (push, PR, merge into the default
 * branch, revert a cycle). A release is the agent's own work, so it only appears here for display.
 *
 * Rules: explicit refspecs without `+` (a refusal stays a refusal), the remote by NAME with its own URL
 * pinned as `pushurl` through `GIT_CONFIG_*` (so a `pushInsteadOf` rule cannot redirect it), a conflicting
 * merge or revert is aborted, one failed item never blocks the next, and every ref move is journaled before
 * it happens so the audit (autopilot-audit.ts) expects exactly it.
 */
import type {
	AutopilotShipActionParams,
	ShipKind,
	ShipQueueItem,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { gitRaw } from "./local/git/exec";

export interface ShipTarget {
	/** The run's worktree. */
	root: string;
	/** The user's default checkout (where a merge lands). */
	checkoutRoot: string;
	branch: string;
	/** Push `HEAD:<pushTo>` instead of the branch itself (a run on its own branch off a target another worktree holds). */
	pushTo?: string;
	baseBranch: string;
	remote: string;
}

export interface ShipDeps {
	/** Journal a ref move the audit must allow (`modes.autopilot_ship_action`). */
	journal(action: AutopilotShipActionParams): Promise<void>;
	/** The queue changed: broadcast it. */
	changed(queue: readonly ShipQueueItem[]): void;
	/** A revert went through: mark the cycle (`modes.autopilot_mark_reverted`). */
	reverted(cycle: number): Promise<void>;
	/** The pull request's title and body: the cycle log. */
	prText(): Promise<{ title: string; body: string }>;
	prCreate(
		cwd: string,
		input: { title: string; body: string; base?: string; head?: string; draft?: boolean },
	): Promise<{ url: string; number: number }>;
	now(): number;
	id(): string;
}

export interface ShipRequest {
	kind: Exclude<ShipKind, "release">;
	/** `revert`: the cycle and its commit. */
	cycle?: number;
	sha?: string;
	/** `merge`: also allow a merge commit when a fast-forward is not possible. */
	mode?: "ff" | "merge_commit";
}

export type PushFailure = "rejected" | "network";

export interface ShipResult {
	item: ShipQueueItem;
	/** A push that failed: a refusal (also authentication) stops the run, a network failure only after repeats. */
	failure?: PushFailure;
	/** The push ran and may have set the branch's upstream (a `git config` write the audit must allow). */
	pushed?: boolean;
}

const PUSH_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 120_000;
/** Finished items kept for the screen. */
const KEEP_FINISHED = 20;
const NETWORK_FAILURE =
	/could not resolve host|unable to access|connection (refused|reset|timed out)|timed out|network is unreachable|no route to host|does not appear to be a git repository|could not read from remote/i;
const REFUSED_FIRST =
	/rejected|denied|permission|authentication|could not read username|terminal prompts disabled|protected branch/i;

/** A failed push's stderr: refused or authentication (stop at once) or the network (stop after repeats). */
export function classifyPushFailure(stderr: string): PushFailure {
	if (REFUSED_FIRST.test(stderr)) return "rejected";
	return NETWORK_FAILURE.test(stderr) ? "network" : "rejected";
}

function brief(text: string): string {
	const line =
		text
			.split("\n")
			.map(entry => entry.trim())
			.filter(Boolean)
			.slice(-3)
			.join(" · ") || "failed";
	return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

class ShipFailure extends Error {
	constructor(
		message: string,
		readonly push?: PushFailure,
	) {
		super(message);
	}
}

export class ShipRunner {
	readonly #deps: ShipDeps;
	readonly #items: ShipQueueItem[] = [];
	readonly #modes = new Map<string, "ff" | "merge_commit">();
	#tail: Promise<unknown> = Promise.resolve();

	constructor(deps: ShipDeps) {
		this.#deps = deps;
	}

	queue(): ShipQueueItem[] {
		return this.#items.map(item => ({ ...item }));
	}

	/** Queue an item; it runs at the next `drain` (the end of the turn). */
	enqueue(request: ShipRequest): ShipQueueItem {
		const item: ShipQueueItem = {
			id: this.#deps.id(),
			kind: request.kind,
			state: "queued",
			...(request.cycle === undefined ? {} : { cycle: request.cycle }),
			...(request.sha ? { sha: request.sha } : {}),
			at: this.#deps.now(),
		};
		if (request.mode) this.#modes.set(item.id, request.mode);
		this.#items.push(item);
		this.#broadcast();
		return { ...item };
	}

	/** Show something the runner does not run (a release the agent performs). */
	track(entry: { kind: "release"; detail?: string }): ShipQueueItem {
		const item: ShipQueueItem = {
			id: this.#deps.id(),
			kind: entry.kind,
			state: "running",
			...(entry.detail ? { detail: entry.detail } : {}),
			at: this.#deps.now(),
		};
		this.#items.push(item);
		this.#broadcast();
		return { ...item };
	}

	/** Settle a tracked item. */
	finish(id: string, state: "done" | "failed", detail?: string, url?: string): void {
		const item = this.#items.find(entry => entry.id === id);
		if (!item) return;
		item.state = state;
		if (detail !== undefined) item.detail = detail;
		if (url !== undefined) item.url = url;
		this.#broadcast();
	}

	/** Drop an item that has not started. */
	cancel(id: string): boolean {
		const at = this.#items.findIndex(entry => entry.id === id && entry.state === "queued");
		if (at < 0) return false;
		this.#items.splice(at, 1);
		this.#modes.delete(id);
		this.#broadcast();
		return true;
	}

	/** Whether a queued item is waiting. */
	hasQueued(): boolean {
		return this.#items.some(item => item.state === "queued");
	}

	/**
	 * Run the queued items in order (items queued meanwhile too); with `accept`, only those it takes, the rest stay
	 * queued for a later drain. Drains never overlap.
	 */
	drain(target: ShipTarget, accept?: (item: ShipQueueItem) => boolean): Promise<ShipResult[]> {
		const run = this.#tail.then(() => this.#drain(target, accept));
		this.#tail = run.catch(() => undefined);
		return run;
	}

	async #drain(target: ShipTarget, accept?: (item: ShipQueueItem) => boolean): Promise<ShipResult[]> {
		const results: ShipResult[] = [];
		for (;;) {
			const item = this.#items.find(entry => entry.state === "queued" && (accept?.(entry) ?? true));
			if (!item) break;
			item.state = "running";
			this.#broadcast();
			const result: ShipResult = { item };
			try {
				if (item.kind === "push") Object.assign(result, await this.#push(target, item));
				else if (item.kind === "pr") Object.assign(result, await this.#pr(target, item));
				else if (item.kind === "merge") await this.#merge(target, item);
				else if (item.kind === "revert") await this.#revert(target, item);
				item.state = "done";
			} catch (error) {
				item.state = "failed";
				item.detail = error instanceof Error ? brief(error.message) : String(error);
				if (error instanceof ShipFailure && error.push) result.failure = error.push;
			}
			this.#modes.delete(item.id);
			results.push({ ...result, item: { ...item } });
			this.#prune();
			this.#broadcast();
		}
		return results;
	}

	#broadcast(): void {
		this.#deps.changed(this.queue());
	}

	#prune(): void {
		// The newest release stays however many pushes follow it: the screen shows the last release's outcome.
		const lastRelease = this.#items.findLast(entry => entry.kind === "release");
		const finished = this.#items.filter(
			entry => (entry.state === "done" || entry.state === "failed") && entry !== lastRelease,
		);
		for (const stale of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
			this.#items.splice(this.#items.indexOf(stale), 1);
		}
	}

	async #git(cwd: string, args: string[], env?: Record<string, string>, timeoutMs = GIT_TIMEOUT_MS) {
		return gitRaw(cwd, args, { timeoutMs, ...(env ? { env } : {}) });
	}

	async #text(cwd: string, args: string[]): Promise<string> {
		const result = await this.#git(cwd, args);
		if (result.code !== 0) throw new ShipFailure(brief(result.stderr));
		return result.stdout.toString("utf8").trim();
	}

	/** Push the sha pinned now to `refs/heads/<branch>` on the remote; true when it moved the remote. */
	async #pushPinned(target: ShipTarget, item: ShipQueueItem): Promise<void> {
		const { root, branch, remote } = target;
		// The branch Push moves: the run's own, or the target the run works toward (fast-forward only either way).
		const dest = target.pushTo ?? branch;
		const sha = item.sha ?? (await this.#text(root, ["rev-parse", "HEAD"]));
		item.sha = sha;
		const url = await this.#text(root, ["remote", "get-url", remote]);
		await this.#deps.journal({ kind: "push", refs: [`refs/remotes/${remote}/${dest}`], sha });
		const pushed = await this.#git(
			root,
			["push", remote, `${sha}:refs/heads/${dest}`],
			{ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `remote.${remote}.pushurl`, GIT_CONFIG_VALUE_0: url },
			PUSH_TIMEOUT_MS,
		);
		if (pushed.code !== 0) {
			const moved = /non-fast-forward|fetch first|stale info|\(already exists\)/i.test(pushed.stderr);
			// A push is never forced: a remote branch that moved on stops the run, and the reason says so.
			const why = moved
				? `${remote}/${dest} has commits this run lacks (not a fast-forward); Autopilot never forces a push. ${brief(pushed.stderr)}`
				: brief(pushed.stderr);
			throw new ShipFailure(why.length > 400 ? `${why.slice(0, 397)}...` : why, classifyPushFailure(pushed.stderr));
		}
		const upstream = await this.#git(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
		if (upstream.code !== 0) {
			await this.#git(root, ["branch", `--set-upstream-to=${remote}/${dest}`, branch]);
		}
	}

	async #push(target: ShipTarget, item: ShipQueueItem): Promise<Pick<ShipResult, "pushed">> {
		await this.#pushPinned(target, item);
		return { pushed: true };
	}

	async #pr(target: ShipTarget, item: ShipQueueItem): Promise<Pick<ShipResult, "pushed">> {
		const { root, branch, remote, baseBranch } = target;
		const sha = await this.#text(root, ["rev-parse", "HEAD"]);
		const tracked = await this.#git(root, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`]);
		const onRemote = tracked.code === 0 && tracked.stdout.toString("utf8").trim() === sha;
		if (!onRemote) await this.#pushPinned(target, item);
		const { title, body } = await this.#deps.prText();
		const created = await this.#deps.prCreate(root, { title, body, base: baseBranch, head: branch, draft: true });
		item.url = created.url;
		item.detail = `#${created.number}`;
		return onRemote ? {} : { pushed: true };
	}

	async #merge(target: ShipTarget, item: ShipQueueItem): Promise<void> {
		const { root, checkoutRoot, baseBranch } = target;
		const current = await this.#git(checkoutRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
		const onBranch = current.code === 0 ? current.stdout.toString("utf8").trim() : "";
		if (onBranch !== baseBranch) {
			throw new ShipFailure(`The default checkout is on ${onBranch || "a detached HEAD"}, not ${baseBranch}.`);
		}
		const dirty = await this.#text(checkoutRoot, ["status", "--porcelain", "--untracked-files=no"]);
		if (dirty) throw new ShipFailure("The default checkout has uncommitted changes; it must be clean to merge.");
		const sha = item.sha ?? (await this.#text(root, ["rev-parse", "HEAD"]));
		item.sha = sha;
		await this.#deps.journal({ kind: "merge", refs: [`refs/heads/${baseBranch}`], sha });
		const fast = await this.#git(checkoutRoot, ["merge", "--ff-only", sha]);
		if (fast.code === 0) return;
		if (this.#modes.get(item.id) !== "merge_commit") {
			throw new ShipFailure(`${baseBranch} cannot fast-forward to this branch: ${brief(fast.stderr)}`);
		}
		const merged = await this.#git(checkoutRoot, ["merge", "--no-ff", "--no-edit", sha]);
		if (merged.code === 0) return;
		await this.#git(checkoutRoot, ["merge", "--abort"]);
		throw new ShipFailure(
			`The merge conflicted and was aborted: ${brief(merged.stdout.toString("utf8") || merged.stderr)}`,
		);
	}

	async #revert(target: ShipTarget, item: ShipQueueItem): Promise<void> {
		const { root } = target;
		const { sha, cycle } = item;
		if (!sha) throw new ShipFailure("That cycle has no commit to revert.");
		const parents = await this.#git(root, ["rev-list", "--parents", "-n", "1", sha]);
		if (parents.code !== 0) throw new ShipFailure(brief(parents.stderr));
		const merge = parents.stdout.toString("utf8").trim().split(/\s+/).length > 2;
		await this.#deps.journal({ kind: "revert", refs: [], sha });
		const reverted = await this.#git(root, ["revert", "--no-edit", ...(merge ? ["-m", "1"] : []), sha]);
		if (reverted.code !== 0) {
			await this.#git(root, ["revert", "--abort"]);
			throw new ShipFailure(
				`The revert conflicted and was aborted: ${brief(reverted.stdout.toString("utf8") || reverted.stderr)}`,
			);
		}
		if (cycle !== undefined) await this.#deps.reverted(cycle);
	}
}
