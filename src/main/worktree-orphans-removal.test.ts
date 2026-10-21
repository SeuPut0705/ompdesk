import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync, initRepo } from "./local/git/test-repos";
import { LocalCommandError } from "./local/types";
import { listOrphanWorktrees, removeOrphanWorktree, sweepLandedWorktrees } from "./worktree-orphans";
import {
	addWorktree,
	bridge,
	byBranch,
	deps,
	HASH,
	installOrphansRig,
	listedWorktrees,
	open,
	repo,
	root,
	SLOW,
	scene,
	setOpen,
	wtRoot,
} from "./worktree-orphans-test-rig";
import { realFolder } from "./worktree-removals";

installOrphansRig();

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
			setOpen([dirs.inUse]);
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
