import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";
import { listSavedWorktrees, restoreSavedWorktree, SavedWorktreeStore } from "./saved-worktrees";

const w = diskCareWorld();

describe("disk care › saving", () => {
	it.skipIf(process.platform === "win32")(
		"keeps the saved branch, archive and record when git stops removing a worktree half way",
		async () => {
			const dir = await w.busyWorktree("partial");
			// A folder git cannot empty: the forced removal deletes what it can and fails on it.
			await fs.chmod(path.join(dir, "notes"), 0o555);
			try {
				await w.care().run("user");
			} finally {
				await fs.chmod(path.join(dir, "notes"), 0o755).catch(() => {});
			}
			expect(w.logs.some(([message, details]) => message === "failed" && details.step === "worktree-saved")).toBe(
				true,
			);
			const [record] = await listSavedWorktrees(w.repo, w.saved);
			expect(record?.path).toBe(dir);
			expect(w.savedRefs()).toEqual([record?.savedBranch]);
			expect(gitSync(w.repo, "show", `${record?.savedBranch}:notes/todo.md`)).toBe("next: tests");
			const archive = path.join(w.userData, "disk-care", "saved", record?.id ?? "", "files");
			expect(await fs.readFile(path.join(archive, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
		},
		SLOW,
	);

	it(
		"leaves the worktree untouched and keeps no stray branch or archive when the record cannot be written",
		async () => {
			const dir = await w.busyWorktree("unrecorded");
			w.saved = new (class extends SavedWorktreeStore {
				override update(): Promise<void> {
					return Promise.reject(new Error("disk full"));
				}
			})(path.join(w.userData, "disk-care"));
			await w.care().run("user");
			expect(w.listed()).toContain(dir);
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
			expect(w.savedRefs()).toEqual([]);
			expect(await fs.readdir(path.join(w.userData, "disk-care", "saved")).catch(() => [])).toEqual([]);
		},
		SLOW,
	);

	it(
		"brings back what was staged and what was edited after it, each where it was",
		async () => {
			const dir = await w.busyWorktree("staged");
			await write(dir, "README.md", "staged A\n");
			gitSync(dir, "add", "README.md");
			await write(dir, "README.md", "working B\n");
			await write(dir, "added.ts", "staged only\n");
			gitSync(dir, "add", "added.ts");
			await fs.rm(path.join(dir, "added.ts"));
			await w.care().run("user");
			expect(w.listed()).not.toContain(dir);
			const [record] = await listSavedWorktrees(w.repo, w.saved);
			await restoreSavedWorktree(record?.id ?? "", w.saved);
			expect(gitSync(dir, "show", ":README.md")).toBe("staged A");
			expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toBe("working B\n");
			expect(gitSync(dir, "show", ":added.ts")).toBe("staged only");
			expect(await exists(path.join(dir, "added.ts"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "notes/todo.md"), "utf8")).toBe("next: tests\n");
		},
		SLOW,
	);

	it(
		"keeps a worktree whose staged files hold a secret",
		async () => {
			const dir = await w.busyWorktree("staged-secret");
			await write(dir, "config.json", '{"token": "ghp_abcdefghijklmnopqrstuvwxyz0123"}\n');
			gitSync(dir, "add", "config.json");
			await write(dir, "config.json", "{}\n");
			await w.care().run("user");
			expect(w.listed()).toContain(dir);
			expect(w.savedRefs()).toEqual([]);
			expect(
				w.logs.some(([message, details]) => message === "kept" && String(details.reason).includes("secret")),
			).toBe(true);
		},
		SLOW,
	);

	it(
		"keeps a plain JSON password and a token past the first megabyte out of git, and brings both back",
		async () => {
			const dir = await w.busyWorktree("credentials");
			await write(dir, "config.json", '{"password": "my-real-password"}\n');
			await write(
				dir,
				"data/big.txt",
				`${"a".repeat(2 * 1024 * 1024)}\nAPI token ghp_abcdefghijklmnopqrstuvwxyz0123\n`,
			);
			await w.care().run("user");
			expect(w.listed()).not.toContain(dir);
			const [record] = await listSavedWorktrees(w.repo, w.saved);
			const savedFiles = gitSync(w.repo, "show", "--name-only", "--format=", record?.savedBranch ?? "");
			expect(savedFiles.split("\n").sort()).toEqual(["README.md", "notes/todo.md"]);
			expect(gitSync(w.repo, "log", "--all", "--format=%H", "--", "config.json", "data/big.txt")).toBe("");
			await restoreSavedWorktree(record?.id ?? "", w.saved);
			expect(await fs.readFile(path.join(dir, "config.json"), "utf8")).toContain("my-real-password");
			expect(await fs.readFile(path.join(dir, "data/big.txt"), "utf8")).toContain(
				"ghp_abcdefghijklmnopqrstuvwxyz0123",
			);
		},
		SLOW,
	);

	for (const [what, file] of [
		["an already modified tracked file", "README.md"],
		["an ignored .env", ".env"],
	] as const) {
		it(
			`keeps the worktree, and its newest bytes, when ${what} is edited again while it is being saved`,
			async () => {
				const dir = await w.busyWorktree(`edit-${file.replace(/\W/g, "")}`);
				let calls = 0;
				// The second process read is the one right before removal: an editor (cwd elsewhere) writes just then,
				// leaving `git status` the same.
				const processFolders = async (): Promise<string[]> => {
					if (++calls === 2) await fs.writeFile(path.join(dir, file), "edited again during the save\n");
					return [];
				};
				await w.care(undefined, { processFolders }).run("user");
				expect(w.listed()).toContain(dir);
				expect(await fs.readFile(path.join(dir, file), "utf8")).toBe("edited again during the save\n");
				expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
				expect(w.savedRefs()).toEqual([]);
				const kept = w.logs.filter(([message]) => message === "kept").map(([, details]) => String(details.reason));
				expect(kept).toContain("it changed while it was being saved");
			},
			SLOW,
		);
	}

	it.skipIf(process.platform === "win32")(
		"restores the archived .env over the default a post-checkout hook writes, setting the default aside",
		async () => {
			const dir = await w.busyWorktree("hooked");
			const hook = path.join(w.repo, ".git", "hooks", "post-checkout");
			await fs.writeFile(hook, '#!/bin/sh\n[ -f .env ] || printf "DEFAULT=1\\n" > .env\n');
			await fs.chmod(hook, 0o755);
			await w.care().run("user");
			expect(w.listed()).not.toContain(dir);
			const [record] = await listSavedWorktrees(w.repo, w.saved);
			const restored = await restoreSavedWorktree(record?.id ?? "", w.saved);
			expect(restored.archive.skipped).toBe(0);
			expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toBe("API_KEY=edited-in-worktree\n");
			expect(await fs.readFile(path.join(dir, ".env.ompdesk-before-restore"), "utf8")).toBe("DEFAULT=1\n");
			expect(await listSavedWorktrees(w.repo, w.saved)).toEqual([]);
		},
		SLOW,
	);
});
