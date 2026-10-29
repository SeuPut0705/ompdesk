/**
 * The projects a device's sidebar lists, kept apart from its sessions (as Codex desktop keeps its saved workspace
 * roots apart from its threads): a project stays listed when its last session goes, and leaves only by the person's
 * "Remove from sidebar", which deletes no file and no session. Each computer keeps its own list (a paired host's
 * sidebar section shows the host's), in main's prefs under `SIDEBAR_PROJECTS_PREF`.
 *
 * A project is a folder: a main checkout, a subfolder of one, or a plain folder. A linked worktree is never one; it
 * names the project it was cut from (main resolves it before a path is stored).
 */

import { isOmpdeskWorktreeFolder, type WorktreeKind } from "./project-origin";

export const SIDEBAR_PROJECTS_COMMAND = "sidebar-projects:command";
/** Pushed on every change: an `IpcSidebarProjects` (`device` unset for this computer's own list). */
export const SIDEBAR_PROJECTS_STATE = "sidebar-projects:state";
export const SIDEBAR_PROJECTS_PREF = "sidebarProjects";

export interface SidebarProject {
	path: string;
	/** When it entered the list (ms; a folder found with sessions: its newest session's start): an empty project's
	 *  place among the others by recency. */
	addedAt: number;
	/** Its folder is gone from disk: still listed (dimmed), until the person removes it or it comes back. */
	missing?: true;
}

export interface SidebarProjectsState {
	projects: SidebarProject[];
	/**
	 * Folders the person removed: their sessions stay on disk but list under no project until the person opens the
	 * folder again (a session found there later does not bring it back).
	 */
	removed: string[];
	/**
	 * Each session folder that is a linked worktree → the project it was cut from, as git on that computer says (a
	 * paired device cannot ask the host's git): its sessions are rows of that project, never a project of their own. A
	 * worktree removed since (listed in `gone`) keeps naming its project, so a session of it a tab holds stays there.
	 */
	worktrees: Record<string, string>;
	/**
	 * What each linked worktree folder in `worktrees` is (an agent's, an Autopilot run's, any other), as git on that
	 * computer says while the folder is there: a paired device cannot ask the host's git, and an agent worktree's
	 * sessions fold into their project as they do in the host's own sidebar (`foldsIntoProject`). Absent from an older
	 * host.
	 */
	worktreeKinds?: Record<string, WorktreeKind>;
	/**
	 * Session folders that are gone from disk (a removed worktree, a deleted folder), as that computer sees it: a paired
	 * device places their sessions with `sessionProjectKey`, as this computer's own sidebar does (a gone worktree's
	 * sessions leave, a gone project's stay under it, dimmed). Absent from an older host.
	 */
	gone?: string[];
}

export type SidebarProjectsRequest =
	| { action: "get" }
	| { action: "add"; path: string }
	| { action: "remove"; path: string };

export interface IpcSidebarProjects {
	/** The paired host whose list this is; unset for this computer's. */
	device?: string;
	state: SidebarProjectsState;
}

/** `device`: the paired host whose section it is; absent = this computer. */
export interface SidebarProjectsApi {
	command(request: SidebarProjectsRequest, device?: string): Promise<SidebarProjectsState>;
	/** A list changed: this computer's (`device` unset) or a paired host's (pushed over the link). */
	onState(callback: (update: IpcSidebarProjects) => void): () => void;
}

export const EMPTY_SIDEBAR_PROJECTS: SidebarProjectsState = { projects: [], removed: [], worktrees: {} };

/**
 * A stored value read back: anything malformed falls away, duplicates keep their first entry. Nothing is trimmed: a
 * project leaves only by the person's Remove, and a removed one must stay removed.
 */
