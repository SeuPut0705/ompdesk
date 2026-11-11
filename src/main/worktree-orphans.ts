/**
 * Orphaned worktrees: the linked worktrees OMPdesk made (`<worktree root>/gui-<name>-<hash7>`) that no open session
 * uses, each with what git says about its work, and the removal of the ones that hold nothing the user could lose.
 *
 * Local only: git runs on the computer this module runs on, which is where a paired device's tab answers too (local
 * handlers run where the tab's omp runs). The listing and the removal read the repository again each time; the
 * caller's word is never taken for a state. Nothing here forces: `worktree remove` without `--force`, and the branch
 * with `update-ref -d` against the tip judged landed.
 * `git worktree remove` deletes ignored files without asking, so every removal first runs the caller's `prepare`
 * (disk care's private archive of what no tool makes again, `src/main/disk/`), which may keep the worktree.
 *
 * The git side runs in the core process (`native/ompdesk/crates/core/src/git/orphans.rs`): which listed worktrees are
 * candidates, each one's state, and the removal's git steps. What stays here is main's: where the worktree root is
 * (omp's `git.worktree_location`) and its real path (fenced files, under the repository lock for a removal), the
 * folders open sessions use, the repository lock, the removal claim, the `prepare`, which states are removable and
 * the refusals.
 *
 * `sweepLandedWorktrees` runs the same rule over every repository with a worktree under stock's worktree root, as
 * part of disk care (`src/main/disk/care.ts`): what the Work tree view's cleanup would offer goes by itself, branch kept.
 */

import * as os from "node:os";
import * as path from "node:path";
import type {
	OrphanWorktreeState,
	RpcOrphanWorktree,
	RpcOrphanWorktreeRemoval,
	RpcOrphanWorktrees,
} from "../shared/rpc-types";
import type { WorktreeRemoval } from "./agent-control/branches";
import { KeepWorktree } from "./disk/saved-worktrees";
import { fs } from "./fenced-fs";
import { primaryRoot, repoRoot } from "./local/git/changes";
import { coreGit, withRepoLock } from "./local/git/exec";
import { stockWorktreeLocation } from "./local/git/worktree";
import { type BridgeClient, LocalCommandError } from "./local/types";
import { realFolder, withRemovalClaim } from "./worktree-removals";

