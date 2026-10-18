/**
 * Which branch an Autopilot run commits on and pushes to, as pure rules (the sheet and main share them):
 * the picker's list, what a run may not take, the warning for the default branch, the name a new branch gets and
 * the folder slug and run id derived from the choice. Git itself is read in `src/main/autopilot-branches.ts`.
 */
import {
	AUTOPILOT_BRANCH_PREFIX,
	type AutopilotBranchChoice,
	type AutopilotBranchEntry,
} from "../../resources/gui-bridge/modes/autopilot-contracts";

/** What `git for-each-ref` and `git worktree list` said, already split. */
export interface BranchFacts {
	/** Local branch names. */
	locals: readonly string[];
	/** Branch names on the ship remote (without the remote's name), `HEAD` excluded. */
	remotes: readonly string[];
	/** Local branch → the worktree that has it checked out (the user's own folder included). */
	worktrees: Readonly<Record<string, string>>;
	/** The branch the user's own folder is on; null when detached. */
	current: string | null;
	defaultBranch: string | null;
}

/** `git worktree list --porcelain` → branch → path (detached and bare entries have no branch). */
export function parseWorktreeBranches(porcelain: string): Record<string, string> {
	const out: Record<string, string> = {};
	let path: string | null = null;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line.startsWith("branch refs/heads/") && path !== null)
			out[line.slice("branch refs/heads/".length)] = path;
		else if (line === "") path = null;
	}
	return out;
}

/**
 * The picker's rows: the default branch first, then the user's own folder's branch, then the rest in the order
 * git gave (most recent first). A branch that is both local and on the remote is one row.
 */
