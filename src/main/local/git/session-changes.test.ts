import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitSessionChanges, sessionStartedAt } from "./session-changes";
import { gitSync, initRepo } from "./test-repos";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-changes-"));
	await initRepo(root);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A commit dated `at` (epoch ms), author and committer alike. */
function commitAt(at: number, message: string): void {
	const date = `${Math.floor(at / 1000)} +0000`;
	execFileSync("git", ["commit", "-qam", message], {
		cwd: root,
		env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
	});
}

describe("changes since the session started", () => {
	it("keeps the session's own edits after it commits them, beside what is still uncommitted and untracked", async () => {
		// The repository's first commit is from now; the session starts a minute later.
		const since = Date.now() + 60_000;
		await fs.writeFile(path.join(root, "README.md"), "hello\nfrom the session\n");
		commitAt(since + 60_000, "session edit");
		// Committed: `get_git_changes` (HEAD-based) has nothing left, the session's row still has it.
		expect(gitSync(root, "status", "--porcelain")).toBe("");
		let changes = await getGitSessionChanges(root, since);
		expect(changes.files).toEqual([expect.objectContaining({ path: "README.md", added: 1, removed: 0 })]);

		await fs.writeFile(path.join(root, "README.md"), "hello\nfrom the session\nand more\n");
		await fs.writeFile(path.join(root, "notes.txt"), "new\n");
		changes = await getGitSessionChanges(root, since);
		expect(changes.files).toEqual([
			expect.objectContaining({ path: "README.md", added: 2, removed: 0 }),
			expect.objectContaining({ path: "notes.txt", status: "??" }),
		]);
	});

	it("counts nothing from before the session", async () => {
		const since = Date.now() + 60_000;
		// A commit made before the session started is the baseline's history, not the session's work.
		await fs.writeFile(path.join(root, "README.md"), "hello\nolder work\n");
		commitAt(since - 30_000, "before the session");
		expect((await getGitSessionChanges(root, since)).files).toEqual([]);
	});

	it("counts every committed file of a repository the session created, measured from the empty tree", async () => {
		const fresh = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-changes-born-"));
		try {
			// The session starts, then creates the repository: unborn HEAD first, nothing committed yet.
			const since = Date.now() - 60_000;
			gitSync(fresh, "init", "-q", "-b", "main");
			gitSync(fresh, "config", "user.email", "test@example.com");
			gitSync(fresh, "config", "user.name", "Test");
			gitSync(fresh, "config", "commit.gpgsign", "false");
			await fs.writeFile(path.join(fresh, "app.ts"), "one\ntwo\n");
			expect((await getGitSessionChanges(fresh, since)).files).toEqual([
				expect.objectContaining({ path: "app.ts" }),
			]);
			// The initial commit leaves the checkout clean; the session's row still holds the file and its lines.
			gitSync(fresh, "add", ".");
			gitSync(fresh, "commit", "-qm", "initial");
			expect(gitSync(fresh, "status", "--porcelain")).toBe("");
			const changes = await getGitSessionChanges(fresh, since);
			expect(changes.files).toEqual([
				expect.objectContaining({ path: "app.ts", status: "A", added: 2, removed: 0 }),
			]);
		} finally {
			await fs.rm(fresh, { recursive: true, force: true });
		}
	});

	it("reads the session's start from its header line", async () => {
		const file = path.join(root, "session.jsonl");
		await fs.writeFile(
			file,
			`${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-10-20T03:00:00.000Z" })}\n{"type":"message"}\n`,
		);
		expect(await sessionStartedAt(file)).toBe(Date.parse("2026-10-20T03:00:00.000Z"));
		expect(await sessionStartedAt(path.join(root, "missing.jsonl"))).toBeNull();
	});

	it("is not a repository outside one", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-changes-none-"));
		try {
			expect(await getGitSessionChanges(outside, Date.now())).toMatchObject({ isRepo: false, files: [] });
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});
