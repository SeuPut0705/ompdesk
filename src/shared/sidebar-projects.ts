/**
 * The projects a device's sidebar lists, kept apart from its sessions (as Codex desktop keeps its saved workspace
 * roots apart from its threads): a project stays listed when its last session goes, and leaves only by the person's
 * "Remove from sidebar", which deletes no file and no session. Each computer keeps its own list (a paired host's
 * sidebar section shows the host's), in main's prefs under `SIDEBAR_PROJECTS_PREF`.
 *
 * A project is a folder: a main checkout, a subfolder of one, or a plain folder. A linked worktree is never one; it
 * names the project it was cut from (main resolves it before a path is stored).
 */

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
	 * paired device cannot ask the host's git): its sessions are rows of that project, never a project of their own.
	 */
	worktrees: Record<string, string>;
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
	return { projects, removed, worktrees };
}
