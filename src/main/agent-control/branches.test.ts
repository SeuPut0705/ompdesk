import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { branchFacts, landingFacts } from "./branches";

import {
	agentWorktree,
	childOnRemoteMain,
	commitIn,
	installBranchesRig,
	repo,
	staleParentMain,
} from "./branches-test-rig";

installBranchesRig();

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
