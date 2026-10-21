/**
 * Autopilot's ShipRunner: what main does to git on the run's behalf, one queue per autopilot tab. The agent
 * never pushes (the bridge guard blocks it); the runtime does, at the end of a turn, from the sha it pins
 * then: the push after a green cycle, landing a green cycle on the default branch (Automatic shipping), and the
 * buttons on the screen (push, PR, merge into the default branch, revert a cycle). A release is the agent's own work,
 * so it only appears here for display.
 *
 * Rules: explicit refspecs without `+` (a refusal stays a refusal), the remote by NAME with its own URL
 * pinned as `pushurl` through `GIT_CONFIG_*` (so a `pushInsteadOf` rule cannot redirect it), a conflicting
 * merge or revert is aborted, one failed item never blocks the next, and every ref move is journaled before
 * it happens so the audit (autopilot-audit.ts) expects exactly it. Landing never merges into the run's worktree (the
 * next turn may already be working in it): when the default branch moved on and merges cleanly, the merge commit is
 * built without a checkout, the cycle's own check runs on exactly that commit in a temporary checkout
 * (autopilot-land-check.ts), and only that commit is pushed, as a fast-forward. A merge that conflicts or fails its
 * check is reported, and the agent merges, checks and commits in its next cycle.
 */

import { devNull } from "node:os";
import type {
	AutopilotShipActionParams,
	ShipKind,
	ShipQueueItem,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { checkLandCandidate, type LandCheck, type LandCheckInput } from "./autopilot-land-check";
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
	/** The project's default branch a `land` item fast-forwards (Automatic shipping). */
	landTo?: string;
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
	/** Check a land candidate in a temporary checkout (default: {@link checkLandCandidate}). */
	checkCandidate?(input: LandCheckInput): Promise<LandCheck>;
}

export interface ShipRequest {
	kind: Exclude<ShipKind, "release">;
	/** `revert`: the cycle and its commit. */
	cycle?: number;
	sha?: string;
	/** `merge`: also allow a merge commit when a fast-forward is not possible. */
	mode?: "ff" | "merge_commit";
	/** `land`: the command whose pass made the cycle green; a merge with a moved default branch is checked with it. */
	check?: string;
}

export type PushFailure = "rejected" | "network";

/**
 * What a `land` did. `landed`: the default branch is now `sha` (or already was): the cycle's commit, or with `merge`
 * the commit that merged the default branch (`onto`) into it, which `check` passed on in a temporary checkout;
 * `advanced` says the run's own branch was fast-forwarded to it. `behind`: the default branch has commits the run
 * lacks; nothing moved; `conflicts` names the files a merge would conflict in (empty: a clean merge; null: git could
 * not say). `red`: the merge was clean but the check failed on it; nothing moved. `pr`: the remote refused the default
 * branch (protected), so the run's branch was pushed and one pull request opened (`created`) or updated.
 */
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
	/** A push that failed: a refusal (also authentication) stops the run, a network failure only after repeats. */
	failure?: PushFailure;
	/** The push ran and may have set the branch's upstream (a `git config` write the audit must allow). */
	pushed?: boolean;
	land?: LandOutcome;
}

const PUSH_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 120_000;
/** Finished items kept for the screen. */
const KEEP_FINISHED = 20;
/** Candidates a land builds when the default branch keeps moving (each checked); then the next cycle tries again. */
const LAND_ATTEMPTS = 3;
const NETWORK_FAILURE =
	/could not resolve host|unable to access|connection (refused|reset|timed out)|timed out|network is unreachable|no route to host|does not appear to be a git repository|could not read from remote/i;
const REFUSED_FIRST =
	/rejected|denied|permission|authentication|could not read username|terminal prompts disabled|protected branch/i;

/** A refused push that is the default branch moving on, not a rule against pushing there. */
const MOVED_ON = /non-fast-forward|fetch first|stale info|\(already exists\)/i;
/** A refusal that is the account, not the branch: a pull request would be refused as well. */
const NOT_ALLOWED_AT_ALL =
	/could not read username|authentication failed|terminal prompts disabled|invalid credentials/i;
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

/** A land that did not move the default branch for a reason the next cycle repairs (the branch moved on). */
class LandStop extends Error {
	constructor(
		message: string,
		readonly outcome: LandOutcome,
	) {
		super(message);
	}
}

