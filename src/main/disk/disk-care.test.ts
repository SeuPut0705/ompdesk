import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import { setOpenFoldersSource } from "../worktree-orphans";
import { realFolder } from "../worktree-removals";
import { DiskCare } from "./care";
import { listSavedWorktrees, restoreSavedWorktree, SavedWorktreeStore } from "./saved-worktrees";

const SLOW = 120_000;
const HASH = "abcdef1";
const MONTH_MS = 30 * 24 * 60 * 60_000;

let root: string;
let repo: string;
let wtRoot: string;
let userData: string;
let saved: SavedWorktreeStore;
let open: string[];
let processes: string[] | null;
let logs: [string, Record<string, unknown>][];
const env: Record<string, string | undefined> = {};

const bridge = {
	request: async <T>(method: string): Promise<T> => {
		if (method !== "git.worktree_location") throw new Error(`unexpected bridge call ${method}`);
		return { root: wtRoot, hash: HASH } as T;
	},
};

function care(now = Date.now() + MONTH_MS): DiskCare {
	return new DiskCare({
		bridge,
		openFolders: () => open,
		userData,
		saved,
		clearHttpCache: async () => {},
		bunBin: () => null,
		worktrees: true,
		log: (message, details) => logs.push([message, details]),
		broadcast: () => {},
		automatic: false,
		now: () => now,
		processFolders: async () => processes,
	});
}

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-disk-care-")));
	for (const key of ["HOME", "PI_CODING_AGENT_DIR"]) env[key] = process.env[key];
	process.env.HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "home", ".omp", "agent");
	repo = path.join(root, "repo");
	wtRoot = path.join(root, "wt");
	userData = path.join(root, "userData");
	saved = new SavedWorktreeStore(path.join(userData, "disk-care"));
	open = [];
	processes = [];
	logs = [];
	await initRepo(repo);
	// A project whose dependencies come from a lockfile and whose build writes `out/`.
	await fs.writeFile(
		path.join(repo, "package.json"),
		JSON.stringify({ scripts: { build: "electron-vite build" }, devDependencies: { "electron-vite": "1" } }),
	);
	await fs.writeFile(path.join(repo, "bun.lock"), "{}\n");
	await fs.writeFile(path.join(repo, ".gitignore"), ".env\nnode_modules/\nout/\ndist/\n");
	gitSync(repo, "add", ".");
	gitSync(repo, "commit", "-q", "-m", "project");
	await fs.mkdir(wtRoot, { recursive: true });
	setOpenFoldersSource(() => open);
});

