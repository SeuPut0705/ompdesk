import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";
import { listSavedWorktrees } from "./saved-worktrees";

const w = diskCareWorld();

describe("disk care › line-ending rules", () => {
	it(
		"keeps a worktree whose files a restore would not bring back byte for byte (core.autocrlf=true, an LF file)",
		async () => {
			const dir = await w.busyWorktree("eol");
			// Git for Windows' default: a checkout of this repo writes CRLF, so the edited LF README would come back CRLF.
			gitSync(dir, "config", "core.autocrlf", "true");
			await w.care().run("user");
			expect(await exists(dir)).toBe(true);
			expect(w.listed()).toContain(dir);
			expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("hello, edited\n");
			expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
		},
		SLOW,
	);

	it(
		"keeps a worktree whose repo has a .gitattributes line-ending rule, even with nothing changed by it",
		async () => {
			const dir = await w.busyWorktree("attrs");
			await write(dir, ".gitattributes", "* text=auto\n");
			gitSync(dir, "add", ".gitattributes");
			gitSync(dir, "commit", "-q", "-m", "attrs");
			await w.care().run("user");
			expect(await exists(dir)).toBe(true);
			expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
		},
		SLOW,
	);

	for (const [where, setUp] of [
		[
			// Read lower-cased, the file is missing on a case-sensitive disk.
			"a core.attributesFile named with capitals and ~",
			async () => {
				await write(path.join(w.root, "home"), "Git Config/MyAttributes", "*.md text eol=crlf\n");
				gitSync(w.repo, "config", "core.attributesFile", "~/Git Config/MyAttributes");
			},
		],
		[
			// The saved commit carries it, so the restore's checkout applies it.
			"an untracked .gitattributes",
			async (dir: string) => write(dir, "notes/.gitattributes", "*.md text eol=crlf\n"),
		],
		[
			"the main repository's info/attributes, which git reads for every linked worktree",
			async () =>
				write(gitSync(w.repo, "rev-parse", "--absolute-git-dir"), "info/attributes", "notes/** eol=crlf\n"),
		],
	] as const) {
		it(
			`keeps a worktree whose line-ending rules come from ${where}`,
			async () => {
				const dir = await w.busyWorktree("attrs");
				await setUp(dir);
				await w.care().run("user");
				expect(w.listed()).toContain(dir);
				expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
				expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
				const kept = w.logs.filter(([message]) => message === "kept").map(([, details]) => String(details.reason));
				expect(kept.join("\n")).toMatch(/a restore could rewrite files/);
			},
			SLOW,
		);
	}
});
