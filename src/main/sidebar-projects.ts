/**
 * This computer's sidebar project list (contract `src/shared/sidebar-projects.ts`): the folders the person opened or
 * added, and every folder this computer's sessions ran in, so a project outlives its last session. Kept in main
 * because a paired device reads and edits it too (`host.projects.command`), whether or not a window here is open.
 *
 * Sessions bring their folder in by themselves: `sync` runs once at start (which also lists every folder that had
 * sessions before the list existed) and again after the session index changes. A folder the person removed stays out
 * until they open it again (`add`); a removed project's sessions are not touched.
 */
import * as path from "node:path";
import { promises as fs } from "original-fs";
import type { SessionInfo } from "../shared/ipc-types";
import { pathBaseName } from "../shared/project-origin";
import {
	parseSidebarProjects,
	type SidebarProject,
	type SidebarProjectsRequest,
	type SidebarProjectsState,
} from "../shared/sidebar-projects";
import { readProjectOrigin } from "./local/git/origin";

/** How long the list waits after the session index last changed before it looks for new folders. */
export const SIDEBAR_PROJECTS_SYNC_DELAY_MS = 1_500;

export type SidebarProjectsSession = Pick<
	SessionInfo,
	"cwd" | "kind" | "created" | "messageCount" | "title" | "firstMessage"
>;

export interface SidebarProjectsDeps {
	read: () => unknown;
	write: (state: SidebarProjectsState) => void;
	/** This computer's stored sessions. */
	sessions: () => Promise<readonly SidebarProjectsSession[]>;
	/** The no-project Work workspace: its sessions are the sidebar's chats, never a project's. */
	defaultWorkspace: () => string;
	/** The project a folder belongs to (a linked worktree's main checkout, else the folder), null when it is gone. */
	projectOf?: (cwd: string) => Promise<string | null>;
	/** Whether a listed project's folder is still there (a missing one stays listed, dimmed). */
	exists?: (path: string) => Promise<boolean>;
	onState: (state: SidebarProjectsState) => void;
	now?: () => number;
}

async function folderExists(path: string): Promise<boolean> {
	return fs.stat(path).then(
		stat => stat.isDirectory(),
		() => false,
	);
}

/**
 * The main checkout a linked worktree's `.git` file points at (`gitdir: <main>/.git/worktrees/<name>`), read without git:
 * a git that could not answer (not installed yet, slow at startup on Windows) once listed every agent worktree as a
 * project of its own (the user's report, 23 Oct 2026: a paired Windows host's section was a column of `gui-agent-…`).
 */
export async function linkedWorktreeRoot(cwd: string): Promise<string | null> {
	const text = await fs.readFile(path.join(cwd, ".git"), "utf8").catch(() => null);
	const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
	if (!match?.[1]) return null;
	const gitdir = path.resolve(cwd, match[1]);
	if (path.basename(path.dirname(gitdir)) !== "worktrees") return null;
	const common = path.dirname(path.dirname(gitdir));
	if (path.basename(common) !== ".git") return null;
	const root = path.dirname(common);
	return fs.realpath(root).catch(() => root);
}

/** A linked worktree names its main checkout; any other folder is its own project; a folder that is gone, none. */
export async function projectOfFolder(cwd: string): Promise<string | null> {
	if (!(await folderExists(cwd))) return null;
	const origin = await readProjectOrigin(cwd);
	if (origin?.worktree) return origin.root;
	return (await linkedWorktreeRoot(cwd)) ?? cwd;
}

/** The folder name of a checkout OMPdesk makes under the worktree root (`gui-<name>-<hash7>`). */
const OMPDESK_WORKTREE_FOLDER = /^gui-.+-[0-9a-f]{7}$/;

export class SidebarProjects {
	readonly #deps: SidebarProjectsDeps;
	readonly #projectOf: (cwd: string) => Promise<string | null>;
	readonly #now: () => number;
	#state: SidebarProjectsState;
	/** What each session folder resolved to: whether a folder is a linked worktree does not change. */
	readonly #resolved = new Map<string, string | null>();
	#timer: NodeJS.Timeout | undefined;
	#running: Promise<void> | null = null;
	#again = false;
	#disposed = false;

	constructor(deps: SidebarProjectsDeps) {
		this.#deps = deps;
		this.#projectOf = deps.projectOf ?? projectOfFolder;
		this.#now = deps.now ?? Date.now;
		this.#state = parseSidebarProjects(deps.read());
	}

	state(): SidebarProjectsState {
		return this.#state;
	}

	async command(request: SidebarProjectsRequest): Promise<SidebarProjectsState> {
		if (request.action === "add") await this.add(request.path);
		else if (request.action === "remove") this.remove(request.path);
		// A read also notices a folder that went (or came back) since the last pass.
		else await this.#checkFolders([], this.#state.worktrees);
		return this.#state;
	}

