/**
 * Orphaned worktrees: the linked worktrees OMPdesk made (`<worktree root>/gui-<name>-<hash7>`) that no open session
 * uses, each with what git says about its work, and the removal of the ones that hold nothing the user could lose.
 *
 * Local only: git runs on the computer this module runs on, which is where a paired device's tab answers too (local
 * handlers run where the tab's omp runs). The listing and the removal read the repository again each time; the
 * caller's word is never taken for a state. Nothing here forces: `worktree remove` without `--force`, `branch -d`.
 * `git worktree remove` deletes ignored files without asking, so every removal first runs the caller's `prepare`
 * (disk care's private archive of what no tool makes again, `src/main/disk/`), which may keep the worktree.
 *
 * `sweepLandedWorktrees` runs the same rule over every repository with a worktree under stock's worktree root, as
 * part of disk care (`src/main/disk/care.ts`): what the Work tree view's cleanup would offer goes by itself, branch kept.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	OrphanWorktreeState,
	RpcOrphanWorktree,
	RpcOrphanWorktreeRemoval,
	RpcOrphanWorktrees,
} from "../shared/rpc-types";
import { removeLinkedWorktree, removeSafeWorktree, worktreeStanding } from "./agent-control/branches";
import { KeepWorktree } from "./disk/saved-worktrees";
import { primaryRoot, repoRoot } from "./local/git/changes";
import { git, withRepoLock } from "./local/git/exec";
import { isInside } from "./local/git/parse";
import { stockWorktreeLocation } from "./local/git/worktree";
import { type BridgeClient, LocalCommandError } from "./local/types";
import { realFolder, withRemovalClaim } from "./worktree-removals";

export interface OrphanDeps {
	bridge: Pick<BridgeClient, "request">;
	/** The folders open sessions run in (tabs of this computer and tabs it hosts for paired devices). */
	openFolders(): readonly string[];
}

let openFoldersSource: (() => readonly string[]) | null = null;

/**
 * Where the local handlers (`get_orphan_worktrees`, `remove_orphan_worktree`) learn which folders sessions have open:
 * `index.ts` sets it once at startup. A setter, not a handler-context field, because a `LocalCommandContext` is built
 * per sidecar and knows only its own tab, while an orphan is one that no tab of the whole app holds.
 */
export function setOpenFoldersSource(source: () => readonly string[]): void {
	openFoldersSource = source;
}

/** The registered source; without one every worktree would look unused, so the commands fail instead. */
export function sessionOpenFolders(): readonly string[] {
	if (!openFoldersSource)
		throw new LocalCommandError("OMPdesk is still starting; try again in a moment.", "not_ready");
	return openFoldersSource();
}

/** What `classifyOrphan` reads of one worktree. */
export interface OrphanFacts {
	/** HEAD is detached: the worktree has no branch. */
	detached: boolean;
	/** Tracked changes plus untracked files. */
	dirtyFiles: number;
	/** The branch has a commit of its own (tip differs from where it was created). */
	hasWork: boolean;
	/** The HEAD's work is in the base's HEAD or upstream, by ancestry or by content. */
	landed: boolean;
	/** `landed` by content (squash merge, rebase, cherry-pick). */
	squashed: boolean;
	/** Commits of its own against the base (0 once landed). */
	commitsAhead: number;
}

type Verdict = Pick<RpcOrphanWorktree, "state" | "commitsAhead"> & { squashed?: true };

/**
 * First matching row wins. A detached HEAD never counts commits (`commitsAhead` 0) and has no creation point, so it
 * is never `untouched`; `untouched` needs the base to hold the tip too, so a branch whose reflog is gone (it then
 * reads as no work) cannot hide unmerged commits.
 */
