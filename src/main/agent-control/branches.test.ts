import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveBeforeRemove,
	discardOpenedWorktree,
	restoreSavedWorktree,
	SavedWorktreeStore,
} from "../disk/saved-worktrees";
import { gitSync, initRepo } from "../local/git/test-repos";
import { noteOmpExit } from "../omp-exits";
import type { BeforeRemove } from "../worktree-orphans";
import { removalHolds } from "../worktree-removals";
import {
	BranchError,
	boundDiff,
	branchEvidence,
	branchFacts,
	discardNewWorktree,
	landingFacts,
	mergeBranch,
	predictMerge,
	removeSafeWorktree,
	type WorktreeRef,
} from "./branches";

let root: string;
let repo: string;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-branches-")));
	repo = path.join(root, "repo");
	await initRepo(repo);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** What `worktree_create` leaves: a branch off the parent's HEAD, checked out beside it. */
async function agentWorktree(name: string): Promise<WorktreeRef> {
	const branch = `omp/agent/${name}`;
	const target = path.join(root, `wt-${name}`);
	gitSync(repo, "branch", "--no-track", branch, "HEAD");
	gitSync(repo, "worktree", "add", "-q", target, branch);
	gitSync(target, "config", "user.email", "agent@example.com");
	gitSync(target, "config", "user.name", "Agent");
	return { path: target, branch, baseCwd: repo };
}

async function commitIn(dir: string, file: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, file), content);
	gitSync(dir, "add", file);
	gitSync(dir, "commit", "-q", "-m", `edit ${file}`);
}

/**
 * The parent tracks a bare remote (`main` → `origin/main`, no `origin/HEAD`), and another clone pushed three commits
 * there that the parent fetched but never pulled: its local main is stale, as a checkout agents push past is.
 */
async function staleParentMain(): Promise<void> {
	const remote = path.join(root, "remote.git");
	gitSync(root, "init", "-q", "--bare", "-b", "main", remote);
	gitSync(repo, "remote", "add", "origin", remote);
	gitSync(repo, "push", "-q", "-u", "origin", "main");
	const other = path.join(root, "other");
	gitSync(root, "clone", "-q", remote, other);
	gitSync(other, "config", "user.email", "other@example.com");
	gitSync(other, "config", "user.name", "Other");
	for (const name of ["x.ts", "y.ts", "z.ts"]) await commitIn(other, name, `${name}\n`);
	gitSync(other, "push", "-q", "origin", "main");
	gitSync(repo, "fetch", "-q", "origin");
	// Newer git records `origin/HEAD` on fetch; drop it so only `main@{upstream}` can name the remote's main.
	gitSync(repo, "update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD");
}

/** A child cut from the parent's stale HEAD that rebased onto the remote's main (`git fetch && git rebase origin/main`). */
async function childOnRemoteMain(name: string): Promise<WorktreeRef> {
	const wt = await agentWorktree(name);
	gitSync(wt.path, "rebase", "-q", "origin/main");
	await commitIn(wt.path, "own.ts", "own\n");
	return wt;
}

describe("branchFacts", () => {
	it("reports commits, changed files with counts, uncommitted and untracked work", async () => {
		const wt = await agentWorktree("a");
		await commitIn(wt.path, "feature.ts", "one\ntwo\n");
		await fs.writeFile(path.join(wt.path, "README.md"), "hello\nmore\n");
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		const facts = await branchFacts(wt);
		expect(facts).toMatchObject({
			branch: "omp/agent/a",
			baseBranch: "main",
			commitsAhead: 1,
			uncommitted: 1,
			untracked: 1,
			merged: false,
		});
		expect(facts.files).toEqual(
			expect.arrayContaining([
				{ path: "feature.ts", added: 2, removed: 0 },
				{ path: "README.md", added: 1, removed: 0 },
			]),
		);
	});

	it("sees a branch that is already in the parent, and the parent's own edits", async () => {
		const wt = await agentWorktree("b");
		await commitIn(wt.path, "x.ts", "x\n");
		gitSync(repo, "merge", "-q", "--no-edit", wt.branch);
		expect((await branchFacts(wt)).merged).toBe(true);
		await fs.writeFile(path.join(repo, "README.md"), "changed\n");
		expect((await branchFacts(wt)).baseUncommitted).toBe(1);
	});
});