	/** The person opened or added a folder: it is listed (its project, for a worktree), removed or not before. */
	async add(path: string): Promise<void> {
		if (!path || path === this.#deps.defaultWorkspace()) return;
		const project = (await this.#projectOf(path)) ?? path;
		if (project === this.#deps.defaultWorkspace()) return;
		const listed = this.#state.projects.some(entry => entry.path === project);
		if (listed && !this.#state.removed.includes(project)) return;
		this.#commit({
			projects: listed ? this.#state.projects : [...this.#state.projects, { path: project, addedAt: this.#now() }],
			removed: this.#state.removed.filter(entry => entry !== project),
		});
	}

	/** "Remove from sidebar": no file and no session is touched. */
	remove(path: string): void {
		if (!this.#state.projects.some(entry => entry.path === path) && this.#state.removed.includes(path)) return;
		this.#commit({
			projects: this.#state.projects.filter(entry => entry.path !== path),
			removed: [...this.#state.removed.filter(entry => entry !== path), path],
		});
	}

	/** The session index changed: look for new folders once it has been quiet a moment. */
	schedule(): void {
		if (this.#disposed || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.sync();
		}, SIDEBAR_PROJECTS_SYNC_DELAY_MS);
		this.#timer.unref?.();
	}

	/** Lists every folder sessions ran in that is neither listed nor removed. One pass at a time; a call meanwhile reruns it. */
	async sync(): Promise<void> {
		if (this.#running) {
			this.#again = true;
			return this.#running;
		}
		this.#running = (async () => {
			do {
				this.#again = false;
				await this.#syncOnce().catch(() => undefined);
			} while (this.#again && !this.#disposed);
		})().finally(() => {
			this.#running = null;
		});
		return this.#running;
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async #syncOnce(): Promise<void> {
		const workspace = this.#deps.defaultWorkspace();
		// Each folder once, with its newest session's start: that is where it sorts until a session there sorts it.
		const newest = new Map<string, number>();
		for (const session of await this.#deps.sessions()) {
			// A file stock wrote before the first message is no conversation yet (the sidebar's `sessionHasContent`).
			const content = session.messageCount > 0 || Boolean(session.title?.trim() || session.firstMessage?.trim());
			if (session.kind === "chat" || session.cwd === workspace || !session.cwd || !content) continue;
			const created = Date.parse(session.created);
			newest.set(session.cwd, Math.max(newest.get(session.cwd) ?? 0, Number.isNaN(created) ? 0 : created));
		}
		const found = new Map<string, number>();
		// A linked worktree's folder → its project: a paired device groups the host's sessions by it (git runs here).
		const worktrees: Record<string, string> = {};
		for (const [cwd, created] of newest) {
			let project = this.#resolved.get(cwd);
			if (project === undefined) {
				project = await this.#projectOf(cwd);
				this.#resolved.set(cwd, project);
			}
			if (project === null || project === workspace) continue;
			if (project !== cwd) worktrees[cwd] = project;
			found.set(project, Math.max(found.get(project) ?? 0, created));
		}
		if (this.#disposed) return;
		// A listed folder that is a linked worktree (listed by a pass whose git could not tell) gives way to its project.
		const moved = new Map<string, string>();
		for (const { path: listedPath, missing } of this.#state.projects) {
			if (missing) continue;
			let project = this.#resolved.get(listedPath);
			if (project === undefined) {
				project = await this.#projectOf(listedPath);
				this.#resolved.set(listedPath, project);
			}
			if (project && project !== listedPath && project !== workspace) moved.set(listedPath, project);
		}
		for (const [from, to] of moved) {
			worktrees[from] = to;
			found.set(
				to,
				Math.max(found.get(to) ?? 0, this.#state.projects.find(entry => entry.path === from)?.addedAt ?? 0),
			);
		}
		if (this.#disposed) return;
		const listed = new Set(this.#state.projects.filter(entry => !moved.has(entry.path)).map(entry => entry.path));
		const added: SidebarProject[] = [];
		for (const [path, addedAt] of found) {
			if (listed.has(path) || this.#state.removed.includes(path)) continue;
			added.push({ path, addedAt: addedAt || this.#now() });
		}
		await this.#checkFolders(added, worktrees, moved);
	}

	/** Marks each listed project whose folder is gone (and unmarks one that came back); commits with `added`. */
	async #checkFolders(
		added: readonly SidebarProject[],
		worktrees: Record<string, string>,
		moved: ReadonlyMap<string, string> = new Map(),
	): Promise<void> {
		const exists = this.#deps.exists ?? folderExists;
		const before = this.#state;
		const kept = before.projects.filter(entry => !moved.has(entry.path));
		const checked = (
			await Promise.all(
				[...kept, ...added].map(
					async ({ path, addedAt }): Promise<SidebarProject> =>
						(await exists(path)) ? { path, addedAt } : { path, addedAt, missing: true },
				),
			)
		)
			// A checkout OMPdesk made (`gui-<name>-<hash7>`) that is gone was a worktree, never a project: it leaves.
			.filter(entry => !(entry.missing && OMPDESK_WORKTREE_FOLDER.test(pathBaseName(entry.path))));
		// Something else changed the list meanwhile: the next pass checks again.
		if (this.#disposed || this.#state !== before) return;
		const changed =
			added.length > 0 ||
			moved.size > 0 ||
			checked.length !== kept.length + added.length ||
			checked.some((entry, index) => entry.missing !== before.projects[index]?.missing) ||
			JSON.stringify(worktrees) !== JSON.stringify(before.worktrees);
		if (changed) this.#commit({ projects: checked, worktrees });
	}

	#commit(next: Partial<SidebarProjectsState>): void {
		this.#state = { ...this.#state, ...next };
		this.#deps.write(this.#state);
		this.#deps.onState(this.#state);
	}
}