const ORPHAN_RULES: ReadonlyArray<{ when: (facts: OrphanFacts) => boolean; verdict: (facts: OrphanFacts) => Verdict }> =
	[
		{
			when: f => f.dirtyFiles > 0,
			verdict: f => ({ state: "dirty", commitsAhead: f.detached ? 0 : f.commitsAhead }),
		},
		{ when: f => f.detached && !f.landed, verdict: () => ({ state: "unlanded", commitsAhead: 0 }) },
		{ when: f => !f.detached && !f.hasWork && f.landed, verdict: () => ({ state: "untouched", commitsAhead: 0 }) },
		{
			when: f => f.landed,
			verdict: f => ({ state: "landed", commitsAhead: 0, ...(f.squashed ? { squashed: true as const } : {}) }),
		},
		{ when: () => true, verdict: f => ({ state: "unlanded", commitsAhead: f.commitsAhead }) },
	];

/** Pure: the state of an orphan from the facts git gave. Dirty wins over every other state. */
export function classifyOrphan(facts: OrphanFacts): Verdict {
	const rule = ORPHAN_RULES.find(candidate => candidate.when(facts));
	// The last row matches everything.
	return rule ? rule.verdict(facts) : { state: "unlanded", commitsAhead: facts.commitsAhead };
}

interface Listed {
	path: string;
	branch: string | null;
	locked: boolean;
}

/** `git worktree list --porcelain -z`: NUL-separated fields, a record per worktree starting at its `worktree` field. */
function parseWorktreeList(output: string): Listed[] {
	const records: Listed[] = [];
	let current: Listed | null = null;
	for (const field of output.split("\0")) {
		if (field.startsWith("worktree ")) {
			current = { path: field.slice("worktree ".length), branch: null, locked: false };
			records.push(current);
		} else if (current && field.startsWith("branch ")) {
			current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (current && (field === "locked" || field.startsWith("locked "))) {
			current.locked = true;
		}
	}
	return records;
}

/** How many worktrees are read at once: each read is a handful of git processes. */
const INSPECT_CONCURRENCY = 4;

interface Listing {
	primary: string;
	root: string;
	worktrees: RpcOrphanWorktree[];
	/** OMPdesk's worktrees an open session uses (left out of `worktrees`). */
	inUse: string[];
}

/** `only`: the real path of the one worktree to read (a removal re-reads just that one). */
async function listing(cwd: string, deps: OrphanDeps, only?: string): Promise<Listing> {
	if (!(await repoRoot(cwd))) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	const primary = await primaryRoot(cwd);
	const location = await stockWorktreeLocation(deps.bridge, primary);
	const root = await fs.realpath(location.root).catch(() => null);
	if (!root) return { primary, root: location.root, worktrees: [], inUse: [] };

	const [, ...linked] = parseWorktreeList(await git(primary, ["worktree", "list", "--porcelain", "-z"]));
	const open = deps.openFolders().map(realFolder);
	const candidates: { path: string; branch: string | null }[] = [];
	const inUse: string[] = [];
	for (const entry of linked) {
		if (entry.locked) continue;
		const real = await fs.realpath(entry.path).catch(() => null);
		if (!real || !isInside(root, real) || !path.basename(real).startsWith("gui-")) continue;
		if (only !== undefined && real !== only) continue;
		if (open.some(folder => folder === real || isInside(real, folder))) {
			inUse.push(real);
			continue;
		}
		candidates.push({ path: real, branch: entry.branch });
	}

	const inspected: (RpcOrphanWorktree | null)[] = new Array(candidates.length).fill(null);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < candidates.length) {
			const index = next++;
			const candidate = candidates[index];
			// A worktree git cannot read (a broken checkout) is left out: nothing about it is known to be safe.
			inspected[index] = candidate ? await inspect(primary, candidate).catch(() => null) : null;
		}
	};
	await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, candidates.length) }, worker));
	const worktrees = inspected
		.filter((worktree): worktree is RpcOrphanWorktree => worktree !== null)
		.sort((a, b) => b.modifiedAt - a.modifiedAt);
	return { primary, root, worktrees, inUse };
}

