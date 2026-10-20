import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { DAY_MS, diskCareWorld, SLOW, write } from "./disk-care-fixture";
import { listSavedWorktrees } from "./saved-worktrees";

const w = diskCareWorld();
const MONTH_AGO = new Date(Date.now() - 30 * DAY_MS);

/** Sets every file and folder under `dir` (deepest first, so a folder's own time is not moved after) to a month ago. */
async function backdate(dir: string): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) await backdate(path.join(dir, entry.name));
		else await fs.utimes(path.join(dir, entry.name), MONTH_AGO, MONTH_AGO);
	}
	await fs.utimes(dir, MONTH_AGO, MONTH_AGO);
}

/** A commit dated a month ago. */
function oldCommit(cwd: string, message: string): void {
	const date = MONTH_AGO.toISOString();
	const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
	process.env.GIT_AUTHOR_DATE = date;
	process.env.GIT_COMMITTER_DATE = date;
	try {
		gitSync(cwd, "commit", "-q", "-m", message);
	} finally {
		for (const [key, value] of [
			["GIT_AUTHOR_DATE", saved.author],
			["GIT_COMMITTER_DATE", saved.committer],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * The run reads every orphan's state once (`listAllOrphans`) and the save step works from it after the landed sweep.
 * A worktree that changes after that reading is judged again under its locks before anything is removed.
 */
describe("disk care › a worktree that changes after the shared listing", () => {
	for (const [what, change, intact] of [
		[
			"a new commit",
			(dir: string) => {
				writeFileSync(path.join(dir, "late.ts"), "late\n");
				gitSync(dir, "add", "late.ts");
				gitSync(dir, "commit", "-q", "-m", "late commit");
			},
			async (dir: string) => expect(gitSync(dir, "log", "-1", "--format=%s")).toBe("late commit"),
		],
		[
			"an edited tracked file",
			(dir: string) => writeFileSync(path.join(dir, "README.md"), "edited late\n"),
			async (dir: string) => expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("edited late\n"),
		],
		[
			"a new untracked file",
			(dir: string) => {
				mkdirSync(path.join(dir, "notes"), { recursive: true });
				writeFileSync(path.join(dir, "notes/late.md"), "late note\n");
			},
			async (dir: string) => expect(await fs.readFile(path.join(dir, "notes/late.md"), "utf8")).toBe("late note\n"),
		],
	] as const)
		for (const moment of ["after the landed sweep", "as the save step claims it"] as const)
			it(
				`keeps a worktree that gets ${what} ${moment}`,
				async () => {
					// Idle a month by every stamp disk care reads, with no build output (so nothing is dropped before saving).
					const target = await w.worktree("target");
					await write(target, "feature.ts", "export const done = 1;\n");
					gitSync(target, "add", "feature.ts");
					oldCommit(target, "feature");
					await write(target, "README.md", "hello, edited\n");
					await write(target, "notes/todo.md", "next: tests\n");
					await backdate(target);
					await backdate(gitSync(target, "rev-parse", "--absolute-git-dir"));
					// An untouched worktree the landed sweep removes: its log line comes after the listing, before the save step.
					await w.worktree("landed");

					// The landed sweep's log line comes after the shared listing; the next claim of a folder is the save step's,
					// whose open-folders read runs right before its own read of the worktree.
					let landed = false;
					let changed = false;
					const changeNow = () => {
						if (changed) return;
						changed = true;
						change(target);
					};
					await w
						.care(Date.now(), {
							log: (message, details) => {
								w.logs.push([message, details]);
								if (message !== "worktree-landed") return;
								landed = true;
								if (moment === "after the landed sweep") changeNow();
							},
							openFolders: () => {
								if (landed && moment === "as the save step claims it") changeNow();
								return w.open;
							},
						})
						.run("user");

					expect(changed, "the landed sweep ran and the change was made").toBe(true);
					expect(w.listed()).toContain(target);
					expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
					expect(w.savedRefs()).toEqual([]);
					await intact(target);
					if (moment === "as the save step claims it")
						expect(w.logs.filter(([message]) => message === "kept").map(([, details]) => details.reason)).toEqual(
							["it changed since it was judged idle"],
						);
					expect(await fs.readFile(path.join(target, "notes/todo.md"), "utf8")).toBe("next: tests\n");
				},
				SLOW,
			);

	it(
		"saves the same worktree when nothing changes after the listing",
		async () => {
			const target = await w.worktree("target");
			await write(target, "feature.ts", "export const done = 1;\n");
			gitSync(target, "add", "feature.ts");
			oldCommit(target, "feature");
			await write(target, "README.md", "hello, edited\n");
			await backdate(target);
			await backdate(gitSync(target, "rev-parse", "--absolute-git-dir"));
			await w.worktree("landed");
			await w.care(Date.now()).run("user");
			expect(w.listed()).not.toContain(target);
			expect((await listSavedWorktrees(w.repo, w.saved)).map(record => record.path)).toEqual([target]);
		},
		SLOW,
	);
});
