import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync, initRepo } from "./local/git/test-repos";
import { sweepLandedWorktrees } from "./worktree-orphans";
import {
	addWorktree,
	deps,
	HASH,
	installOrphansRig,
	listedWorktrees,
	repo,
	root,
	SLOW,
	scene,
	wtRoot,
} from "./worktree-orphans-test-rig";
import { realFolder } from "./worktree-removals";

installOrphansRig();

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