async function inspect(
	primary: string,
	candidate: { path: string; branch: string | null },
): Promise<RpcOrphanWorktree> {
	const [standing, committed] = await Promise.all([
		worktreeStanding({ path: candidate.path, branch: candidate.branch, baseCwd: primary }),
		git(candidate.path, ["log", "-1", "--format=%ct", "HEAD"]),
	]);
	const verdict = classifyOrphan({
		detached: candidate.branch === null,
		dirtyFiles: standing.dirtyFiles,
		hasWork: standing.hasWork,
		landed: standing.landed,
		squashed: standing.squashed === true,
		commitsAhead: standing.commitsAhead,
	});
	return {
		path: candidate.path,
		branch: candidate.branch,
		repo: primary,
		state: verdict.state,
		...(verdict.squashed ? { squashed: true as const } : {}),
		commitsAhead: verdict.commitsAhead,
		dirtyFiles: standing.dirtyFiles,
		modifiedAt: (Number(committed.trim()) || 0) * 1000,
	};
}

/** The OMPdesk-made linked worktrees of `cwd`'s repository that no open session uses, newest commit first. */
export async function listOrphanWorktrees(cwd: string, deps: OrphanDeps): Promise<RpcOrphanWorktrees> {
	const { root, worktrees } = await listing(cwd, deps);
	return { root, worktrees };
}

const REMOVABLE: readonly OrphanWorktreeState[] = ["landed", "untouched"];

/**
 * Runs inside the removal claim right before git removes the worktree; may throw `KeepWorktree` to keep it. The
 * function it returns hears whether the folder went.
 */
export type BeforeRemove = (worktree: RpcOrphanWorktree) => Promise<(removed: boolean) => Promise<void>>;

/**
 * Remove one orphaned worktree whose work is landed (or never begun), after reading it again: a path that is not in
 * the fresh listing is `not_orphan`, one that is not `landed` or `untouched` is `not_removable`. `removeSafeWorktree`
 * then checks landed and clean once more, and the branch goes only with `branch -d` (`branch-kept` when a squash merge
 * leaves it unmerged by ancestry).
 */
export async function removeOrphanWorktree(
	cwd: string,
	worktreePath: string,
	deps: OrphanDeps,
	options: { keepBranch?: boolean; prepare?: BeforeRemove } = {},
): Promise<RpcOrphanWorktreeRemoval> {
	if (!(await repoRoot(cwd))) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	const primary = await primaryRoot(cwd);
	return withRepoLock(primary, async () => {
		const wanted = worktreePath ? realFolder(worktreePath) : "";
		const { worktrees, inUse } = await listing(cwd, deps, wanted);
		const entry = wanted ? worktrees.find(worktree => worktree.path === wanted) : undefined;
		if (!entry) {
			if (wanted && inUse.includes(wanted))
				throw new LocalCommandError(`${wanted} is in use by an open session; nothing was removed.`, "in_use");
			throw new LocalCommandError(
				`${worktreePath || "(no path)"} is not an orphaned worktree of this repository: it is in use, outside the worktree root, not made by OMPdesk, or already gone.`,
				"not_orphan",
			);
		}
		if (!REMOVABLE.includes(entry.state)) {
			throw new LocalCommandError(
				`${entry.path} is ${entry.state}${entry.state === "dirty" ? ` (${entry.dirtyFiles} uncommitted or untracked file(s))` : entry.state === "unlanded" ? ` (${entry.commitsAhead} commit(s) nothing holds)` : ""}; only a landed or untouched worktree is removed.`,
				"not_removable",
			);
		}
		// The listing above read the open sessions before its git awaits: a tab may have opened on this worktree since.
		// Read them again and claim the folder in one step, so no tab starts in it until git is done.
		const removal = await withRemovalClaim(entry.path, deps.openFolders, async () => {
			let settle: (removed: boolean) => Promise<void> = async () => {};
			try {
				if (options.prepare) settle = await options.prepare(entry);
			} catch (error) {
				if (error instanceof KeepWorktree)
					throw new LocalCommandError(`${entry.path} was kept: ${error.message}.`, "not_removable");
				throw error;
			}
			const result =
				entry.branch === null
					? (await removeLinkedWorktree(primary, entry.path))
						? ("removed" as const)
						: null
					: await removeSafeWorktree({ path: entry.path, branch: entry.branch, baseCwd: primary }, options);
			await settle(result !== null);
			return result;
		});
		if (!removal) {
			throw new LocalCommandError(
				`${entry.path} changed or git refused to remove it; nothing was removed.`,
				"not_removable",
			);
		}
		return { removal };
	});
}

