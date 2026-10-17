/**
 * What a folder belongs to, read from git: the project a linked worktree was cut from and what the worktree is
 * for. The checkouts OMPdesk makes (`~/.omp/wt/gui-<name>-<hash7>`) are named after a run or a hash, so showing the
 * folder name tells the person nothing; the origin is the main checkout's folder name (`git rev-parse
 * --git-common-dir`) and the branch says what the worktree is (`autopilot/<run>`, `omp/agent/<slug>`).
 * Dependency-free: main derives it (`main/local/git/origin.ts`), the renderer words it.
 */

export type WorktreeKind = "autopilot" | "agent" | "other";

export interface ProjectOrigin {
	/** The main checkout's folder name. */
	project: string;
	/** The main checkout's path. */
	root: string;
	/** Null for a main checkout; for a linked worktree what it is for. */
	worktree: { kind: WorktreeKind; branch: string | null; slug: string } | null;
}

/** The words a worktree's kind goes by (localized by the renderer). */
export interface WorktreeKindLabels {
	autopilot: string;
	agent: string;
}

export const AUTOPILOT_BRANCH_PREFIX = "autopilot/";
export const AGENT_BRANCH_PREFIX = "omp/agent/";

export function worktreeKindOf(branch: string | null): WorktreeKind {
	if (branch?.startsWith(AUTOPILOT_BRANCH_PREFIX)) return "autopilot";
	if (branch?.startsWith(AGENT_BRANCH_PREFIX)) return "agent";
	return "other";
}

/** Last segment of a path in either separator style, trailing separators ignored. */
export function pathBaseName(file: string): string {
	const parts = file.split(/[\\/]+/).filter(part => part !== "");
	return parts.at(-1) ?? file;
}

/**
 * A worktree folder name without the decoration OMPdesk adds (`gui-<name>-<hash7>`), for a folder git can no
 * longer tell about (a removed worktree).
 */
export function worktreeFolderSlug(folder: string): string {
	const name = pathBaseName(folder);
	const match = /^gui-(.+)-[0-9a-f]{7}$/.exec(name);
	return match?.[1] ?? name;
}

export interface OriginFacts {
	/** `git rev-parse --git-common-dir` (absolute). */
	commonDir: string;
	/** `git rev-parse --git-dir` (absolute). */
	gitDir: string;
	/** The current branch; null on a detached HEAD. */
	branch: string | null;
	/** The cwd's checkout (`--show-toplevel`), when it has one (not in a bare repository). */
	toplevel: string | null;
	/** The first entry of `git worktree list`: where the common dir does not say (a bare or relocated git dir). */
	primary: string | null;
}

/** The main checkout's path from the common git dir: `<main>/.git`, else the first listed worktree. */
function mainRoot(facts: OriginFacts): string | null {
	const common = facts.commonDir.replace(/[\\/]+$/, "");
	if (pathBaseName(common) === ".git") return common.slice(0, common.length - ".git".length).replace(/[\\/]+$/, "");
	return facts.primary;
}

/** Pure part of the lookup: the facts git gave for one folder, or null when they do not name a project. */
export function deriveProjectOrigin(facts: OriginFacts): ProjectOrigin | null {
	const root = mainRoot(facts);
	if (!root) return null;
	const project = pathBaseName(root).replace(/\.git$/, "") || pathBaseName(root);
	if (!project) return null;
	const same = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
	if (same(facts.gitDir, facts.commonDir)) return { project, root, worktree: null };
	return {
		project,
		root,
		worktree: {
			kind: worktreeKindOf(facts.branch),
			branch: facts.branch,
			slug: worktreeFolderSlug(facts.toplevel ?? facts.gitDir),
		},
	};
}

/** What the worktree is called beside its project: the kind's word, the child's title, or the plain branch. */
export function worktreeLabel(origin: ProjectOrigin, labels: WorktreeKindLabels, title?: string | null): string | null {
	const worktree = origin.worktree;
	if (!worktree) return null;
	if (worktree.kind === "autopilot") return labels.autopilot;
	if (worktree.kind === "agent") return title?.trim() || labels.agent;
	return worktree.branch ?? worktree.slug;
}

/** `acme-web · Autopilot`: one line for a title bar, a board or a list; a main checkout is its folder name. */
export function projectDisplayName(
	origin: ProjectOrigin | null | undefined,
	fallback: string,
	labels: WorktreeKindLabels,
	title?: string | null,
): string {
	if (!origin) return fallback;
	const label = worktreeLabel(origin, labels, title);
	return label ? `${origin.project} · ${label}` : fallback;
}
