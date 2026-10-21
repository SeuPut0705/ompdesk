/**
 * The world the orphaned-worktree tests share (never imported by app code): a repository, a stand-in for stock's
 * worktree root and the open folders. The tests are split over files so they run side by side: on a Windows runner the
 * one file took 79 s.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { RpcOrphanWorktree } from "../shared/rpc-types";
import { gitSync, initRepo } from "./local/git/test-repos";
import { realFolder } from "./worktree-removals";

export const SLOW = 120_000;
export const HASH = "abcdef1";

export let root: string;
export let repo: string;
export let wtRoot: string;
export let home: string | undefined;
export let open: string[];

/** `git.worktree_location` as omp answers it: the worktree root and the repo's hash. */
export const bridge = {
	request: async <T>(method: string): Promise<T> => {
		if (method !== "git.worktree_location") throw new Error(`unexpected bridge call ${method}`);
		return { root: wtRoot, hash: HASH } as T;
	},
};
export const deps = { bridge, openFolders: () => open };

/** A worktree on a new branch off main, in `parent` (default: the worktree root) named like OMPdesk's own. */
export function addWorktree(name: string, options: { parent?: string; folder?: string } = {}): string {
	const target = path.join(options.parent ?? wtRoot, options.folder ?? `gui-${name}-${HASH}`);
	gitSync(repo, "worktree", "add", "-q", "-b", `omp/gui/${name}`, target, "main");
	return target;
}

export async function commitIn(dir: string, file: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, file), content);
	gitSync(dir, "add", file);
	gitSync(dir, "commit", "-q", "-m", `edit ${file}`);
}

/** Every kind of worktree the listing tells apart, plus the two it leaves out and one a session holds. */
export async function scene(): Promise<Record<string, string>> {
	const dirs: Record<string, string> = {};
	dirs.inUse = addWorktree("inuse");
	dirs.landed = addWorktree("landed");
	dirs.squashed = addWorktree("squashed");
	dirs.unlanded = addWorktree("unlanded");
	dirs.dirty = addWorktree("dirty");
	dirs.untouched = addWorktree("untouched");
	await fs.mkdir(path.join(root, "elsewhere"), { recursive: true });
	dirs.outside = addWorktree("outside", { parent: path.join(root, "elsewhere") });
	dirs.notGui = addWorktree("plain", { folder: "feature-plain" });

	await commitIn(dirs.inUse, "inuse.ts", "x\n");
	await commitIn(dirs.landed, "landed.ts", "x\n");
	gitSync(repo, "merge", "--ff-only", "-q", "omp/gui/landed");
	await commitIn(dirs.squashed, "squashed.ts", "x\n");
	gitSync(repo, "merge", "--squash", "omp/gui/squashed");
	gitSync(repo, "commit", "-q", "-m", "squash");
	await commitIn(dirs.unlanded, "one.ts", "1\n");
	await commitIn(dirs.unlanded, "two.ts", "2\n");
	await fs.writeFile(path.join(dirs.dirty, "scratch.txt"), "unsaved");

	// A detached checkout of where main now is: its commit is in the base.
	dirs.detached = path.join(wtRoot, `gui-detached-${HASH}`);
	gitSync(repo, "worktree", "add", "-q", "--detach", dirs.detached, "main");
	open = [path.join(dirs.inUse, "src", "deeper")];
	return Object.fromEntries(
		await Promise.all(Object.entries(dirs).map(async ([key, dir]) => [key, await fs.realpath(dir)])),
	);
}

/** The worktrees git lists, as the real folders the product compares (git prints `C:/…` on Windows). */
export function listedWorktrees(): string[] {
	return gitSync(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => realFolder(line.slice("worktree ".length)));
}

export function byBranch(worktrees: RpcOrphanWorktree[], name: string): RpcOrphanWorktree | undefined {
	return worktrees.find(worktree => worktree.branch === `omp/gui/${name}`);
}

/** Registers the shared hooks: a fresh repository for each test. */
export function installOrphansRig(): void {
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-orphans-")));
		home = process.env.HOME;
		process.env.HOME = path.join(root, "home");
		repo = path.join(root, "repo");
		wtRoot = path.join(root, "wt");
		open = [];
		await initRepo(repo);
		await fs.mkdir(wtRoot, { recursive: true });
	});

	afterEach(async () => {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
}

/** The folders open in a tab, as the listing reads them. */
export function setOpen(folders: string[]): void {
	open = folders;
}
