import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { SidebarProjectsState } from "../shared/sidebar-projects";
import { linkedWorktreeRoot, SidebarProjects, type SidebarProjectsSession } from "./sidebar-projects";

const WORKSPACE = "/home/me/.omp/work";

function session(cwd: string, created: string, extra: Partial<SidebarProjectsSession> = {}): SidebarProjectsSession {
	return { cwd, created, messageCount: 2, title: "t", firstMessage: "hi", ...extra };
}

/** Folders as git sees them: a worktree names its main checkout, a gone folder nothing. */
const FOLDERS: Record<string, string | null> = {
	"/work/alpha": "/work/alpha",
	"/home/me/.omp/wt/gui-alpha-1234567": "/work/alpha",
	"/work/beta": "/work/beta",
	"/work/gamma": "/work/gamma",
	"/work/empty": "/work/empty",
	"/gone": null,
};

function harness(stored: unknown = undefined) {
	let sessions: SidebarProjectsSession[] = [];
	let saved: unknown = stored;
	const gone = new Set<string>();
	const pushes: SidebarProjectsState[] = [];
	const make = () =>
		new SidebarProjects({
			read: () => saved,
			write: state => {
				saved = JSON.parse(JSON.stringify(state));
			},
			sessions: async () => sessions,
			defaultWorkspace: () => WORKSPACE,
			projectOf: async cwd => (cwd in FOLDERS ? (FOLDERS[cwd] as string | null) : cwd),
			exists: async path => !gone.has(path),
			onState: state => pushes.push(state),
			now: () => 5_000,
		});
	return {
		projects: make(),
		reopen: make,
		setSessions: (next: SidebarProjectsSession[]) => {
			sessions = next;
		},
		pushes,
		gone,
		saved: () => saved,
	};
}

const paths = (projects: SidebarProjects) => projects.state().projects.map(entry => entry.path);

