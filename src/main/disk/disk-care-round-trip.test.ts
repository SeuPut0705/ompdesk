import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { diskCareWorld, exists, fileHashes, SLOW, write } from "./disk-care-fixture";
import { listSavedWorktrees, restoreSavedWorktree } from "./saved-worktrees";

const w = diskCareWorld();

describe("disk care › line endings round trip", () => {
	for (const [what, autocrlf, attributes, removed] of [
		["no conversion (core.autocrlf=false, no attributes)", "false", null, true],
		["core.autocrlf=true and * text=auto (Git for Windows)", "true", "* text=auto\n", false],
		["core.autocrlf=false and * text=auto", "false", "* text=auto\n", false],
		["core.autocrlf=input", "input", null, false],
		["* -text, which turns conversion off", "false", "* -text\n", true],
	] as const) {
		it(
			`brings back CRLF, LF and mixed files byte for byte or keeps the worktree: ${what}`,
			async () => {
				const name = `eol-${what.replace(/\W+/g, "-").slice(0, 24)}`;
				const dir = await w.worktree(name);
				gitSync(dir, "config", "core.autocrlf", autocrlf);
				if (attributes) await write(dir, ".gitattributes", attributes);
				await write(dir, "crlf.txt", "one\r\ntwo\r\n");
				await write(dir, "lf.txt", "one\ntwo\n");
				await write(dir, "mixed.txt", "one\r\ntwo\nthree\r\n");
				gitSync(dir, "add", ".");
				gitSync(dir, "commit", "-q", "-m", "line endings");
				// Uncommitted, staged and untracked work in every line ending, and an ignored file.
				await write(dir, "crlf.txt", "one\r\ntwo\r\nthree\r\n");
				await write(dir, "lf.txt", "one\ntwo\nthree\n");
				gitSync(dir, "add", "lf.txt");
				await write(dir, "mixed.txt", "one\ntwo\r\nthree\n");
				await write(dir, "new-crlf.txt", "a\r\nb\r\n");
				await write(dir, "new-mixed.txt", "a\nb\r\n");
				await write(dir, ".env", "A=1\r\nB=2\n");
				const before = await fileHashes(dir);

				await w.care().run("user");
				const [record] = await listSavedWorktrees(w.repo, w.saved);
				expect(Boolean(record), "removed").toBe(removed);
				if (record) {
					expect(await exists(dir)).toBe(false);
					await restoreSavedWorktree(record.id, w.saved);
				}
				expect(await fileHashes(dir)).toEqual(before);
			},
			SLOW,
		);
	}
});
