import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "./test-repos";
import { getGitUnlanded } from "./unlanded";

let root: string;
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-unlanded-")));
	await initRepo(path.join(root, "repo"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const repo = () => path.join(root, "repo");

async function worktree(name: string): Promise<string> {
	const target = path.join(root, name);
	gitSync(repo(), "worktree", "add", "-q", "-b", `omp/agent/${name}`, target);
	return target;
}

describe("what a branch has not landed in main yet", () => {
	it("is the branch's commits and its uncommitted work against main's merge-base, never main's newer commits", async () => {
		const child = await worktree("child");
		await fs.writeFile(path.join(child, "feature.ts"), "one\ntwo\n");
		gitSync(child, "add", "feature.ts");
		gitSync(child, "commit", "-qm", "feature");
		// Main moves on meanwhile (other sessions push): not this branch's work.
		await fs.writeFile(path.join(repo(), "README.md"), "hello\nsomeone else\n");
		gitSync(repo(), "commit", "-qam", "elsewhere");
		// Uncommitted and untracked work in the worktree counts too.
		await fs.writeFile(path.join(child, "feature.ts"), "one\ntwo\nthree\n");
		await fs.writeFile(path.join(child, "notes.md"), "draft\n");
		const unlanded = await getGitUnlanded(child);
		expect(unlanded).toMatchObject({ branch: "omp/agent/child", target: "main", truncated: false });
		expect(unlanded?.files).toEqual([
			expect.objectContaining({ path: "feature.ts", status: "A", added: 3, removed: 0 }),
			expect.objectContaining({ path: "notes.md", status: "??" }),
		]);
	});

	it("prefers the remote's default branch when there is one", async () => {
		const remote = path.join(root, "remote.git");
		gitSync(root, "init", "-q", "--bare", "-b", "main", remote);
		gitSync(repo(), "remote", "add", "origin", remote);
		gitSync(repo(), "push", "-q", "origin", "main");
		gitSync(repo(), "remote", "set-head", "origin", "main");
		const child = await worktree("pushed");
		await fs.writeFile(path.join(child, "a.ts"), "a\n");
		expect(await getGitUnlanded(child)).toMatchObject({
			target: "main",
			files: [expect.objectContaining({ path: "a.ts" })],
		});
	});

	it("is nothing on main itself, where sessions share the working tree, and nothing on a detached HEAD", async () => {
		await fs.writeFile(path.join(repo(), "README.md"), "hello\nedited on main\n");
		expect(await getGitUnlanded(repo())).toBeNull();
		gitSync(repo(), "checkout", "-q", "--detach");
		expect(await getGitUnlanded(repo())).toBeNull();
	});

	it("is nothing outside a repository", async () => {
		expect(await getGitUnlanded(root)).toBeNull();
	});
});
