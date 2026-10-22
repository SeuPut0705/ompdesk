import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "./local/git/test-repos";
import { LocalCommandError } from "./local/types";
import { listOrphanWorktrees, removeOrphanWorktree } from "./worktree-orphans";
import {
	bridge,
	byBranch,
	deps,
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
