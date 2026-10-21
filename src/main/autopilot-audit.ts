/**
 * Autopilot's git audit (the required second defence behind the bridge's `tool_call` guard, which cannot
 * see through `sh -c`, interpreters or a subprocess of `eval`): main snapshots the repository's refs, its
 * `config` and the default checkout's HEAD around each cycle and judges the difference. Moves the run is
 * entitled to are the own branch, the children's branches, what the ShipRunner journaled and, in the
 * release scope, the default branch on the remote and new `v*` tags.
 *
 * A remote-tracking ref that only a fetch moved is not the agent's (the reflog says `fetch`). Neither is one that moved
 * forward or was created without holding any commit the run's branch made this cycle: in a repository other sessions
 * work in, their pushes update the shared remote-tracking refs (the reflog says `update by push`), and that paused the
 * run as its own. A deleted or rewound remote-tracking ref still counts, whoever did it. A user's own commit on a local
 * branch cannot be told from the agent's, so it counts, like the design says.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { git, gitRaw } from "./local/git/exec";

export interface AuditSnapshot {
	/** Every ref: name → object id. */
	refs: Record<string, string>;
	/** SHA-256 of the repository's `config` file (a `git config` write, a remote added or re-pointed). */
	config: string | null;
	/** The default checkout's HEAD: its branch (or `detached`) and commit. */
	checkout: string | null;
}

export interface AuditScope {
	/** The run's own branch, e.g. `autopilot/2026-10-17`. */
	branch: string;
	/** Branches the children of this run were given. */
	childBranches: readonly string[];
	remote: string;
	defaultBranch: string;
	/** The release scope is open: the default branch on the remote and new `v*` tags may move. */
	release: boolean;
	/** Exact refs the ShipRunner journaled since the snapshot. */
	expectedRefs: readonly string[];
	/** The ShipRunner merged into the default checkout since the snapshot. */
	checkoutMayMove: boolean;
	/** The ShipRunner pushed since the snapshot (it sets the branch's upstream, a `git config` write). */
	configMayChange: boolean;
}

export interface RefChange {
	ref: string;
	from: string | null;
	to: string | null;
}

export interface AuditViolation {
	kind: "ref" | "history" | "config" | "checkout";
	detail: string;
}

const REFS_TIMEOUT_MS = 30_000;

/** Refs created, moved or deleted between two snapshots, sorted by name. */
export function diffRefs(before: Record<string, string>, after: Record<string, string>): RefChange[] {
	const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const changes: RefChange[] = [];
	for (const ref of names) {
		const from = before[ref] ?? null;
		const to = after[ref] ?? null;
		if (from !== to) changes.push({ ref, from, to });
	}
	return changes;
}

/**
 * Every ref and the commit it names. A symbolic ref (`refs/remotes/origin/HEAD`, which a clone or `remote set-head`
 * makes) is left out: it moves whenever its target does, and the target is diffed itself, so a fetch that moved
 * `origin/main` read as "refs/remotes/origin/HEAD moved" with no fetch in its own reflog and paused the run.
 */
async function readRefs(root: string): Promise<Record<string, string>> {
	const out = await git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"], {
		timeoutMs: REFS_TIMEOUT_MS,
	});
	const refs: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const [name, oid, symref] = line.split("\0");
		if (name && oid && !symref) refs[name] = oid;
	}
	return refs;
}

async function readConfigHash(root: string): Promise<string | null> {
	const common = (await gitRaw(root, ["rev-parse", "--git-common-dir"], { timeoutMs: REFS_TIMEOUT_MS })).stdout
		.toString("utf8")
		.trim();
	if (!common) return null;
	try {
		const text = await readFile(join(isAbsolute(common) ? common : join(root, common), "config"));
		return createHash("sha256").update(text).digest("hex");
	} catch {
		return null;
	}
}

async function readCheckout(root: string): Promise<string | null> {
	const head = await gitRaw(root, ["rev-parse", "HEAD"], { timeoutMs: REFS_TIMEOUT_MS });
	if (head.code !== 0) return null;
	const branch = await gitRaw(root, ["symbolic-ref", "-q", "HEAD"], { timeoutMs: REFS_TIMEOUT_MS });
	return `${branch.code === 0 ? branch.stdout.toString("utf8").trim() : "detached"} ${head.stdout.toString("utf8").trim()}`;
}

/** Snapshot the repository `root` belongs to; `checkoutRoot` is the user's default checkout of it. */
export async function takeSnapshot(root: string, checkoutRoot?: string): Promise<AuditSnapshot> {
	const [refs, config, checkout] = await Promise.all([
		readRefs(root),
		readConfigHash(root),
		checkoutRoot ? readCheckout(checkoutRoot) : Promise.resolve(null),
	]);
	return { refs, config, checkout };
}

/** Whether the last reflog entry of `ref` is a fetch (the user's or the app's), not a push. */
async function movedByFetch(root: string, ref: string): Promise<boolean> {
	const log = await gitRaw(root, ["reflog", "show", "--format=%gs", "-n", "1", ref], { timeoutMs: REFS_TIMEOUT_MS });
	if (log.code !== 0) return false;
	return /^(fetch|pull)\b/.test(log.stdout.toString("utf8").trim());
}

/**
 * The run's own commits: those on its branch's first-parent line that the default branch on the remote did not hold
 * when the cycle began (a merge brings others' commits; first parents are the run's). Null when git cannot say, which
 * counts as the run's (an empty answer is never evidence that another session acted).
 */