describe("branchFacts against a stale parent checkout", () => {
	it("counts a child that pushed its work to the remote's main as landed, with nothing to review", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("pushed");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 0,
			files: [],
			uncommitted: 0,
			untracked: 0,
			merged: true,
		});
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, clean: true });
		// The parent checkout was only read: its local main still sits where it was.
		expect(gitSync(repo, "rev-list", "--count", "main..origin/main")).toBe("4");
	});

	it("measures an unpushed commit against the remote's main: one commit, its own file only", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("unpushed");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 1,
			files: [{ path: "own.ts", added: 1, removed: 0 }],
			merged: false,
		});
		expect((await landingFacts(wt)).landed).toBe(false);
	});

	it("shows only the uncommitted or untracked work a landed child left behind", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("leftover");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		await fs.writeFile(path.join(wt.path, "own.ts"), "own\nmore\n");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 0,
			files: [{ path: "own.ts", added: 1, removed: 0 }],
			uncommitted: 1,
			untracked: 0,
			merged: true,
		});
		gitSync(wt.path, "checkout", "-q", "--", "own.ts");
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 0,
			files: [],
			uncommitted: 0,
			untracked: 1,
			merged: true,
		});
	});
});

describe("mergeBranch", () => {
	it("merges the branch into the parent's branch with a merge commit and pushes nothing", async () => {
		const wt = await agentWorktree("c");
		await commitIn(wt.path, "feature.ts", "export const x = 1;\n");
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toMatchObject({ merged: true });
		expect((await fs.readFile(path.join(repo, "feature.ts"), "utf8")).replaceAll("\r\n", "\n")).toBe(
			"export const x = 1;\n",
		);
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("Merge omp/agent/c into main (Worker)");
		expect(gitSync(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
		expect(gitSync(repo, "remote")).toBe("");
	});

	it("predicts a conflicting merge, names the files and never touches the parent's checkout", async () => {
		const wt = await agentWorktree("d");
		await commitIn(wt.path, "README.md", "from the agent\n");
		await commitIn(repo, "README.md", "from the parent\n");
		const head = gitSync(repo, "rev-parse", "HEAD");
		const origHead = path.join(repo, ".git", "ORIG_HEAD");
		const origBefore = await fs.readFile(origHead, "utf8").catch(() => null);
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toEqual({ merged: false, reason: "conflict", files: ["README.md"], predicted: true });
		expect(gitSync(repo, "rev-parse", "HEAD")).toBe(head);
		expect(gitSync(repo, "status", "--porcelain")).toBe("");
		expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
		expect(await fs.readFile(origHead, "utf8").catch(() => null)).toBe(origBefore);
		expect((await fs.readFile(path.join(repo, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
			"from the parent\n",
		);
	});

	it("refuses to lose uncommitted work, to mix with the parent's edits, to merge nothing or into a detached HEAD", async () => {
		const wt = await agentWorktree("e");
		await expect(mergeBranch(wt, "")).rejects.toThrow(/nothing to merge/);
		await commitIn(wt.path, "a.ts", "a\n");
		await fs.writeFile(path.join(wt.path, "README.md"), "dirty\n");
		await expect(mergeBranch(wt, "")).rejects.toThrow(/uncommitted file/);
		gitSync(wt.path, "checkout", "--", "README.md");
		await fs.writeFile(path.join(repo, "README.md"), "dirty parent\n");
		await expect(mergeBranch(wt, "")).rejects.toThrow(/commit or stash/);
		gitSync(repo, "checkout", "--", "README.md");
		gitSync(repo, "checkout", "-q", "--detach");
		await expect(mergeBranch(wt, "")).rejects.toBeInstanceOf(BranchError);
		await expect(mergeBranch(wt, "")).rejects.toThrow(/detached/);
	});
});

describe("landingFacts", () => {
	it("says an untouched branch has no work to land, however trivially it sits in the parent", async () => {
		const wt = await agentWorktree("g");
		expect(await landingFacts(wt)).toEqual({ hasWork: false, landed: true, clean: true });
	});

	it("tells commits nothing merged from commits that were, by a local merge", async () => {
		const wt = await agentWorktree("h");
		await commitIn(wt.path, "a.ts", "a\n");
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: false, clean: true });
		await mergeBranch(wt, "Worker");
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, clean: true });
	});

	it("counts a branch pushed to the remote's default branch as landed, and reads untracked or edited files as unclean", async () => {
		const remote = path.join(root, "remote.git");
		gitSync(root, "init", "-q", "--bare", "-b", "main", remote);
		gitSync(repo, "remote", "add", "origin", remote);
		gitSync(repo, "push", "-q", "origin", "main");
		gitSync(repo, "remote", "set-head", "origin", "main");
		const wt = await agentWorktree("i");
		await commitIn(wt.path, "b.ts", "b\n");
		expect((await landingFacts(wt)).landed).toBe(false);
		gitSync(wt.path, "push", "-q", remote, `${wt.branch}:main`);
		gitSync(repo, "fetch", "-q", "origin");
		// The parent's own branch has not moved: only the remote's default knows the commit.
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, clean: true });
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		expect((await landingFacts(wt)).clean).toBe(false);
		await fs.rm(path.join(wt.path, "scratch.txt"));
		await fs.writeFile(path.join(wt.path, "README.md"), "edited\n");
		expect((await landingFacts(wt)).clean).toBe(false);
	});
});