afterEach(async () => {
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function worktree(name: string): Promise<string> {
	const target = path.join(wtRoot, `gui-${name}-${HASH}`);
	gitSync(repo, "worktree", "add", "-q", "-b", `omp/agent/${name}`, target, "main");
	return fs.realpath(target);
}

async function write(dir: string, file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
	await fs.writeFile(path.join(dir, file), content);
}

const exists = (file: string) =>
	fs.lstat(file).then(
		() => true,
		() => false,
	);
const listed = () =>
	gitSync(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => realFolder(line.slice("worktree ".length)));

/** An idle worktree with unlanded commits, uncommitted edits, an edited seeded `.env`, deps, build output and a hand-made dist. */
async function busyWorktree(name: string): Promise<string> {
	const dir = await worktree(name);
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
}

describe("disk care", () => {
	it(
		"drops a lockfile-backed node_modules and the build tool's out/, keeps a hand-made dist/ and the .env",
		async () => {
			const dir = await busyWorktree("artifacts");
			await care(Date.now() + 5 * 24 * 60 * 60_000).run("user");
			expect(await exists(path.join(dir, "node_modules"))).toBe(false);
			expect(await exists(path.join(dir, "out"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "dist/handmade.html"), "utf8")).toBe("<p>my page</p>\n");
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(listed()).toContain(dir);
			const line = logs.find(([message]) => message === "artifacts");
			expect(String(line?.[1].entries)).toMatch(/node_modules\/ \(lockfile-dependencies\)/);
		},
		SLOW,
	);

	it(
		"drops what the .gitignore files under a build-output comment and keeps what it files under any other",
		async () => {
			const dir = await worktree("sections");
			await fs.appendFile(path.join(dir, ".gitignore"), "\n# Build output\ngen/\n\n# My scratch notes\nscratch/\n");
			gitSync(dir, "commit", "-q", "-am", "ignore sections");
			await write(dir, "gen/bundle.js", "built\n");
			await write(dir, "scratch/ideas.md", "keep me\n");
			await care(Date.now() + 5 * 24 * 60 * 60_000).run("user");
			expect(await exists(path.join(dir, "gen"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "scratch/ideas.md"), "utf8")).toBe("keep me\n");
			const line = logs.find(([message]) => message === "artifacts");
			expect(String(line?.[1].entries)).toContain("gen/ (gitignore-build-section)");
		},
		SLOW,
	);

	it(
		"saves an idle unlanded worktree to a branch and a private archive, removes it, and restores it whole",
		async () => {
			const dir = await busyWorktree("idle");
			const tip = gitSync(repo, "rev-parse", "omp/agent/idle");
			await care().run("user");

			expect(await exists(dir)).toBe(false);
			expect(listed()).not.toContain(dir);
			// The worktree's own branch is untouched; the uncommitted work sits on a new saved branch.
			expect(gitSync(repo, "rev-parse", "omp/agent/idle")).toBe(tip);
			const [record] = await listSavedWorktrees(repo, saved);
			expect(record?.savedBranch).toMatch(/^ompdesk\/saved\//);
			const savedFiles = gitSync(repo, "show", "--name-only", "--format=", record?.savedBranch ?? "");
			expect(savedFiles.split("\n").sort()).toEqual(["README.md", "notes/todo.md"]);
			// Secrets never entered git, not even the saved branch: neither the ignored `.env` nor the untracked one.
			expect(gitSync(repo, "log", "--all", "--format=%H", "--", ".env", "config/.env.local")).toBe("");
			const archive = path.join(userData, "disk-care", "saved", record?.id ?? "");
			if (process.platform !== "win32") {
				expect((await fs.stat(archive)).mode & 0o777).toBe(0o700);
				expect((await fs.stat(path.join(archive, "files", ".env"))).mode & 0o777).toBe(0o600);
			}
			expect(logs.find(([message]) => message === "worktree-saved")?.[1].restore).toContain("git worktree add");

			const restored = await restoreSavedWorktree(record?.id ?? "", saved);
			expect(restored).toMatchObject({ path: dir, branch: "omp/agent/idle" });
			expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("hello, edited\n");
			expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(await fs.readFile(path.join(dir, "dist/handmade.html"), "utf8")).toBe("<p>my page</p>\n");
			expect(await fs.readFile(path.join(dir, "feature.ts"), "utf8")).toBe("export const done = 1;\n");
			expect(await fs.readFile(path.join(dir, "config/.env.local"), "utf8")).toContain("sk-live-");
			// Uncommitted again, as it was: changed in the working tree, nothing staged.
			expect(gitSync(dir, "diff", "--name-only")).toBe("README.md");
			expect(gitSync(dir, "diff", "--cached", "--name-only")).toBe("");
			expect(await listSavedWorktrees(repo, saved)).toEqual([]);
		},
		SLOW,
	);

	it(
		"keeps an idle worktree an open tab, a running process, a lock or a half-done merge holds",
		async () => {
			const tab = await busyWorktree("tab");
			const proc = await busyWorktree("proc");
			const locked = await busyWorktree("locked");
			gitSync(repo, "worktree", "lock", locked);
			const merging = await busyWorktree("merging");
			await fs.writeFile(path.join(merging, "README.md"), "hello\n");
			gitSync(merging, "checkout", "-q", "--", "README.md");
			const gitDir = gitSync(merging, "rev-parse", "--absolute-git-dir");
			await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), `${gitSync(repo, "rev-parse", "main")}\n`);
			open = [path.join(tab, "src")];
			processes = [path.join(proc, "notes")];

			await care().run("user");
			for (const dir of [tab, proc, locked, merging]) expect(listed(), dir).toContain(dir);
			expect(await fs.readFile(path.join(proc, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			// The process and the half-done merge are named in the log.
			const kept = logs.filter(([message]) => message === "kept").map(([, details]) => details.reason);
			expect(kept).toContain("a process works in it");
			expect(kept.some(reason => String(reason).includes("MERGE_HEAD"))).toBe(true);
			expect(await listSavedWorktrees(repo, saved)).toEqual([]);
		},
		SLOW,
	);

	it(
		"keeps everything where running processes cannot be told",
		async () => {
			const dir = await busyWorktree("unknown");
			processes = null;
			await care().run("user");
			expect(listed()).toContain(dir);
			expect(await exists(path.join(dir, "node_modules"))).toBe(true);
		},
		SLOW,
	);

	it(
		"archives a landed worktree's edited .env before removing it, so it can come back",
		async () => {
			const dir = await worktree("landed");
			await write(dir, "landed.ts", "x\n");
			gitSync(dir, "add", "landed.ts");
			gitSync(dir, "commit", "-q", "-m", "landed");
			gitSync(repo, "merge", "--ff-only", "-q", "omp/agent/landed");
			await write(dir, ".env", "TOKEN=only-here\n");
			// Not idle: the landed rule does not wait.
			await care(Date.now()).run("user");
			expect(await exists(dir)).toBe(false);
			const [record] = await listSavedWorktrees(repo, saved);
			expect(record).toMatchObject({ path: dir, savedBranch: null, archivedFiles: 1 });
			await restoreSavedWorktree(record?.id ?? "", saved);
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("TOKEN=only-here\n");
		},
		SLOW,
	);

	const savedRefs = () =>
		gitSync(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/ompdesk/saved")
			.split("\n")
			.filter(Boolean);

	it.skipIf(process.platform === "win32")(
		"keeps the saved branch, archive and record when git stops removing a worktree half way",
		async () => {
			const dir = await busyWorktree("partial");
			// A folder git cannot empty: the forced removal deletes what it can and fails on it.
			await fs.chmod(path.join(dir, "notes"), 0o555);
			try {
				await care().run("user");
			} finally {
				await fs.chmod(path.join(dir, "notes"), 0o755).catch(() => {});
			}
			expect(logs.some(([message, details]) => message === "failed" && details.step === "worktree-saved")).toBe(
				true,
			);
			const [record] = await listSavedWorktrees(repo, saved);
			expect(record?.path).toBe(dir);
			expect(savedRefs()).toEqual([record?.savedBranch]);
			expect(gitSync(repo, "show", `${record?.savedBranch}:notes/todo.md`)).toBe("next: tests");
			const archive = path.join(userData, "disk-care", "saved", record?.id ?? "", "files");
			expect(await fs.readFile(path.join(archive, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
		},
		SLOW,
	);

	it(
		"leaves the worktree untouched and keeps no stray branch or archive when the record cannot be written",
		async () => {
			const dir = await busyWorktree("unrecorded");
			saved = new (class extends SavedWorktreeStore {
				override update(): Promise<void> {
					return Promise.reject(new Error("disk full"));
				}
			})(path.join(userData, "disk-care"));
			await care().run("user");
			expect(listed()).toContain(dir);
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
			expect(savedRefs()).toEqual([]);
			expect(await fs.readdir(path.join(userData, "disk-care", "saved")).catch(() => [])).toEqual([]);
		},
		SLOW,
	);

	it(
		"brings back what was staged and what was edited after it, each where it was",
		async () => {
			const dir = await busyWorktree("staged");
			await write(dir, "README.md", "staged A\n");
			gitSync(dir, "add", "README.md");
			await write(dir, "README.md", "working B\n");
			await write(dir, "added.ts", "staged only\n");
			gitSync(dir, "add", "added.ts");
			await fs.rm(path.join(dir, "added.ts"));
			await care().run("user");
			expect(listed()).not.toContain(dir);
			const [record] = await listSavedWorktrees(repo, saved);
			await restoreSavedWorktree(record?.id ?? "", saved);
			expect(gitSync(dir, "show", ":README.md")).toBe("staged A");
			expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("working B\n");
			expect(gitSync(dir, "show", ":added.ts")).toBe("staged only");
			expect(await exists(path.join(dir, "added.ts"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
		},
		SLOW,
	);

	it(
		"keeps a worktree whose staged files hold a secret",
		async () => {
			const dir = await busyWorktree("staged-secret");
			await write(dir, "config.json", '{"token": "ghp_abcdefghijklmnopqrstuvwxyz0123"}\n');
			gitSync(dir, "add", "config.json");
			await write(dir, "config.json", "{}\n");
			await care().run("user");
			expect(listed()).toContain(dir);
			expect(savedRefs()).toEqual([]);
			expect(
				logs.some(([message, details]) => message === "kept" && String(details.reason).includes("secret")),
			).toBe(true);
		},
		SLOW,
	);
});
