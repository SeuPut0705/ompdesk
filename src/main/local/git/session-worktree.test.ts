import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	decideWorktreeExit,
	removeSessionWorktree,
	type SessionWorktreeState,
	snapshotSessionWorktree,
	type WorktreeOnExit,
} from "./session-worktree";
import { pathExists as exists, gitSync as git, initRepo, stockShapedWorktree } from "./test-repos";

let scratch: string;
let repo: string;
let root: string;

beforeEach(async () => {
	scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-wt-")));
	repo = path.join(scratch, "repo");
	root = path.join(scratch, "wt");
	await initRepo(repo);
});

afterEach(async () => {
	await fs.rm(scratch, { recursive: true, force: true });
});

describe("decideWorktreeExit (stock session-worktree.ts 56-60)", () => {
	const clean: SessionWorktreeState = { dirty: false, moved: false, offBranch: false };
	const cases: Array<[WorktreeOnExit, Partial<SessionWorktreeState>, string]> = [
		["keep", {}, "keep"],
		["keep", { dirty: true, moved: true, offBranch: true }, "keep"],
		["remove", {}, "remove"],
		["remove", { dirty: true }, "prompt"],
		["remove", { moved: true }, "prompt"],
		["remove", { offBranch: true }, "prompt"],
		["ask", {}, "prompt"],
		["ask", { dirty: true }, "prompt"],
	];
	it.each(cases)("%s with %o → %s", (policy, state, action) => {
		expect(decideWorktreeExit(policy, { ...clean, ...state })).toBe(action);
	});
});

describe("snapshotSessionWorktree", () => {
	it("reports a fresh worktree clean, on its branch, not moved", async () => {
		const wt = await stockShapedWorktree(repo, root, "clean");
		const snapshot = await snapshotSessionWorktree(wt);
		expect(snapshot.present).toBe(true);
		expect(snapshot.state).toEqual({ dirty: false, moved: false, offBranch: false });
	});

	it("does not count gitignored files as dirty", async () => {
		const wt = await stockShapedWorktree(repo, root, "ignored");
		await fs.writeFile(path.join(wt.path, ".env"), "SECRET=1\n");
		expect((await snapshotSessionWorktree(wt)).state.dirty).toBe(false);
	});

	it("flags untracked and modified files, new commits, and a detached HEAD", async () => {
		const wt = await stockShapedWorktree(repo, root, "busy");
		await fs.writeFile(path.join(wt.path, "new.txt"), "x");
		expect((await snapshotSessionWorktree(wt)).state).toEqual({ dirty: true, moved: false, offBranch: false });

		git(wt.path, "add", ".");
		git(wt.path, "commit", "-q", "-m", "work");
		expect((await snapshotSessionWorktree(wt)).state).toEqual({ dirty: false, moved: true, offBranch: false });

		git(wt.path, "checkout", "-q", "--detach", "HEAD~1");
		expect((await snapshotSessionWorktree(wt)).state.offBranch).toBe(true);
	});

	it("changes its fingerprint when an already-modified file is edited again", async () => {
		const wt = await stockShapedWorktree(repo, root, "edit");
		await fs.writeFile(path.join(wt.path, "README.md"), "one\n");
		const first = await snapshotSessionWorktree(wt);
		await fs.writeFile(path.join(wt.path, "README.md"), "one more line\n");
		const second = await snapshotSessionWorktree(wt);
		expect(second.state).toEqual(first.state);
		expect(second.fingerprint).not.toBe(first.fingerprint);
		expect((await snapshotSessionWorktree(wt)).fingerprint).toBe(second.fingerprint);
	});

	it("treats a vanished worktree as absent and a missing source repository as moved", async () => {
		const wt = await stockShapedWorktree(repo, root, "gone");
		await fs.rm(wt.path, { recursive: true, force: true });
		const snapshot = await snapshotSessionWorktree(wt);
		expect(snapshot.present).toBe(false);
		expect(snapshot.state).toEqual({ dirty: false, moved: false, offBranch: false });
		expect((await snapshotSessionWorktree({ ...wt, sourceCwd: path.join(scratch, "no-repo") })).state.moved).toBe(
			true,
		);
	});
});

describe("removeSessionWorktree", () => {
	it("removes the checkout with its ignored files and deletes an unmoved branch", async () => {
		const wt = await stockShapedWorktree(repo, root, "bye");
		await fs.writeFile(path.join(wt.path, ".env"), "SECRET=1\n");
		await removeSessionWorktree(wt, false);
		expect(await exists(wt.path)).toBe(false);
		expect(git(repo, "branch", "--list", wt.branch)).toBe("");
		expect(git(repo, "worktree", "list")).not.toContain(wt.path);
	});

	it("keeps a moved branch", async () => {
		const wt = await stockShapedWorktree(repo, root, "kept-branch");
		await removeSessionWorktree(wt, true);
		expect(await exists(wt.path)).toBe(false);
		expect(git(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
	});

	it("only prunes a worktree that already vanished", async () => {
		const wt = await stockShapedWorktree(repo, root, "vanished");
		await fs.rm(wt.path, { recursive: true, force: true });
		await removeSessionWorktree(wt, false);
		expect(git(repo, "worktree", "list")).not.toContain(wt.path);
		expect(git(repo, "branch", "--list", wt.branch)).toBe("");
	});

	it("refuses a checkout outside the root it was created under and leaves it alone", async () => {
		const wt = await stockShapedWorktree(repo, root, "elsewhere");
		await expect(
			removeSessionWorktree({ ...wt, root: path.join(scratch, "other-root") }, false),
		).rejects.toMatchObject({
			code: "worktree_outside_root",
		});
		await expect(removeSessionWorktree({ ...wt, path: repo }, false)).rejects.toMatchObject({
			code: "worktree_outside_root",
		});
		expect(await exists(wt.path)).toBe(true);
		expect(await exists(path.join(repo, "README.md"))).toBe(true);
	});
});