export interface OrphanDeps {
	bridge: Pick<BridgeClient, "request">;
	/** The folders open sessions run in (tabs of this computer and tabs it hosts for paired devices). */
	openFolders(): readonly string[];
	/**
	 * Project folders this computer knows (the sidebar's list, removed ones included): a repository whose own
	 * `worktree.base` keeps its worktrees outside stock's global root is found through them.
	 */
	projects?(): readonly string[];
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

/**
 * Deadlines of the core requests (`coreGit`, in default-timeout gits one after another): the candidates are one
 * `git worktree list`; reading one worktree's state is the landing judgement (`branches.ts`) with its counts.
 */
const INSPECT_ROUNDS = 28;
/** A removal: the landing judgement, the worktree list, `worktree remove` and `update-ref`. */
const REMOVE_ROUNDS = 32;

interface Candidate {
	path: string;
	branch: string | null;
}

interface Candidates {
	primary: string;
	root: string;
	candidates: Candidate[];
	/** OMPdesk's worktrees an open session uses. */
	inUse: string[];
}

/** OMPdesk's linked worktrees of `cwd`'s repository, unread: one `git worktree list`. */
async function candidatesOf(cwd: string, deps: OrphanDeps, only?: string): Promise<Candidates> {
	if (!(await repoRoot(cwd))) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	const primary = await primaryRoot(cwd);
	const location = await stockWorktreeLocation(deps.bridge, primary);
	const root = await fs.realpath(location.root).catch(() => null);
	if (!root) return { primary, root: location.root, candidates: [], inUse: [] };
	const found = await coreGit<Pick<Candidates, "candidates" | "inUse">>(
		"git.orphanCandidates",
		{ primary, root, open: deps.openFolders().map(realFolder), only },
		1,
	);
	return { primary, root, ...found };
}

interface Listing {
	root: string;
	worktrees: RpcOrphanWorktree[];
	/** OMPdesk's worktrees an open session uses (left out of `worktrees`). */
	inUse: string[];
}

/** `only`: the real path of the one worktree to read (a removal re-reads just that one). */
async function listing(cwd: string, deps: OrphanDeps, only?: string): Promise<Listing> {
	const { primary, root, candidates, inUse } = await candidatesOf(cwd, deps, only);
	const worktrees =
		candidates.length === 0
			? []
			: await coreGit<RpcOrphanWorktree[]>(
					"git.orphanInspect",
					{ primary, candidates },
					candidates.length * INSPECT_ROUNDS,
				);
	return { root, worktrees, inUse };
}

/**
 * The real paths of the OMPdesk-made linked worktrees of `cwd`'s repository that no open session uses, without reading
 * them (no state): for a caller that reads each one itself.
 */
export async function orphanWorktreePaths(cwd: string, deps: OrphanDeps): Promise<string[]> {
	return (await candidatesOf(cwd, deps)).candidates.map(candidate => candidate.path);
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
 * the fresh listing is `not_orphan`, one that is not `landed` or `untouched` is `not_removable`. The core then checks
 * landed and clean once more and deletes the branch at the tip it judged (`branch-kept` when `keepBranch` asks or the
 * branch moved meanwhile).
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
			const result = await coreGit<WorktreeRemoval>(
				"git.removeOrphanWorktree",
				{ primary, path: entry.path, branch: entry.branch, keepBranch: options.keepBranch === true },
				REMOVE_ROUNDS,
			);
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
 * Stock's global worktree root (`worktree.base`) and the primary checkouts its `gui-` folders belong to, plus each
 * known project whose own `worktree.base` puts its worktrees in another folder holding `gui-` folders. A folder git
 * cannot place (a removed repository, a stray directory) holds nothing a rule may judge.
 */
export async function orphanRepositories(deps: OrphanDeps): Promise<{ root: string; repos: string[] }> {
	const { root } = await stockWorktreeLocation(deps.bridge, os.homedir());
	const repos = new Set<string>();
	for (const name of await guiFolders(root)) {
		const primary = await primaryRoot(path.join(root, name)).catch(() => null);
		if (primary) repos.add(realFolder(primary));
	}
	for (const folder of deps.projects?.() ?? []) {
		const primary = await primaryRoot(folder).catch(() => null);
		if (!primary || repos.has(realFolder(primary))) continue;
		const own = await stockWorktreeLocation(deps.bridge, primary).catch(() => null);
		if (!own || path.resolve(own.root) === path.resolve(root)) continue;
		if ((await guiFolders(own.root)).length > 0) repos.add(realFolder(primary));
	}
	return { root, repos: [...repos] };
}

async function guiFolders(root: string): Promise<string[]> {
	return (await fs.readdir(root).catch(() => [] as string[])).filter(name => name.startsWith("gui-"));
}

/** Every repository's orphaned worktrees under stock's worktree root, read once; a listing that failed says why. */
export interface OrphanListing {
	root: string;
	repos: { repo: string; worktrees: RpcOrphanWorktree[]; error?: string }[];
}

/** `listOrphanWorktrees` of each repository `orphanRepositories` finds (or already found: `found`). */
export async function listAllOrphans(
	deps: OrphanDeps,
	found?: { root: string; repos: readonly string[] },
): Promise<OrphanListing> {
	const { root, repos } = found ?? (await orphanRepositories(deps));
	const listed: OrphanListing["repos"] = [];
	for (const repo of repos) {
		listed.push(
			await listOrphanWorktrees(repo, deps).then(
				result => ({ repo, worktrees: result.worktrees }),
				(error: unknown) => ({
					repo,
					worktrees: [],
					error: error instanceof Error ? error.message : String(error),
				}),
			),
		);
	}
	return { root, repos: listed };
}

/**
 * Remove every orphaned worktree under stock's worktree root whose work is landed (or never begun), keeping its
 * branch: each repository of `orphanRepositories` listed and removed by `listOrphanWorktrees` / `removeOrphanWorktree`,
 * so in use, dirty, unlanded, locked, the primary checkout and anything outside the repository's own root stay.
 * `prepare` runs before each removal (disk care's archive). `dryRun` removes nothing and reports what would go.
 * `listed`: a listing the caller already read (`listAllOrphans`); it only picks candidates, since each removal reads
 * its worktree again under the repository lock and the removal claim.
 */
export async function sweepLandedWorktrees(
	deps: OrphanDeps,
	options: { dryRun?: boolean; prepare?: BeforeRemove; listed?: OrphanListing } = {},
): Promise<SweepReport> {
	const { root, repos } = options.listed ?? (await listAllOrphans(deps));
	const report: SweepReport = { root, removed: [], kept: [], failed: [] };
	for (const { repo, worktrees, error: listError } of repos) {
		if (listError !== undefined) report.failed.push({ path: repo, error: listError });
		for (const worktree of worktrees) {
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
