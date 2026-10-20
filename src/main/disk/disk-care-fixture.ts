/**
 * The world the disk-care tests share (never imported by app code): a project repository with a lockfile and a build
 * that writes `out/`, worktrees of it under a stand-in for stock's worktree root, and a `DiskCare` wired to fakes.
 * The tests are split over several files so they run side by side: each runs real git many times, slow on Windows.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import { setOpenFoldersSource } from "../worktree-orphans";
import { realFolder } from "../worktree-removals";
import { DiskCare, type DiskCareDeps } from "./care";
import { SavedWorktreeStore } from "./saved-worktrees";

export const SLOW = 120_000;
export const DAY_MS = 24 * 60 * 60_000;
const HASH = "abcdef1";
const MONTH_MS = 30 * DAY_MS;

export interface DiskCareWorld {
	root: string;
	repo: string;
	userData: string;
	saved: SavedWorktreeStore;
	/** Folders open in a tab. */
	open: string[];
	/** Working folders of running processes; null when they cannot be told. */
	processes: string[] | null;
	logs: [string, Record<string, unknown>][];
	/** Disk care as of `now` (a month from now: every worktree idle). */
	care(now?: number, extra?: Partial<DiskCareDeps>): DiskCare;
	worktree(name: string): Promise<string>;
	/** An idle worktree with unlanded commits, uncommitted edits, an edited seeded `.env`, deps, build output and a hand-made dist. */
	busyWorktree(name: string): Promise<string>;
	/** The worktrees git lists for the repository, as real paths. */
	listed(): string[];
	savedRefs(): string[];
}

/** Registers the per-test setup and teardown; the returned world's fields are fresh in every test. */
export function diskCareWorld(): DiskCareWorld {
	let wtRoot = "";
	const env: Record<string, string | undefined> = {};
	const bridge = {
		request: async <T>(method: string): Promise<T> => {
			if (method !== "git.worktree_location") throw new Error(`unexpected bridge call ${method}`);
			return { root: wtRoot, hash: HASH } as T;
		},
	};
	const world: DiskCareWorld = {
		root: "",
		repo: "",
		userData: "",
		saved: new SavedWorktreeStore(""),
		open: [],
		processes: [],
		logs: [],
		care: (now = Date.now() + MONTH_MS, extra = {}) =>
			new DiskCare({
				bridge,
				openFolders: () => world.open,
				userData: world.userData,
				saved: world.saved,
				clearHttpCache: async () => {},
				bunBin: () => null,
				worktrees: true,
				log: (message, details) => world.logs.push([message, details]),
				broadcast: () => {},
				automatic: false,
				now: () => now,
				processFolders: async () => world.processes,
				...extra,
			}),
		worktree: async name => {
			const target = path.join(wtRoot, `gui-${name}-${HASH}`);
			gitSync(world.repo, "worktree", "add", "-q", "-b", `omp/agent/${name}`, target, "main");
			return fs.realpath(target);
		},
		busyWorktree: async name => {
			const dir = await world.worktree(name);
			await write(dir, "feature.ts", "export const done = 1;\n");
			gitSync(dir, "add", "feature.ts");
			gitSync(dir, "commit", "-q", "-m", "feature");
			await write(dir, "README.md", "hello, edited\n");
			await write(dir, "notes/todo.md", "next: tests\n");
			await write(dir, ".env", "API_KEY=edited-in-worktree\n");
			await write(dir, "node_modules/left-pad/index.js", "module.exports = 1;\n");
			await write(dir, "out/main/index.js", "built\n");
			await write(dir, "dist/handmade.html", "<p>my page</p>\n");
			await write(dir, "config/.env.local", "STRIPE=sk-live-abcdefghijklmnopqrstuvwx\n");
			return dir;
		},
		listed: () =>
			gitSync(world.repo, "worktree", "list", "--porcelain")
				.split("\n")
				.filter(line => line.startsWith("worktree "))
				.map(line => realFolder(line.slice("worktree ".length))),
		savedRefs: () =>
			gitSync(world.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/ompdesk/saved")
				.split("\n")
				.filter(Boolean),
	};

	beforeEach(async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-disk-care-")));
		// Every run ends by measuring the home's `.omp`, the agent dir and bun's install cache. Windows reads the home from
		// USERPROFILE (not HOME), and CI names its real bun cache in BUN_INSTALL_CACHE_DIR: left alone, each case walked
		// the runner's whole cache file by file, about 20 s of a Windows case.
		const home = path.join(root, "home");
		for (const key of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"])
			env[key] = process.env[key];
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
		process.env.BUN_INSTALL = path.join(home, ".bun");
		delete process.env.BUN_INSTALL_CACHE_DIR;
		world.root = root;
		world.repo = path.join(root, "repo");
		wtRoot = path.join(root, "wt");
		world.userData = path.join(root, "userData");
		world.saved = new SavedWorktreeStore(path.join(world.userData, "disk-care"));
		world.open = [];
		world.processes = [];
		world.logs = [];
		await initRepo(world.repo);
		// Disk care keeps any worktree whose repo converts line endings (Git for Windows' default core.autocrlf=true), so
		// the tests that save and remove one need plain bytes: `initRepo` sets core.autocrlf=false; the eol tests turn
		// conversion on. A project whose dependencies come from a lockfile and whose build writes `out/`.
		await write(
			world.repo,
			"package.json",
			JSON.stringify({ scripts: { build: "electron-vite build" }, devDependencies: { "electron-vite": "1" } }),
		);
		await write(world.repo, "bun.lock", "{}\n");
		await write(world.repo, ".gitignore", ".env\nnode_modules/\nout/\ndist/\n");
		gitSync(world.repo, "add", ".");
		gitSync(world.repo, "commit", "-q", "-m", "project");
		await fs.mkdir(wtRoot, { recursive: true });
		setOpenFoldersSource(() => world.open);
	});

	afterEach(async () => {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	return world;
}

export async function write(dir: string, file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
	await fs.writeFile(path.join(dir, file), content);
}

export const exists = (file: string): Promise<boolean> =>
	fs.lstat(file).then(
		() => true,
		() => false,
	);

/** sha256 of every file in the worktree but git's own `.git` link. */
export async function fileHashes(dir: string): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const file = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
		if (file === ".git") continue;
		hashes[file] = createHash("sha256")
			.update(await fs.readFile(path.join(dir, file)))
			.digest("hex");
	}
	return hashes;
}