async function ownCommits(root: string, tip: string | undefined, base: string | undefined): Promise<string[] | null> {
	if (!tip) return [];
	const range = await gitRaw(root, ["rev-list", "--first-parent", tip, ...(base ? ["--not", base] : [])], {
		timeoutMs: REFS_TIMEOUT_MS,
	});
	return range.code === 0 ? range.stdout.toString("utf8").split("\n").filter(Boolean) : null;
}

/** A ref another session moved: created or moved forward, holding none of the run's own commits. */
async function movedByOthers(root: string, change: RefChange, own: readonly string[] | null): Promise<boolean> {
	if (change.to === null || own === null) return false;
	if (change.from !== null) {
		const forward = await gitRaw(root, ["merge-base", "--is-ancestor", change.from, change.to], {
			timeoutMs: REFS_TIMEOUT_MS,
		});
		if (forward.code !== 0) return false;
	}
	for (const sha of own) {
		const holds = await gitRaw(root, ["merge-base", "--is-ancestor", sha, change.to], { timeoutMs: REFS_TIMEOUT_MS });
		if (holds.code === 0) return false;
	}
	return true;
}

/**
 * Branches checked out in a worktree of the repository other than the run's own: another session's worktree branch or
 * the user's own checkout. The agent's `git branch x` is checked out nowhere, so it still counts.
 */
async function otherWorktreeBranches(root: string): Promise<Set<string>> {
	const list = await gitRaw(root, ["worktree", "list", "--porcelain"], { timeoutMs: REFS_TIMEOUT_MS });
	if (list.code !== 0) return new Set();
	const self = await realpath(root).catch(() => root);
	const branches = new Set<string>();
	for (const block of list.stdout.toString("utf8").split("\n\n")) {
		const tree = /^worktree (.+)$/m.exec(block)?.[1];
		const branch = /^branch (.+)$/m.exec(block)?.[1];
		if (!tree || !branch) continue;
		if ((await realpath(tree).catch(() => tree)) !== self) branches.add(branch);
	}
	return branches;
}

function allowed(change: RefChange, scope: AuditScope): boolean {
	const { ref } = change;
	if (scope.expectedRefs.includes(ref)) return true;
	if (ref === `refs/heads/${scope.branch}`) return change.to !== null;
	if (scope.childBranches.some(name => ref === `refs/heads/${name}`)) return true;
	// `git stash` is not guarded against creating one; dropping is (the guard bans `stash drop|clear`).
	if (ref === "refs/stash") return true;
	if (!scope.release) return false;
	if (ref === `refs/remotes/${scope.remote}/${scope.defaultBranch}`) return change.to !== null;
	return /^refs\/tags\/v[^/]+$/.test(ref) && change.from === null && change.to !== null;
}

function describeChange(change: RefChange): string {
	const verb = change.from === null ? "created" : change.to === null ? "deleted" : "moved";
	return `${change.ref} ${verb}`;
}

/**
 * What the cycle between `before` and `after` did outside its entitlement. `root` is the run's worktree
 * (any checkout of the repository answers the ancestry question).
 */
export async function auditCycle(
	root: string,
	before: AuditSnapshot,
	after: AuditSnapshot,
	scope: AuditScope,
): Promise<AuditViolation[]> {
	const violations: AuditViolation[] = [];
	const own = `refs/heads/${scope.branch}`;
	let mine: string[] | null | undefined;
	const theirs = async (change: RefChange) => {
		if (mine === undefined) {
			mine = await ownCommits(
				root,
				after.refs[own],
				before.refs[`refs/remotes/${scope.remote}/${scope.defaultBranch}`],
			);
		}
		return movedByOthers(root, change, mine);
	};
	let others: Set<string> | undefined;
	for (const change of diffRefs(before.refs, after.refs)) {
		if (allowed(change, scope)) continue;
		if (change.to !== null && change.ref.startsWith("refs/remotes/")) {
			if ((await movedByFetch(root, change.ref)) || (await theirs(change))) continue;
		} else if (change.to !== null && change.ref.startsWith("refs/heads/")) {
			others ??= await otherWorktreeBranches(root);
			if (others.has(change.ref) && (await theirs(change))) continue;
		}
		violations.push({ kind: "ref", detail: describeChange(change) });
	}
	const oldTip = before.refs[own];
	const newTip = after.refs[own];
	if (oldTip && !newTip) violations.push({ kind: "history", detail: `${own} deleted` });
	else if (oldTip && newTip && oldTip !== newTip) {
		const ancestor = await gitRaw(root, ["merge-base", "--is-ancestor", oldTip, newTip], {
			timeoutMs: REFS_TIMEOUT_MS,
		});
		if (ancestor.code !== 0) {
			violations.push({
				kind: "history",
				detail: `${own} no longer contains its previous tip ${oldTip.slice(0, 9)}`,
			});
		}
	}
	if (before.config !== null && after.config !== before.config && !scope.configMayChange) {
		violations.push({ kind: "config", detail: "the repository's git config changed" });
	}
	if (before.checkout !== null && after.checkout !== before.checkout && !scope.checkoutMayMove) {
		// The same branch moved forward without the run's commits is the user's own pull or commit there.
		const [branchBefore, from] = before.checkout.split(" ");
		const [branchAfter, to] = (after.checkout ?? "").split(" ");
		const pulled =
			branchBefore === branchAfter &&
			branchBefore !== "detached" &&
			from !== undefined &&
			to !== undefined &&
			(await theirs({ ref: branchBefore ?? "", from, to }));
		if (!pulled) {
			violations.push({
				kind: "checkout",
				detail: `the default checkout moved (${before.checkout} → ${after.checkout})`,
			});
		}
	}
	return violations;
}