describe("removeSafeWorktree", () => {
	it("removes a merged worktree and its branch without forcing, and an untouched one too", async () => {
		const wt = await agentWorktree("j");
		await commitIn(wt.path, "a.ts", "a\n");
		await mergeBranch(wt, "Worker");
		expect(await removeSafeWorktree(wt)).toBe("removed");
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", wt.branch)).toBe("");

		// Nothing was ever done there: removing it loses nothing.
		const untouched = await agentWorktree("m");
		expect(await removeSafeWorktree(untouched)).toBe("removed");
		await expect(fs.stat(untouched.path)).rejects.toThrow();
	});

	it("keeps everything for unmerged commits, uncommitted or untracked files and a main checkout", async () => {
		const unmerged = await agentWorktree("k");
		await commitIn(unmerged.path, "a.ts", "a\n");
		expect(await removeSafeWorktree(unmerged)).toBeNull();
		await fs.stat(unmerged.path);

		const dirty = await agentWorktree("l");
		await commitIn(dirty.path, "b.ts", "b\n");
		await mergeBranch(dirty, "Worker");
		await fs.writeFile(path.join(dirty.path, "scratch.txt"), "unsaved");
		expect(await removeSafeWorktree(dirty)).toBeNull();
		expect(await fs.readFile(path.join(dirty.path, "scratch.txt"), "utf8")).toBe("unsaved");
		expect(gitSync(repo, "branch", "--list", dirty.branch)).toContain(dirty.branch);

		expect(await removeSafeWorktree({ path: repo, branch: "main", baseCwd: repo })).toBeNull();
	});
});

