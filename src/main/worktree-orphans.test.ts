import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalCommandError } from "./local/types";
import { listOrphanWorktrees, sessionOpenFolders, setOpenFoldersSource } from "./worktree-orphans";

import {
	byBranch,
	deps,
	installOrphansRig,
	repo,
	root,
	SLOW,
	scene,
	setOpen,
	wtRoot,
} from "./worktree-orphans-test-rig";

installOrphansRig();

// classifyOrphan moved to the core process with its cases (native/ompdesk/crates/core/src/git/orphans.rs).

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
			setOpen([dirs.landed, path.join(dirs.inUse, "src", "deeper")]);
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

describe("sessionOpenFolders", () => {
	it("fails closed before a source is registered, then answers the registered one", () => {
		expect(() => sessionOpenFolders()).toThrow(LocalCommandError);
		setOpenFoldersSource(() => ["/a", "/b"]);
		expect(sessionOpenFolders()).toEqual(["/a", "/b"]);
	});
});