/** One worktree the sweep removed (or, in a dry run, would remove), or kept. */
export interface SweptWorktree {
	path: string;
	repo: string;
	branch: string | null;
	state: OrphanWorktreeState;
	squashed?: true;
	/** Why a removable one was kept after all (its `prepare` or git refused). */
	reason?: string;
}

export interface SweepReport {
	root: string;
	removed: SweptWorktree[];
	/** Orphans the rule keeps: uncommitted or untracked files, commits nothing else holds, or a `prepare` refusal. */
	kept: SweptWorktree[];
	failed: { path: string; error: string }[];
}

/**
 * Stock's global worktree root (`worktree.base`; a repository's own base is read per repository) and the primary
 * checkouts its `gui-` folders belong to. A folder git cannot place (a removed repository, a stray directory) holds
 * nothing a rule may judge.
 */
export async function orphanRepositories(deps: OrphanDeps): Promise<{ root: string; repos: string[] }> {
	const { root } = await stockWorktreeLocation(deps.bridge, os.homedir());
	const repos = new Set<string>();
	for (const name of await fs.readdir(root).catch(() => [] as string[])) {
		if (!name.startsWith("gui-")) continue;
		const primary = await primaryRoot(path.join(root, name)).catch(() => null);
		if (primary) repos.add(realFolder(primary));
	}
	return { root, repos: [...repos] };
}

/**
 * Remove every orphaned worktree under stock's worktree root whose work is landed (or never begun), keeping its
 * branch: each repository of `orphanRepositories` listed and removed by `listOrphanWorktrees` / `removeOrphanWorktree`,
 * so in use, dirty, unlanded, locked, the primary checkout and anything outside the repository's own root stay.
 * `prepare` runs before each removal (disk care's archive). `dryRun` removes nothing and reports what would go.
 */
export async function sweepLandedWorktrees(
	deps: OrphanDeps,
	options: { dryRun?: boolean; prepare?: BeforeRemove } = {},
): Promise<SweepReport> {
	const { root, repos } = await orphanRepositories(deps);
	const report: SweepReport = { root, removed: [], kept: [], failed: [] };
	for (const repo of repos) {
		const listed = await listOrphanWorktrees(repo, deps).catch((error: unknown) => {
			report.failed.push({ path: repo, error: error instanceof Error ? error.message : String(error) });
			return null;
		});
		for (const worktree of listed?.worktrees ?? []) {
			const swept: SweptWorktree = {
				path: worktree.path,
				repo: worktree.repo,
				branch: worktree.branch,
				state: worktree.state,
				...(worktree.squashed ? { squashed: true as const } : {}),
			};
			if (!REMOVABLE.includes(worktree.state)) {
				report.kept.push(swept);
				continue;
			}
			if (options.dryRun) {
				report.removed.push(swept);
				continue;
			}
			try {
				await removeOrphanWorktree(repo, worktree.path, deps, { keepBranch: true, prepare: options.prepare });
				report.removed.push(swept);
			} catch (error) {
				if (error instanceof LocalCommandError && error.code === "not_removable")
					report.kept.push({ ...swept, reason: error.message });
				else
					report.failed.push({
						path: worktree.path,
						error: error instanceof Error ? error.message : String(error),
					});
			}
		}
	}
	return report;
}