export function parseSidebarProjects(value: unknown): SidebarProjectsState {
	const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const seen = new Set<string>();
	const projects: SidebarProject[] = [];
	for (const entry of Array.isArray(record.projects) ? record.projects : []) {
		if (!entry || typeof entry !== "object") continue;
		const { path, addedAt, missing } = entry as Record<string, unknown>;
		if (typeof path !== "string" || path.length === 0 || seen.has(path)) continue;
		seen.add(path);
		projects.push({
			path,
			addedAt: typeof addedAt === "number" && Number.isFinite(addedAt) ? addedAt : 0,
			...(missing === true ? { missing: true as const } : {}),
		});
	}
	const removed = [
		...new Set(
			(Array.isArray(record.removed) ? record.removed : []).filter(
				(path): path is string => typeof path === "string" && path.length > 0 && !seen.has(path),
			),
		),
	];
	const worktrees: Record<string, string> = {};
	const rawWorktrees = record.worktrees;
	if (rawWorktrees && typeof rawWorktrees === "object" && !Array.isArray(rawWorktrees))
		for (const [cwd, project] of Object.entries(rawWorktrees))
			if (cwd && typeof project === "string" && project) worktrees[cwd] = project;
	const gone = Array.isArray(record.gone)
		? [...new Set(record.gone.filter((path): path is string => typeof path === "string" && path.length > 0))]
		: [];
	const worktreeKinds: Record<string, WorktreeKind> = {};
	const rawKinds = record.worktreeKinds;
	if (rawKinds && typeof rawKinds === "object" && !Array.isArray(rawKinds))
		for (const [cwd, kind] of Object.entries(rawKinds))
			if (cwd && (kind === "autopilot" || kind === "agent" || kind === "other")) worktreeKinds[cwd] = kind;
	return {
		projects,
		removed,
		worktrees,
		...(Object.keys(worktreeKinds).length > 0 ? { worktreeKinds } : {}),
		...(gone.length > 0 ? { gone } : {}),
	};
}

export interface SessionFolderFacts {
	/** The folder the session ran in. */
	cwd: string;
	/** That computer says the folder is gone from disk (`SidebarProjectsState.gone`, or git's answer on the computer itself). */
	gone: boolean;
	/** The project the folder was cut from when it is a worktree, live or removed (`SidebarProjectsState.worktrees`). */
	project?: string | undefined;
	/** A tab holds the session, here or on its computer, whatever state that tab is in. */
	held: boolean;
	/**
	 * A tab the person uses holds it (`tabInUse`: here, or on its computer, `heldOnHost`): never only a tab a relaunch
	 * restored asleep, nor the ghost of last run's strip.
	 */
	inUse: boolean;
}

/**
 * Whether a tab counts as the person using its session: the ghost of last run's strip (`ghost`, painted before main
 * answers) and a tab a relaunch restored that nobody has shown since (`asleep`: no omp, here or on a paired host)
 * do not. A finished worktree's session stays listed only for a tab in use (`sessionProjectKey`).
 */
export function tabInUse(tab: { status: string; ghost?: boolean }): boolean {
	return tab.ghost !== true && tab.status !== "asleep";
}

/**
 * The folders of a computer's list that were OMPdesk worktrees and are gone (disk care removed them once their work
 * landed, or they were discarded): their sessions are finished. Main closes a restored tab on one that nobody has
 * shown since (`SidecarPool.closeAsleepTabsIn`), on that computer and on every device with a tab on it.
 */
export function finishedWorktreeFolders(state: Pick<SidebarProjectsState, "gone">): Set<string> {
	return new Set((state.gone ?? []).filter(isOmpdeskWorktreeFolder));
}

/**
 * A session whose OMPdesk worktree is gone is finished (its work landed, or it was discarded): it is no row anywhere,
 * neither a project's nor a child under the session whose agent opened it, unless a tab the person uses holds it
 * (`inUse`). A tab a relaunch restored asleep, or a ghost, never brings one back (the user's report, 29 Oct 2026: a
 * device's restored tabs listed two landed worktrees' sessions the host itself hid).
 */
export function sessionFinished(folder: Pick<SessionFolderFacts, "cwd" | "gone" | "inUse">): boolean {
	return folder.gone && isOmpdeskWorktreeFolder(folder.cwd) && !folder.inUse;
}

/**
 * The one rule for where a stored session sits in a sidebar, this computer's own and a paired host's section alike:
 * the key of the project group it is a row of, or null when it is not listed.
 *
 * - A removed OMPdesk worktree is never a project, and its sessions are finished (`sessionFinished`): they group under
 *   the project it was cut from (when that is known) only while a tab the person uses holds one, else they leave.
 * - Any other folder that is gone is still a project (listed, dimmed) until the person removes it, and its sessions
 *   follow the project: they stay.
 * - A project the person removed takes its sessions with it, unless a tab holds one.
 */
export function sessionProjectKey(folder: SessionFolderFacts, removed: ReadonlySet<string>): string | null {
	if (sessionFinished(folder)) return null;
	const key = folder.project ?? folder.cwd;
	return removed.has(key) && !folder.held ? null : key;
}