function behindDetail(remote: string, dest: string, behind: LandOutcome): string {
	if (behind.kind !== "behind") return "";
	const moved =
		behind.ahead === null
			? `${remote}/${dest} moved on`
			: `${remote}/${dest} has ${behind.ahead} commit${behind.ahead === 1 ? "" : "s"} this run lacks`;
	if (behind.conflicts === null) return `${moved}; not landed: merge it first`;
	if (behind.conflicts.length === 0) return `${moved}; not landed: it merges cleanly, merge it first`;
	const listed = behind.conflicts.slice(0, 5).join(", ");
	const more = behind.conflicts.length > 5 ? ` and ${behind.conflicts.length - 5} more` : "";
	return `${moved}; not landed: a merge conflicts in ${listed}${more}`;
}

export class ShipRunner {
	readonly #deps: ShipDeps;
	readonly #items: ShipQueueItem[] = [];
	readonly #modes = new Map<string, "ff" | "merge_commit">();
	/** A land item's check command (what made its cycle green). */
	readonly #checks = new Map<string, string>();
	/** The pull request a protected default branch made landing open (one per run; later lands update its branch). */
	#landPr: { url?: string } | null = null;
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
		if (request.check) this.#checks.set(item.id, request.check);
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
		this.#checks.delete(id);
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
				else if (item.kind === "land") Object.assign(result, await this.#land(target, item));
				else if (item.kind === "revert") await this.#revert(target, item);
				item.state = "done";
			} catch (error) {
				item.state = "failed";
				item.detail = error instanceof Error ? brief(error.message) : String(error);
				if (error instanceof ShipFailure && error.push) result.failure = error.push;
				if (error instanceof LandStop) result.land = error.outcome;
			}
			this.#modes.delete(item.id);
			this.#checks.delete(item.id);
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
		const pushed = await this.#pushSha(target, sha, dest);
		if (pushed.code !== 0) {
			// A push is never forced: a remote branch that moved on stops the run, and the reason says so.
			const why = MOVED_ON.test(pushed.stderr)
				? `${remote}/${dest} has commits this run lacks (not a fast-forward); Autopilot never forces a push. ${brief(pushed.stderr)}`
				: brief(pushed.stderr);
			throw new ShipFailure(why.length > 400 ? `${why.slice(0, 397)}...` : why, classifyPushFailure(pushed.stderr));
		}
		await this.#trackUpstream(target, dest);
	}

	/** `git push <remote> <sha>:refs/heads/<dest>`, journaled first, never forced. */
	async #pushSha(target: ShipTarget, sha: string, dest: string) {
		const { root, remote } = target;
		const url = await this.#text(root, ["remote", "get-url", remote]);
		await this.#deps.journal({ kind: "push", refs: [`refs/remotes/${remote}/${dest}`], sha });
		return this.#git(
			root,
			["push", remote, `${sha}:refs/heads/${dest}`],
			{ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `remote.${remote}.pushurl`, GIT_CONFIG_VALUE_0: url },
			PUSH_TIMEOUT_MS,
		);
	}

	async #trackUpstream(target: ShipTarget, dest: string): Promise<void> {
		const { root, branch, remote } = target;
		const upstream = await this.#git(root, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
		if (upstream.code !== 0) {
			await this.#git(root, ["branch", `--set-upstream-to=${remote}/${dest}`, branch]);
		}
	}

	/**
	 * Land the cycle's commit on the default branch. Fetch it; when the commit contains the remote's tip, push it there
	 * (a fast-forward). When the default branch moved on and merges cleanly (`git merge-tree`, no checkout), build the
	 * merge commit, run the cycle's check on exactly that commit in a temporary checkout, and push it only when the check
	 * passed and the default branch did not move meanwhile; a branch that moved again (during the check or the push)
	 * gets a new candidate, checked again, up to {@link LAND_ATTEMPTS} times. A merge that conflicts, a cycle without a
	 * known check, or a failed check is reported and nothing moves. A refusal that is not the branch moving on is a
	 * protected branch: the run's branch goes up instead, with one pull request into the default branch.
	 */
	async #land(target: ShipTarget, item: ShipQueueItem): Promise<Pick<ShipResult, "land" | "pushed">> {
		const { root, remote } = target;
		const dest = target.landTo;
		if (!dest) throw new ShipFailure("The run has no default branch to land on.");
		const sha = item.sha ?? (await this.#text(root, ["rev-parse", "HEAD"]));
		item.sha = sha;
		const check = this.#checks.get(item.id);
		for (let attempt = 1; ; attempt++) {
			const tip = await this.#fetchTip(target, dest);
			if (tip === sha) {
				item.detail = `${remote}/${dest} already has it`;
				return { land: { kind: "landed", sha } };
			}
			let candidate = sha;
			let merge: { onto: string; check: string } | undefined;
			if (tip && (await this.#git(root, ["merge-base", "--is-ancestor", tip, sha])).code !== 0) {
				// A pull request already carries the run (the default branch refuses pushes): it takes the commit as it is.
				if (this.#landPr !== null) return this.#landByPr(target, item, sha, "the default branch refuses pushes");
				const behind = await this.#behind(root, tip, sha);
				if (!check || behind.conflicts === null || behind.conflicts.length > 0) {
					item.detail = behindDetail(remote, dest, behind);
					throw new LandStop(item.detail, behind);
				}
				candidate = await this.#mergeCommit(root, sha, tip, `${remote}/${dest}`);
				item.detail = `checking the merge with ${remote}/${dest} (${candidate.slice(0, 9)})`;
				this.#broadcast();
				const checked = await (this.#deps.checkCandidate ?? checkLandCandidate)({
					root,
					primary: target.checkoutRoot,
					sha: candidate,
					base: tip,
					command: check,
				});
				if (!checked.ok) {
					const red: LandOutcome = {
						kind: "red",
						candidate,
						onto: tip,
						check,
						exitCode: checked.exitCode,
						timedOut: checked.timedOut,
						tail: checked.tail,
					};
					item.detail = `the merge with ${remote}/${dest} fails the check (${checked.timedOut ? "timed out" : `exit ${checked.exitCode ?? "?"}`}); not landed`;
					throw new LandStop(item.detail, red);
				}
				if ((await this.#fetchTip(target, dest)) !== tip) {
					if (attempt < LAND_ATTEMPTS) continue;
					throw this.#keptMoving(target, item, dest);
				}
				merge = { onto: tip, check };
			}
			const pushed = await this.#pushSha(target, candidate, dest);
			if (pushed.code === 0) {
				item.detail = merge
					? `${remote}/${dest} (merged with ${merge.onto.slice(0, 9)}, checked)`
					: `${remote}/${dest}`;
				if (!merge) return { land: { kind: "landed", sha }, pushed: true };
				const advanced = await this.#advance(root, sha, candidate);
				return { land: { kind: "landed", sha: candidate, merge: { ...merge, advanced } }, pushed: true };
			}
			if (MOVED_ON.test(pushed.stderr)) {
				// The default branch moved between the fetch and the push: measure it again.
				if (attempt < LAND_ATTEMPTS) continue;
				throw this.#keptMoving(target, item, dest);
			}
			const failure = classifyPushFailure(pushed.stderr);
			if (failure === "network" || NOT_ALLOWED_AT_ALL.test(pushed.stderr)) {
				throw new ShipFailure(brief(pushed.stderr), failure);
			}
			// The remote's own words say why (a branch rule, a hook); git's trailer only says that it refused.
			const said = pushed.stderr
				.split("\n")
				.filter(line => line.startsWith("remote:"))
				.join("\n");
			return this.#landByPr(target, item, sha, brief(said.replace(/^remote:\s*/gm, "") || pushed.stderr));
		}
	}

	#keptMoving(target: ShipTarget, item: ShipQueueItem, dest: string): LandStop {
		const behind: LandOutcome = { kind: "behind", ahead: null, conflicts: null };
		item.detail = `${behindDetail(target.remote, dest, behind)} (it kept moving: ${LAND_ATTEMPTS} tries)`;
		return new LandStop(item.detail, behind);
	}

	/** Fetch the default branch into its remote-tracking ref; its tip, or null when the remote has no such branch. */
	async #fetchTip(target: ShipTarget, dest: string): Promise<string | null> {
		const { root, remote } = target;
		const tracking = `refs/remotes/${remote}/${dest}`;
		const fetched = await this.#git(
			root,
			["fetch", "--no-tags", remote, `+refs/heads/${dest}:${tracking}`],
			undefined,
			PUSH_TIMEOUT_MS,
		);
		if (fetched.code !== 0 && !/couldn't find remote ref/i.test(fetched.stderr)) {
			throw new ShipFailure(brief(fetched.stderr), classifyPushFailure(fetched.stderr));
		}
		const tipRead = await this.#git(root, ["rev-parse", "--verify", "-q", tracking]);
		return tipRead.code === 0 ? tipRead.stdout.toString("utf8").trim() : null;
	}

	/** The merge of `tip` into `sha` as a commit object (`sha` first parent), built without any checkout or ref. */
	async #mergeCommit(root: string, sha: string, tip: string, name: string): Promise<string> {
		const tree = await this.#text(root, ["merge-tree", "--write-tree", "--no-messages", sha, tip]);
		const short = await this.#text(root, ["rev-parse", "--short", sha]);
		return this.#text(root, [
			"commit-tree",
			"--no-gpg-sign",
			tree.split("\n")[0] ?? tree,
			"-p",
			sha,
			"-p",
			tip,
			"-m",
			`Merge ${name} into ${short} (Autopilot land)`,
		]);
	}

	/**
	 * Fast-forward the run's branch to the landed merge, only while its worktree still sits on the cycle's commit with
	 * nothing changed (the agent has not moved on); no hook runs. False: left as it was.
	 */
	async #advance(root: string, from: string, to: string): Promise<boolean> {
		const head = await this.#git(root, ["rev-parse", "HEAD"]);
		if (head.code !== 0 || head.stdout.toString("utf8").trim() !== from) return false;
		const status = await this.#git(root, ["status", "--porcelain"]);
		if (status.code !== 0 || status.stdout.toString("utf8").trim() !== "") return false;
		const merged = await this.#git(root, ["-c", `core.hooksPath=${devNull}`, "merge", "--ff-only", "-q", to]);
		return merged.code === 0;
	}

	/** The default branch refused the push: the run's branch goes up and one pull request into the default branch carries it. */
	async #landByPr(
		target: ShipTarget,
		item: ShipQueueItem,
		sha: string,
		reason: string,
	): Promise<Pick<ShipResult, "land" | "pushed">> {
		const { branch, remote } = target;
		const dest = target.landTo ?? target.baseBranch;
		const pushed = await this.#pushSha(target, sha, branch);
		if (pushed.code !== 0) throw new ShipFailure(brief(pushed.stderr), classifyPushFailure(pushed.stderr));
		await this.#trackUpstream(target, branch);
		const created = this.#landPr === null;
		if (created) {
			const { title, body } = await this.#deps.prText();
			try {
				const pr = await this.#deps.prCreate(target.root, { title, body, base: dest, head: branch, draft: false });
				this.#landPr = { url: pr.url };
			} catch (error) {
				// A pull request from this branch exists already (an earlier launch opened it): that one carries the work.
				const text = error instanceof Error ? error.message : String(error);
				if (!/already exists/i.test(text)) throw new ShipFailure(brief(text));
				const url = /https?:\/\/\S+\/pull\/\d+/.exec(text)?.[0];
				this.#landPr = url ? { url } : {};
			}
		}
		const url = this.#landPr?.url;
		item.detail = `${remote}/${dest} refused the push; ${remote}/${branch} carries it`;
		if (url) item.url = url;
		return { land: { kind: "pr", ...(url ? { url } : {}), created, reason }, pushed: true };
	}

	/** How far the default branch moved past the run, and what a merge of it would conflict in. */
	async #behind(root: string, tip: string, sha: string): Promise<LandOutcome & { kind: "behind" }> {
		const count = await this.#git(root, ["rev-list", "--count", `${sha}..${tip}`]);
		const ahead = count.code === 0 ? Number(count.stdout.toString("utf8").trim()) : null;
		const merged = await this.#git(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", sha, tip]);
		// Exit 0: a clean merge; 1: conflicts, the files after the tree line; anything else: git could not say.
		const conflicts =
			merged.code === 0
				? []
				: merged.code === 1
					? merged.stdout.toString("utf8").trim().split("\n").slice(1).filter(Boolean)
					: null;
		return { kind: "behind", ahead: Number.isFinite(ahead) ? ahead : null, conflicts };
	}

	async #push(target: ShipTarget, item: ShipQueueItem): Promise<Pick<ShipResult, "pushed">> {
		await this.#pushPinned(target, item);
		return { pushed: true };
	}

	/**
	 * The PR's head is the branch Push moves: the run's own, or the target it works toward (`pushTo`), the only branch
	 * Autopilot ever pushes. The work branch is not pushed for it. A head that is the base has nothing to compare.
	 */
	async #pr(target: ShipTarget, item: ShipQueueItem): Promise<Pick<ShipResult, "pushed">> {
		const { root, remote, baseBranch } = target;
		const head = target.pushTo ?? target.branch;
		if (head === baseBranch) {
			throw new ShipFailure(`${head} is the base branch: there is nothing to open a pull request for.`);
		}
		const sha = await this.#text(root, ["rev-parse", "HEAD"]);
		const tracked = await this.#git(root, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${head}`]);
		const onRemote = tracked.code === 0 && tracked.stdout.toString("utf8").trim() === sha;
		if (!onRemote) await this.#pushPinned(target, item);
		const { title, body } = await this.#deps.prText();
		const created = await this.#deps.prCreate(root, { title, body, base: baseBranch, head, draft: true });
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