export function branchEntries(facts: BranchFacts): AutopilotBranchEntry[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const name of [...facts.locals, ...facts.remotes]) {
		if (name === "HEAD" || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	const rank = (name: string) => (name === facts.defaultBranch ? 0 : name === facts.current ? 1 : 2);
	return names
		.map((name, order) => ({ name, order }))
		.sort((a, b) => rank(a.name) - rank(b.name) || a.order - b.order)
		.map(({ name }) => {
			const checkedOutAt = facts.worktrees[name];
			return {
				name,
				local: facts.locals.includes(name),
				remote: facts.remotes.includes(name),
				default: name === facts.defaultBranch,
				current: name === facts.current,
				...(checkedOutAt ? { checkedOutAt } : {}),
			};
		});
}

/** The default branch: the remote's HEAD when it says, else `main` or `master` when one exists. */
export function pickDefaultBranch(remoteHead: string | null, names: readonly string[]): string | null {
	if (remoteHead) return remoteHead;
	return ["main", "master"].find(name => names.includes(name)) ?? null;
}

/** A branch name git accepts (`git check-ref-format --branch`, without the shell-out the sheet cannot do). */
export function isValidBranchName(name: string): boolean {
	if (!name || name.length > 200 || name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
	if (name.endsWith(".") || name.endsWith(".lock") || name === "@" || name.includes("@{")) return false;
	if (/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|\/\/|\/\./.test(name)) return false;
	return !name.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"));
}

/** `autopilot/<date>`, or `autopilot/<date>-2`, `-3`, … when a branch of that name exists. */
export function suggestBranchName(date: string, taken: ReadonlySet<string>): string {
	let name = `${AUTOPILOT_BRANCH_PREFIX}${date}`;
	for (let suffix = 2; taken.has(name); suffix++) name = `${AUTOPILOT_BRANCH_PREFIX}${date}-${suffix}`;
	return name;
}

export type BranchProblem = { code: "invalid_name" } | { code: "exists" } | { code: "missing" };

/** Why the run cannot take `choice`, or null (a branch another worktree holds is no problem: see `viaWorkBranch`). */
export function branchProblem(
	choice: AutopilotBranchChoice,
	entries: readonly AutopilotBranchEntry[],
): BranchProblem | null {
	if (choice.kind === "new") {
		if (choice.name === undefined) return null;
		if (!isValidBranchName(choice.name)) return { code: "invalid_name" };
		return entries.some(entry => entry.name === choice.name) ? { code: "exists" } : null;
	}
	const entry = entries.find(item => item.name === choice.name);
	return !entry || (!entry.local && !entry.remote) ? { code: "missing" } : null;
}

/** Whether a run on this branch commits straight onto the default branch (the sheet warns; Push then pushes to it). */
export function isDefaultBranchChoice(
	choice: AutopilotBranchChoice,
	entries: readonly AutopilotBranchEntry[],
): boolean {
	return choice.kind === "existing" && entries.some(entry => entry.default && entry.name === choice.name);
}

/**
 * The branch Push pushes to when the run cannot work on it itself: another worktree (usually the user's own folder on
 * `main`) has it checked out, so the run works on its own branch cut from it and pushes `HEAD:<target>`.
 */
export function viaWorkBranch(choice: AutopilotBranchChoice, entries: readonly AutopilotBranchEntry[]): string | null {
	if (choice.kind !== "existing") return null;
	const entry = entries.find(item => item.name === choice.name);
	return entry?.checkedOutAt ? entry.name : null;
}

/** How `worktree_create` makes the checkout for `choice`: a new branch, a local one, or one tracking the remote. */
export function worktreeModeFor(
	choice: AutopilotBranchChoice,
	entries: readonly AutopilotBranchEntry[],
): "new" | "local" | "remote" {
	if (choice.kind === "new" || viaWorkBranch(choice, entries)) return "new";
	return entries.find(entry => entry.name === choice.name)?.local ? "local" : "remote";
}

/** The folder slug of a branch (`worktree_create`'s `name`: 1–41 chars of [a-z0-9-]); `fallback` when nothing is left. */
export function branchSlug(branch: string, fallback: string): string {
	const slug = branch
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 41)
		.replace(/-+$/g, "");
	return slug || fallback;
}

/**
 * The run's id (children are `autopilot/<run>-c<N>-<area>`): the part after `autopilot/` for a branch there, else
 * the date. Never holds a `/` (a branch of that name and a directory of it cannot both exist).
 */
export function runIdFor(branch: string, date: string): string {
	if (!branch.startsWith(AUTOPILOT_BRANCH_PREFIX)) return date;
	const id = branch
		.slice(AUTOPILOT_BRANCH_PREFIX.length)
		.replace(/\/+/g, "-")
		.replace(/^-+|-+$/g, "");
	return id || date;
}

/** The remembered choice of one repository from the `autopilotBranch` pref, tolerating a hand-edited value. */
export function lastChoiceOf(pref: unknown, repo: string): AutopilotBranchChoice | null {
	if (typeof pref !== "object" || pref === null) return null;
	return parseChoice((pref as Record<string, unknown>)[repo]);
}

export function parseChoice(value: unknown): AutopilotBranchChoice | null {
	if (typeof value !== "object" || value === null) return null;
	const { kind, name, remote } = value as Record<string, unknown>;
	if (kind === "new") {
		return typeof name === "string" && name ? { kind, name } : { kind };
	}
	if (kind === "existing" && typeof name === "string" && name) {
		return { kind, name, ...(typeof remote === "string" && remote ? { remote } : {}) };
	}
	return null;
}

/** The pref value as stored: only well-formed choices, keyed by repository. */
export function validBranchPref(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.entries(value).every(
		([repo, choice]) => repo.length > 0 && repo.length < 1024 && parseChoice(choice) !== null,
	);
}

/** What the sheet starts on: the remembered choice while it is still usable, else a new branch. */
export function initialChoice(
	last: AutopilotBranchChoice | undefined,
	entries: readonly AutopilotBranchEntry[],
): AutopilotBranchChoice {
	if (last && branchProblem(last, entries) === null) {
		return last.kind === "new" ? { kind: "new", ...(last.name ? { name: last.name } : {}) } : last;
	}
	return { kind: "new" };
}