describe("SidebarProjects", () => {
	it("lists every folder that already has sessions on its first pass, a worktree's under its project", async () => {
		const h = harness();
		h.setSessions([
			session("/work/alpha", "2026-10-01T00:00:00Z"),
			session("/home/me/.omp/wt/gui-alpha-1234567", "2026-10-03T00:00:00Z"),
			session("/work/beta", "2026-10-02T00:00:00Z"),
			// Neither a chat, the Work workspace, a file with no conversation yet nor a folder that is gone is a project.
			session("/work/gamma", "2026-10-02T00:00:00Z", { kind: "chat" }),
			session(WORKSPACE, "2026-10-02T00:00:00Z"),
			session("/work/empty", "2026-10-02T00:00:00Z", { messageCount: 0, title: "", firstMessage: "" }),
			session("/gone", "2026-10-02T00:00:00Z"),
		]);
		await h.projects.sync();
		expect(h.projects.state().projects).toEqual([
			// The project sorts by its newest session, the worktree's included.
			{ path: "/work/alpha", addedAt: Date.parse("2026-10-03T00:00:00Z") },
			{ path: "/work/beta", addedAt: Date.parse("2026-10-02T00:00:00Z") },
		]);
		expect(h.pushes).toHaveLength(1);
		// The worktree's folder is named with its project, for a paired device that cannot ask this computer's git.
		expect(h.projects.state().worktrees).toEqual({ "/home/me/.omp/wt/gui-alpha-1234567": "/work/alpha" });
		// Kept across a relaunch.
		expect(paths(h.reopen())).toEqual(["/work/alpha", "/work/beta"]);
	});

	it("moves a worktree folder an earlier pass listed as its own project under its project", async () => {
		// A pass whose git could not tell (not installed yet, slow at a Windows startup) listed agent worktrees as projects.
		const h = harness({
			projects: [
				{ path: "/work/beta", addedAt: 1 },
				{ path: "/home/me/.omp/wt/gui-alpha-1234567", addedAt: 3 },
			],
			removed: [],
			worktrees: {},
		});
		await h.projects.sync();
		expect(h.projects.state().projects).toEqual([
			{ path: "/work/beta", addedAt: 1 },
			{ path: "/work/alpha", addedAt: 3 },
		]);
		expect(h.projects.state().worktrees).toEqual({ "/home/me/.omp/wt/gui-alpha-1234567": "/work/alpha" });
	});

	it("drops a listed OMPdesk worktree folder that is gone, never a project of the person's that is", async () => {
		const h = harness({
			projects: [
				{ path: "/work/beta", addedAt: 1 },
				{ path: "/home/me/.omp/wt/gui-agent-m41hj7-5a1b2c3", addedAt: 2 },
				{ path: "/work/gui-tool-1234567x", addedAt: 3 },
			],
			removed: [],
			worktrees: {},
		});
		h.gone.add("/work/beta");
		h.gone.add("/home/me/.omp/wt/gui-agent-m41hj7-5a1b2c3");
		h.gone.add("/work/gui-tool-1234567x");
		await h.projects.sync();
		expect(h.projects.state().projects).toEqual([
			{ path: "/work/beta", addedAt: 1, missing: true },
			{ path: "/work/gui-tool-1234567x", addedAt: 3, missing: true },
		]);
	});

	it("reads a linked worktree's main checkout from its .git file when git cannot answer", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidebar-wt-")));
		try {
			const main = path.join(root, "repo");
			const wt = path.join(root, "wt", "gui-agent-abc");
			await fs.mkdir(path.join(main, ".git", "worktrees", "gui-agent-abc"), { recursive: true });
			await fs.mkdir(wt, { recursive: true });
			await fs.writeFile(
				path.join(wt, ".git"),
				`gitdir: ${path.join(main, ".git", "worktrees", "gui-agent-abc")}\n`,
			);
			expect(await linkedWorktreeRoot(wt)).toBe(main);
			// A main checkout's .git is a folder; a plain folder has none: neither is a linked worktree.
			expect(await linkedWorktreeRoot(main)).toBeNull();
			expect(await linkedWorktreeRoot(root)).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps a project whose last session was deleted", async () => {
		const h = harness();
		h.setSessions([session("/work/alpha", "2026-10-01T00:00:00Z"), session("/work/beta", "2026-10-02T00:00:00Z")]);
		await h.projects.sync();
		h.setSessions([session("/work/beta", "2026-10-02T00:00:00Z")]);
		await h.projects.sync();
		expect(paths(h.projects)).toEqual(["/work/alpha", "/work/beta"]);
	});

	it("drops a removed project for good until the person opens the folder again", async () => {
		const h = harness();
		h.setSessions([session("/work/alpha", "2026-10-01T00:00:00Z")]);
		await h.projects.sync();
		await h.projects.command({ action: "remove", path: "/work/alpha" });
		expect(h.projects.state()).toMatchObject({ projects: [], removed: ["/work/alpha"] });
		// Its sessions are still there: they do not bring it back.
		await h.projects.sync();
		expect(paths(h.reopen())).toEqual([]);
		// Opening the folder (or one of its worktrees) does.
		await h.projects.command({ action: "add", path: "/home/me/.omp/wt/gui-alpha-1234567" });
		expect(h.projects.state()).toMatchObject({ projects: [{ path: "/work/alpha", addedAt: 5_000 }], removed: [] });
	});

	it("adds a folder the person opened, empty or not, but never the Work workspace", async () => {
		const h = harness();
		await h.projects.command({ action: "add", path: "/work/new" });
		await h.projects.command({ action: "add", path: "/work/new" });
		await h.projects.command({ action: "add", path: WORKSPACE });
		expect(h.projects.state().projects).toEqual([{ path: "/work/new", addedAt: 5_000 }]);
		expect(h.pushes).toHaveLength(1);
	});

	it("keeps a project whose folder went missing, marked, and unmarks it when it comes back", async () => {
		const h = harness({ projects: [{ path: "/work/alpha", addedAt: 1 }], removed: [] });
		h.gone.add("/work/alpha");
		await h.projects.command({ action: "get" });
		expect(h.projects.state().projects).toEqual([{ path: "/work/alpha", addedAt: 1, missing: true }]);
		h.gone.clear();
		await h.projects.sync();
		expect(h.projects.state().projects).toEqual([{ path: "/work/alpha", addedAt: 1 }]);
	});

	it("reads a damaged stored value as what it can", () => {
		const h = harness({
			projects: [{ path: "/a", addedAt: 1 }, { path: "" }, "x", { path: "/a" }],
			removed: [3, "/b"],
		});
		expect(h.projects.state()).toEqual({ projects: [{ path: "/a", addedAt: 1 }], removed: ["/b"], worktrees: {} });
	});

	it("never drops a project or forgets a removal, however long the lists grow", async () => {
		const many = Array.from({ length: 600 }, (_, index) => `/work/p${index}`);
		const h = harness({
			projects: many.map(path => ({ path, addedAt: 1 })),
			removed: many.map(path => `${path}-removed`),
		});
		expect(h.projects.state().projects).toHaveLength(600);
		await h.projects.command({ action: "add", path: "/work/p600" });
		await h.projects.command({ action: "remove", path: "/work/p0" });
		// The oldest empty project is still there and no earlier removal came back after a sync and a relaunch.
		h.setSessions(many.map(path => session(`${path}-removed`, "2026-10-01T00:00:00Z")));
		await h.projects.sync();
		const reopened = h.reopen().state();
		expect(reopened.projects.map(entry => entry.path)).toEqual([...many.slice(1), "/work/p600"]);
		expect(reopened.removed).toHaveLength(601);
		expect(reopened.removed).toContain("/work/p0");
	});
});
