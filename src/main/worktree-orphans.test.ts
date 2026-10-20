import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RpcOrphanWorktree } from "../shared/rpc-types";
import { gitSync, initRepo } from "./local/git/test-repos";
import { LocalCommandError } from "./local/types";
import {
	classifyOrphan,
	listOrphanWorktrees,
	type OrphanFacts,
	removeOrphanWorktree,
	sessionOpenFolders,
	setOpenFoldersSource,
	sweepLandedWorktrees,
} from "./worktree-orphans";
import { realFolder } from "./worktree-removals";

const SLOW = 120_000;
const HASH = "abcdef1";

let root: string;
let repo: string;
let wtRoot: string;
let home: string | undefined;
let open: string[];

/** `git.worktree_location` as omp answers it: the worktree root and the repo's hash. */
const bridge = {
	request: async <T>(method: string): Promise<T> => {
		if (method !== "git.worktree_location") throw new Error(`unexpected bridge call ${method}`);
		return { root: wtRoot, hash: HASH } as T;
	},
};
const deps = { bridge, openFolders: () => open };

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

/** A worktree on a new branch off main, in `parent` (default: the worktree root) named like OMPdesk's own. */
function addWorktree(name: string, options: { parent?: string; folder?: string } = {}): string {
	const target = path.join(options.parent ?? wtRoot, options.folder ?? `gui-${name}-${HASH}`);
	gitSync(repo, "worktree", "add", "-q", "-b", `omp/gui/${name}`, target, "main");
	return target;
}

async function commitIn(dir: string, file: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, file), content);
	gitSync(dir, "add", file);
	gitSync(dir, "commit", "-q", "-m", `edit ${file}`);
}