describe("discardNewWorktree", () => {
	const archive = () => archiveBeforeRemove(new SavedWorktreeStore(path.join(root, "care")), null);

	it("takes back a worktree and branch nobody used, even when the parent's main is behind the branch's base", async () => {
		await staleParentMain();
		// What `worktree_create` with base "default" makes: a branch off origin/main, which the parent's main lacks.
		const branch = "omp/agent/fresh";
		const target = path.join(root, "wt-fresh");
		gitSync(repo, "branch", "--no-track", branch, "origin/main");
		gitSync(repo, "worktree", "add", "-q", target, branch);
		const wt = { path: target, branch, baseCwd: repo };
		// The safe removal of a finished child's worktree keeps that branch (`branch -d` against the stale main).
		expect(await discardNewWorktree(wt, archive())).toBe("removed");
		await expect(fs.stat(target)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", branch)).toBe("");
	});

	it("keeps a worktree with files in it and a branch that moved since it was made", async () => {
		const dirty = await agentWorktree("busy");
		await fs.writeFile(path.join(dirty.path, "scratch.txt"), "unsaved");
		expect(await discardNewWorktree(dirty, archive())).toBeNull();
		expect(await fs.readFile(path.join(dirty.path, "scratch.txt"), "utf8")).toBe("unsaved");

		const moved = await agentWorktree("moved");
		await commitIn(moved.path, "a.ts", "a\n");
		expect(await discardNewWorktree(moved, archive())).toBeNull();
		await fs.stat(moved.path);
		expect(gitSync(repo, "branch", "--list", moved.branch)).toContain(moved.branch);

		expect(await discardNewWorktree({ path: repo, branch: "main", baseCwd: repo }, archive())).toBeNull();
	});

	it("archives ignored data git would delete before it removes the worktree, and keeps it when the archive refuses", async () => {
		const wt = await agentWorktree("seeded");
		// A seeded `.env` the setup edited: ignored, so `git worktree remove` would delete it without asking.
		await fs.writeFile(path.join(wt.path, ".env"), "TOKEN=edited\n");
		const store = new SavedWorktreeStore(path.join(root, "care"));
		expect(await discardNewWorktree(wt, archiveBeforeRemove(store, null))).toBe("removed");
		await expect(fs.stat(wt.path)).rejects.toThrow();
		const [record] = await store.list();
		expect(record).toMatchObject({
			path: await fs.realpath(path.dirname(wt.path)).then(dir => path.join(dir, "wt-seeded")),
			archivedFiles: 1,
		});
		const restored = await restoreSavedWorktree(record?.id ?? "", store);
		expect(await fs.readFile(path.join(restored.path, ".env"), "utf8")).toBe("TOKEN=edited\n");

		const kept = await agentWorktree("kept");
		const refusing: BeforeRemove = async () => {
			throw new Error("keep it");
		};
		expect(await discardNewWorktree(kept, refusing)).toBeNull();
		await fs.stat(kept.path);
		expect(gitSync(repo, "branch", "--list", kept.branch)).toContain(kept.branch);
	});

	it("holds the removal claim while it archives, so no session starts there, and keeps a worktree something uses", async () => {
		const store = new SavedWorktreeStore(path.join(root, "care"));
		const wt = await agentWorktree("claimed");
		const asked = Promise.withResolvers<void>();
		const listing = Promise.withResolvers<string[]>();
		const discarding = discardOpenedWorktree(wt, {
			openFolders: () => [],
			processes: () => {
				asked.resolve();
				return listing.promise;
			},
			store: () => store,
		});
		await asked.promise;
		// Mid-discard a tab cannot open there (SidecarPool.acquire and a device's tab.open ask this).
		expect(removalHolds(wt.path)).toBe(true);
		listing.resolve([]);
		expect(await discarding).toBe("removed");
		expect(removalHolds(wt.path)).toBe(false);

		// A session of this computer still has it open: refused, nothing removed.
		const open = await agentWorktree("open");
		await expect(
			discardOpenedWorktree(open, { openFolders: () => [open.path], processes: async () => [], store: () => store }),
		).rejects.toThrow("in use");
		await fs.stat(open.path);

		// A process still works in it (a job the closed omp left): kept after the wait.
		const busy = await agentWorktree("busy-omp");
		const real = await fs.realpath(busy.path);
		const pauses: number[] = [];
		const kept = await discardOpenedWorktree(busy, {
			openFolders: () => [],
			processes: async () => [real],
			store: () => store,
			pause: async ms => {
				pauses.push(ms);
			},
		});
		expect(kept).toBeNull();
		expect(pauses.length).toBeGreaterThan(0);
		await fs.stat(busy.path);
	});

	it("on Windows, where no process folder can be read, removes it once the closed omp's exit is confirmed, else keeps it", async () => {
		const store = new SavedWorktreeStore(path.join(root, "care"));
		const windows = { openFolders: () => [], processes: async () => null, store: () => store };

		// The closed tab's omp is still running there: kept.
		const running = await agentWorktree("win-running");
		const { promise: never } = Promise.withResolvers<void>();
		noteOmpExit(running.path, never);
		expect(await discardOpenedWorktree(running, { ...windows, ompsExited: async () => false })).toBeNull();
		await fs.stat(running.path);

		// Its exit noted and settled: removed, branch and all.
		const exited = await agentWorktree("win-exited");
		const gone = Promise.withResolvers<void>();
		noteOmpExit(exited.path, gone.promise);
		const discarding = discardOpenedWorktree(exited, windows);
		gone.resolve();
		expect(await discarding).toBe("removed");
		await expect(fs.stat(exited.path)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", exited.branch)).toBe("");
	});
});

describe("boundDiff", () => {
	const section = (file: string, lines: number): string =>
		`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}\n`).join("")}`;

	it("returns the whole diff when it fits and nothing when there is no budget", () => {
		const diff = section("a.ts", 3);
		expect(boundDiff(diff, diff.length)).toEqual({ text: diff, omitted: 0 });
		expect(boundDiff(diff, 0)).toEqual({ text: "", omitted: diff.length });
		expect(boundDiff("", 100)).toEqual({ text: "", omitted: 0 });
	});

	it("gives a small source file its whole hunk however big the lockfile beside it is", () => {
		const source = section("src/app.ts", 4);
		const lock = section("package-lock.json", 5000);
		const { text, omitted } = boundDiff(lock + source, 2000);
		expect(text).toContain(source);
		expect(text).toMatch(/… \d+ more lines of package-lock\.json left out\n/);
		expect(text.length).toBeLessThanOrEqual(2000);
		expect(omitted).toBeGreaterThan(0);
		expect(omitted).toBe(lock.length + source.length - text.replace(/… .* left out\n/, "").length);
	});

	it("cuts at a line boundary and says how many lines it left out", () => {
		const { text } = boundDiff(section("big.ts", 100), 300);
		expect(text.endsWith(" left out\n")).toBe(true);
		const kept = text.split("\n").filter(line => line.startsWith("+line "));
		expect(kept.every(line => /^\+line \d+$/.test(line))).toBe(true);
		const left = Number(/… (\d+) more line/.exec(text)?.[1]);
		expect(kept.length + left).toBe(100);
	});
});

describe("branchEvidence", () => {
	it("carries the child's diff against where it lands, cut to the budget, and the merge prediction", async () => {
		const wt = await agentWorktree("ev");
		await commitIn(wt.path, "feature.ts", "export const added = 1;\n");
		await fs.writeFile(path.join(wt.path, "README.md"), "hello\nuncommitted line\n");
		const evidence = await branchEvidence(wt, 10_000);
		expect(evidence.diff).toContain("+export const added = 1;");
		expect(evidence.diff).toContain("+uncommitted line");
		expect(evidence.diffOmitted).toBe(0);
		expect(evidence.merge).toEqual({ kind: "clean" });
	});

	it("skips the diff at a budget of 0 and reports a cut one", async () => {
		const wt = await agentWorktree("ev0");
		await commitIn(wt.path, "feature.ts", `${"x".repeat(80)}\n`.repeat(50));
		expect(await branchEvidence(wt, 0)).toMatchObject({ diff: "", diffOmitted: 0 });
		const cut = await branchEvidence(wt, 400);
		expect(cut.diff.length).toBeLessThanOrEqual(400);
		expect(cut.diffOmitted).toBeGreaterThan(0);
	});
});

describe("predictMerge", () => {
	it("names the file two branches changed on the same lines, and calls disjoint work clean", async () => {
		const clashing = await agentWorktree("clash");
		await commitIn(clashing.path, "README.md", "from the agent\n");
		const disjoint = await agentWorktree("apart");
		await commitIn(disjoint.path, "feature.ts", "x\n");
		await commitIn(repo, "README.md", "from the parent\n");
		expect(await predictMerge(clashing)).toEqual({ kind: "conflict", files: ["README.md"] });
		expect(await predictMerge(disjoint)).toEqual({ kind: "clean" });
	});

	it("says unknown for a branch that no longer exists", async () => {
		const wt = await agentWorktree("gone");
		const result = await predictMerge({ ...wt, branch: "omp/agent/missing" });
		expect(result.kind).toBe("unknown");
	});

	it("writes its merged tree to a scratch store: the repo's object counts, status and HEAD stay as they were", async () => {
		const wt = await agentWorktree("quiet");
		await commitIn(wt.path, "feature.ts", "from the agent\n");
		await commitIn(repo, "other.ts", "from the parent\n");
		const counts = () =>
			gitSync(repo, "count-objects", "-v")
				.split("\n")
				.filter(line => /^(count|in-pack):/.test(line));
		const head = gitSync(repo, "rev-parse", "HEAD");
		const before = counts();
		expect(before).toHaveLength(2);
		expect(await predictMerge(wt)).toEqual({ kind: "clean" });
		expect(counts()).toEqual(before);
		expect(gitSync(repo, "status", "--porcelain")).toBe("");
		expect(gitSync(repo, "rev-parse", "HEAD")).toBe(head);
	});
});

/** What a squash-merge PR does: one new commit on the parent's main holding the branch's net change; the branch's own commits are in no ancestry. */
function squashMerge(wt: WorktreeRef): void {
	gitSync(repo, "merge", "--squash", wt.branch);
	gitSync(repo, "commit", "-q", "-m", `squash ${wt.branch}`);
}

describe("a branch squash-merged into the parent's main", () => {
	it("counts as landed by content in landingFacts and branchFacts, with nothing of its own left", async () => {
		const wt = await agentWorktree("sq1");
		await commitIn(wt.path, "a.ts", "a\n");
		await commitIn(wt.path, "b.ts", "b\n");
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: false, clean: true });
		squashMerge(wt);
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, squashed: true, clean: true });
		expect(await branchFacts(wt)).toMatchObject({
			merged: true,
			commitsAhead: 0,
			files: [],
			uncommitted: 0,
			untracked: 0,
		});
	});

	it("writes no object into the repository while judging landing by content", async () => {
		const wt = await agentWorktree("sq0");
		await commitIn(wt.path, "a.ts", "a\n");
		await commitIn(repo, "unrelated.ts", "u\n");
		// A merge of the two would be a new tree: `merge-tree --write-tree` has to build it somewhere.
		const objects = () => gitSync(repo, "count-objects", "-v");
		const before = objects();
		expect((await landingFacts(wt)).landed).toBe(false);
		expect(objects()).toBe(before);
	});

	it("lists only the work left in the worktree after the squash", async () => {
		const wt = await agentWorktree("sq2");
		await commitIn(wt.path, "a.ts", "a\n");
		squashMerge(wt);
		await fs.writeFile(path.join(wt.path, "a.ts"), "a\nmore\n");
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		expect(await branchFacts(wt)).toMatchObject({
			merged: true,
			commitsAhead: 0,
			files: [{ path: "a.ts", added: 1, removed: 0 }],
			uncommitted: 1,
			untracked: 1,
		});
		expect(await landingFacts(wt)).toMatchObject({ landed: true, squashed: true, clean: false });
	});

	it("counts as landed by patch equivalence when main has moved on over the same files (a cherry-pick)", async () => {
		const wt = await agentWorktree("sq3");
		await commitIn(wt.path, "a.ts", "a\n");
		await commitIn(repo, "unrelated.ts", "u\n");
		gitSync(repo, "cherry-pick", wt.branch);
		await commitIn(repo, "a.ts", "a\nlater\n");
		expect(await landingFacts(wt)).toMatchObject({ landed: true, squashed: true });
	});

	it("keeps a branch with real unmerged work unlanded, even when part of it was squashed", async () => {
		const wt = await agentWorktree("sq4");
		await commitIn(wt.path, "a.ts", "a\n");
		squashMerge(wt);
		await commitIn(wt.path, "b.ts", "b\n");
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: false, clean: true });
		expect(await branchFacts(wt)).toMatchObject({ merged: false, commitsAhead: 2 });

		const other = await agentWorktree("sq5");
		await commitIn(other.path, "c.ts", "c\n");
		await commitIn(repo, "unrelated.ts", "u\n");
		expect((await landingFacts(other)).landed).toBe(false);
	});

	it("lets removeSafeWorktree take the worktree and keep the branch, which `branch -d` refuses", async () => {
		const wt = await agentWorktree("sq6");
		await commitIn(wt.path, "a.ts", "a\n");
		squashMerge(wt);
		expect(await removeSafeWorktree(wt)).toBe("branch-kept");
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", wt.branch)).toContain(wt.branch);

		const left = await agentWorktree("sq7");
		await commitIn(left.path, "d.ts", "d\n");
		squashMerge(left);
		await fs.writeFile(path.join(left.path, "scratch.txt"), "unsaved");
		expect(await removeSafeWorktree(left)).toBeNull();
		expect(await fs.readFile(path.join(left.path, "scratch.txt"), "utf8")).toBe("unsaved");
	});
});