/** Every kind of worktree the listing tells apart, plus the two it leaves out and one a session holds. */
async function scene(): Promise<Record<string, string>> {
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
function listedWorktrees(): string[] {
	return gitSync(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => realFolder(line.slice("worktree ".length)));
}

function byBranch(worktrees: RpcOrphanWorktree[], name: string): RpcOrphanWorktree | undefined {
	return worktrees.find(worktree => worktree.branch === `omp/gui/${name}`);
}

describe("classifyOrphan", () => {
	const base: OrphanFacts = {
		detached: false,
		dirtyFiles: 0,
		hasWork: true,
		landed: false,
		squashed: false,
		commitsAhead: 3,
	};
	const cases: [string, Partial<OrphanFacts>, unknown][] = [
		["dirty wins over landed", { dirtyFiles: 2, landed: true, commitsAhead: 0 }, { state: "dirty", commitsAhead: 0 }],
		["dirty keeps its own commits", { dirtyFiles: 1 }, { state: "dirty", commitsAhead: 3 }],
		[
			"no commit of its own and in the base is untouched",
			{ hasWork: false, landed: true, commitsAhead: 0 },
			{ state: "untouched", commitsAhead: 0 },
		],
		[
			"no reflog but unmerged commits is unlanded, not untouched",
			{ hasWork: false },
			{ state: "unlanded", commitsAhead: 3 },
		],
		["landed by ancestry", { landed: true, commitsAhead: 0 }, { state: "landed", commitsAhead: 0 }],
		[
			"landed by content says so",
			{ landed: true, squashed: true, commitsAhead: 0 },
			{ state: "landed", squashed: true, commitsAhead: 0 },
		],
		["commits nothing holds", {}, { state: "unlanded", commitsAhead: 3 }],
		[
			"detached outside the base never counts commits",
			{ detached: true, hasWork: false },
			{ state: "unlanded", commitsAhead: 0 },
		],
		[
			"detached inside the base is landed",
			{ detached: true, hasWork: false, landed: true, commitsAhead: 0 },
			{ state: "landed", commitsAhead: 0 },
		],
	];
	it.each(cases)("%s", (_name, patch, expected) => {
		expect(classifyOrphan({ ...base, ...patch })).toEqual(expected);
	});
});

describe("listOrphanWorktrees", () => {
	it(
		"lists what OMPdesk made under the root and no session uses, each with its state, newest commit first",
		async () => {
			const dirs = await scene();
			// Asked from a linked worktree too: the repository is the primary checkout's.
			const { root: listedRoot, worktrees } = await listOrphanWorktrees(dirs.inUse, deps);
			expect(listedRoot).toBe(wtRoot);
			expect(worktrees.map(worktree => worktree.path).sort()).toEqual(
				[dirs.landed, dirs.squashed, dirs.unlanded, dirs.dirty, dirs.untouched, dirs.detached].sort(),
			);
			expect(worktrees.every(worktree => worktree.repo === repo)).toBe(true);
			expect(byBranch(worktrees, "landed")).toMatchObject({ state: "landed", commitsAhead: 0, dirtyFiles: 0 });
			expect(byBranch(worktrees, "landed")?.squashed).toBeUndefined();
			expect(byBranch(worktrees, "squashed")).toMatchObject({ state: "landed", squashed: true, commitsAhead: 0 });
			expect(byBranch(worktrees, "unlanded")).toMatchObject({ state: "unlanded", commitsAhead: 2, dirtyFiles: 0 });
			expect(byBranch(worktrees, "dirty")).toMatchObject({ state: "dirty", commitsAhead: 0, dirtyFiles: 1 });
			expect(byBranch(worktrees, "untouched")).toMatchObject({ state: "untouched", commitsAhead: 0 });
			expect(worktrees.find(worktree => worktree.path === dirs.detached)).toMatchObject({
				branch: null,
				state: "landed",
				commitsAhead: 0,
			});
			const stamps = worktrees.map(worktree => worktree.modifiedAt);
			expect(stamps.every(stamp => stamp > 0)).toBe(true);
			expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
		},
		SLOW,
	);

	it(
		"leaves a worktree out while an open session sits in it or in a folder inside it",
		async () => {
			const dirs = await scene();
			open = [dirs.landed, path.join(dirs.inUse, "src", "deeper")];
			const { worktrees } = await listOrphanWorktrees(repo, deps);
			expect(byBranch(worktrees, "landed")).toBeUndefined();
			expect(byBranch(worktrees, "inuse")).toBeUndefined();
			expect(byBranch(worktrees, "squashed")).toBeDefined();
		},
		SLOW,
	);

	it("answers an empty list when the worktree root does not exist, and refuses a folder outside a repository", async () => {
		await fs.rm(wtRoot, { recursive: true });
		expect((await listOrphanWorktrees(repo, deps)).worktrees).toEqual([]);
		await expect(listOrphanWorktrees(root, deps)).rejects.toMatchObject({ code: "not_a_repo" });
	});
});

describe("removeOrphanWorktree", () => {
	it(
		"removes a landed, a squash-merged, an untouched and a detached worktree without forcing",
		async () => {
			const dirs = await scene();
			expect(await removeOrphanWorktree(repo, dirs.landed, deps)).toEqual({ removal: "removed" });
			expect(gitSync(repo, "branch", "--list", "omp/gui/landed")).toBe("");
			// `branch -d` refuses a branch whose commits are in no ancestry: the lossless outcome is to keep it.
			expect(await removeOrphanWorktree(repo, dirs.squashed, deps)).toEqual({ removal: "branch-kept" });
			expect(gitSync(repo, "branch", "--list", "omp/gui/squashed")).toContain("omp/gui/squashed");
			expect(await removeOrphanWorktree(repo, dirs.untouched, deps)).toEqual({ removal: "removed" });
			expect(await removeOrphanWorktree(repo, dirs.detached, deps)).toEqual({ removal: "removed" });
			for (const key of ["landed", "squashed", "untouched", "detached"]) {
				await expect(fs.stat(dirs[key] as string)).rejects.toThrow();
			}
			const left = (await listOrphanWorktrees(repo, deps)).worktrees.map(worktree => worktree.state).sort();
			expect(left).toEqual(["dirty", "unlanded"]);
		},
		SLOW,
	);

	it(
		"refuses an unlanded and a dirty worktree and loses none of the user's files",
		async () => {
			const dirs = await scene();
			const commits = gitSync(repo, "rev-parse", "omp/gui/unlanded");
			await expect(removeOrphanWorktree(repo, dirs.unlanded, deps)).rejects.toMatchObject({
				code: "not_removable",
				message: expect.stringContaining("unlanded"),
			});
			await expect(removeOrphanWorktree(repo, dirs.dirty, deps)).rejects.toMatchObject({
				code: "not_removable",
				message: expect.stringContaining("dirty"),
			});
			expect(gitSync(repo, "rev-parse", "omp/gui/unlanded")).toBe(commits);
			expect(gitSync(repo, "rev-list", "--count", "main..omp/gui/unlanded")).toBe("2");
			expect(await fs.readFile(path.join(dirs.unlanded, "two.ts"), "utf8")).toBe("2\n");
			expect(await fs.readFile(path.join(dirs.dirty, "scratch.txt"), "utf8")).toBe("unsaved");
			expect(gitSync(repo, "branch", "--list", "omp/gui/dirty")).toContain("omp/gui/dirty");
		},
		SLOW,
	);

	it(
		"refuses a worktree a session uses as in_use; one outside the root, one not made by OMPdesk, the primary checkout and unknown paths as not_orphan",
		async () => {
			const dirs = await scene();
			open = [dirs.inUse];
			const refused = [
				dirs.inUse,
				dirs.outside,
				dirs.notGui,
				repo,
				path.join(wtRoot, "gui-nothing-abcdef1"),
				"",
				root,
			];
			for (const target of refused) {
				const error = await removeOrphanWorktree(repo, target, deps).catch((reason: unknown) => reason);
				expect(error, target).toBeInstanceOf(LocalCommandError);
				expect((error as LocalCommandError).code, target).toBe(target === dirs.inUse ? "in_use" : "not_orphan");
			}
			for (const key of ["inUse", "outside", "notGui"]) await fs.stat(dirs[key] as string);
			expect(listedWorktrees()).toContain(realFolder(dirs.outside as string));
		},
		SLOW,
	);

	it(
		"keeps a worktree a tab opens on while the removal inspects it, and reports it in use",
		async () => {
			const dirs = await scene();
			const target = dirs.landed as string;
			let reads = 0;
			// The tab opens between the removal's listing (its first look at the open sessions) and git's deletion.
			const racing = {
				bridge,
				openFolders: () => {
					const now = [...open];
					if (++reads === 1) queueMicrotask(() => open.push(target));
					return now;
				},
			};
			await expect(removeOrphanWorktree(repo, target, racing)).rejects.toMatchObject({ code: "in_use" });
			await fs.stat(target);
			expect(listedWorktrees()).toContain(realFolder(target));
		},
		SLOW,
	);

	it(
		"takes the state from git at removal time, never from an earlier listing",
		async () => {
			const dirs = await scene();
			expect(byBranch((await listOrphanWorktrees(repo, deps)).worktrees, "landed")?.state).toBe("landed");
			await fs.writeFile(path.join(dirs.landed, "late.txt"), "written after the listing");
			await expect(removeOrphanWorktree(repo, dirs.landed, deps)).rejects.toMatchObject({ code: "not_removable" });
			expect(await fs.readFile(path.join(dirs.landed, "late.txt"), "utf8")).toBe("written after the listing");
		},
		SLOW,
	);
});

describe("sweepLandedWorktrees", () => {
	const branches = () =>
		gitSync(repo, "branch", "--list", "omp/gui/*", "--format=%(refname:short)").split("\n").filter(Boolean).sort();

	it(
		"removes every landed, squash-merged, untouched and detached orphan and keeps its branch",
		async () => {
			const dirs = await scene();
			const before = branches();
			const report = await sweepLandedWorktrees(deps);
			expect(report.root).toBe(wtRoot);
			expect(report.failed).toEqual([]);
			expect(report.removed.map(worktree => worktree.path).sort()).toEqual(
				[dirs.landed, dirs.squashed, dirs.untouched, dirs.detached].sort(),
			);
			for (const key of ["landed", "squashed", "untouched", "detached"]) {
				await expect(fs.stat(dirs[key] as string)).rejects.toThrow();
				expect(listedWorktrees()).not.toContain(realFolder(dirs[key] as string));
			}
			// Every branch stays, merged or not.
			expect(branches()).toEqual(before);
		},
		SLOW,
	);

	it(
		"keeps a dirty, an unlanded, an in-use, an outside-the-root and a non-OMPdesk worktree and the primary checkout",
		async () => {
			const dirs = await scene();
			const unlandedTip = gitSync(repo, "rev-parse", "omp/gui/unlanded");
			const report = await sweepLandedWorktrees(deps);
			expect(report.kept.map(worktree => worktree.state).sort()).toEqual(["dirty", "unlanded"]);
			for (const key of ["dirty", "unlanded", "inUse", "outside", "notGui"])
				expect(listedWorktrees(), key).toContain(realFolder(dirs[key] as string));
			expect(listedWorktrees()).toContain(realFolder(repo));
			expect(await fs.readFile(path.join(dirs.dirty, "scratch.txt"), "utf8")).toBe("unsaved");
			expect(gitSync(repo, "rev-parse", "omp/gui/unlanded")).toBe(unlandedTip);
		},
		SLOW,
	);

	it(
		"finds every repository with a worktree under the root and skips a folder git cannot place",
		async () => {
			const other = path.join(root, "other");
			await initRepo(other);
			const theirs = path.join(wtRoot, `gui-theirs-${HASH}`);
			gitSync(other, "worktree", "add", "-q", "-b", "omp/gui/theirs", theirs, "main");
			const ours = addWorktree("ours");
			await fs.mkdir(path.join(wtRoot, `gui-stray-${HASH}`));
			const report = await sweepLandedWorktrees(deps);
			expect(report.failed).toEqual([]);
			expect(report.removed.map(worktree => worktree.path).sort()).toEqual(
				[realFolder(theirs), realFolder(ours)].sort(),
			);
			await fs.stat(path.join(wtRoot, `gui-stray-${HASH}`));
		},
		SLOW,
	);

	it(
		"removes nothing in a dry run and reports what would go",
		async () => {
			const dirs = await scene();
			const report = await sweepLandedWorktrees(deps, { dryRun: true });
			expect(report.removed.map(worktree => worktree.path).sort()).toEqual(
				[dirs.landed, dirs.squashed, dirs.untouched, dirs.detached].sort(),
			);
			for (const key of ["landed", "squashed", "untouched", "detached"]) await fs.stat(dirs[key] as string);
		},
		SLOW,
	);
});

describe("sessionOpenFolders", () => {
	it("fails closed before a source is registered, then answers the registered one", () => {
		expect(() => sessionOpenFolders()).toThrow(LocalCommandError);
		setOpenFoldersSource(() => ["/a", "/b"]);
		expect(sessionOpenFolders()).toEqual(["/a", "/b"]);
	});
});
