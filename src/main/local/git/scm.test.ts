import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RM_TEMP } from "../../test-fake-omp";
import type { OmpRuntime } from "../types";
import { getGitChanges } from "./changes";
import { isValidRefName, parseBranchHeaders, parseDecorations, remoteWebBase } from "./parse";
import * as scm from "./scm";
import { gitSync, initRepo, pathExists } from "./test-repos";

// Each test runs a few dozen real git processes; a git start costs ~10 ms on a Mac but 100-300 ms on a Windows
// runner, so the remote and history tests need far longer than vitest's 5 s there. A timed-out test also keeps
// running git in `dir` while afterEach deletes it (EBUSY).
vi.setConfig({ testTimeout: 60_000 });
// Host git config must not shape these repos: a runner's git names a bare remote's HEAD `master`, a Mac's `main`.
// Every git here (gitSync and the code under test) inherits process.env. An empty file, not os.devNull:
// Windows git can't open `\\.\nul` as a config path.
let emptyConfigDir: string;
beforeAll(async () => {
	emptyConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scm-config-"));
	const emptyConfig = path.join(emptyConfigDir, "gitconfig");
	await fs.writeFile(emptyConfig, "");
	vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await fs.rm(emptyConfigDir, RM_TEMP);
});

let dir: string;
let root: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scm-"));
	root = path.join(dir, "repo");
	await initRepo(root);
});
afterEach(async () => {
	await fs.rm(dir, RM_TEMP);
});

const statusOf = async (file: string) => (await getGitChanges(root)).files.find(entry => entry.path === file)?.status;

describe("stage, unstage, discard", () => {
	it("stages and unstages single paths and everything", async () => {
		await fs.writeFile(path.join(root, "README.md"), "hello\nmore\n");
		await fs.writeFile(path.join(root, "new file.txt"), "new\n");
		await scm.stage(root, ["new file.txt"]);
		expect(await statusOf("new file.txt")).toBe("A ");
		expect(await statusOf("README.md")).toBe(" M");
		await scm.stage(root, "all");
		expect(await statusOf("README.md")).toBe("M ");
		await scm.unstage(root, ["README.md"]);
		expect(await statusOf("README.md")).toBe(" M");
		await scm.unstage(root, "all");
		expect(await statusOf("new file.txt")).toBe("??");
	});

	it("keeps a staged path listed even when the worktree went back to HEAD", async () => {
		await fs.writeFile(path.join(root, "README.md"), "hello\nstaged\n");
		await scm.stage(root, ["README.md"]);
		await fs.writeFile(path.join(root, "README.md"), "hello\n");
		expect(await statusOf("README.md")).toBe("MM");
	});

	it("discards tracked edits back to HEAD and removes untracked files", async () => {
		await fs.writeFile(path.join(root, "README.md"), "changed\n");
		await scm.stage(root, ["README.md"]);
		await fs.writeFile(path.join(root, "scratch.txt"), "tmp\n");
		await scm.discard(root, ["README.md", "scratch.txt"]);
		expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("hello\n");
		expect(await pathExists(path.join(root, "scratch.txt"))).toBe(false);
		expect((await getGitChanges(root)).files).toEqual([]);
	});

	it("refuses paths that leave the checkout", async () => {
		await expect(scm.stage(root, ["../outside"])).rejects.toMatchObject({ code: "invalid_path" });
		await expect(scm.discard(root, [])).rejects.toMatchObject({ code: "invalid_path" });
	});
});

describe("commit", () => {
	it("commits the staged changes, amends and undoes the last commit", async () => {
		await expect(scm.commit(root, { message: "nothing" })).rejects.toMatchObject({ code: "nothing_staged" });
		await fs.writeFile(path.join(root, "a.txt"), "a\n");
		await scm.stage(root, ["a.txt"]);
		const { sha } = await scm.commit(root, { message: "feat: add a\n\nbody line" });
		expect(gitSync(root, "rev-parse", "HEAD")).toBe(sha);
		expect(gitSync(root, "log", "-1", "--format=%s")).toBe("feat: add a");
		await scm.commit(root, { message: "feat: add a (amended)", amend: true });
		expect(gitSync(root, "log", "-1", "--format=%s")).toBe("feat: add a (amended)");
		expect(await scm.lastCommitMessage(root)).toEqual({ message: "feat: add a (amended)" });
		await scm.undoCommit(root);
		expect(gitSync(root, "log", "-1", "--format=%s")).toBe("init");
		expect(await statusOf("a.txt")).toBe("A ");
	});

	it("generates the message through stock omp commit --dry-run only with something staged", async () => {
		const calls: Array<{ args: string[]; cwd?: string }> = [];
		const omp: OmpRuntime = {
			bin: "omp",
			version: "18.10.3",
			run: async (args, opts) => {
				calls.push({ args, cwd: opts?.cwd });
				return {
					code: 0,
					stdout: "Reading staged changes…\n\nGenerated commit message:\nfeat(a): add a\n\n- adds a\n",
					stderr: "",
				};
			},
		};
		await expect(scm.commitMessage(root, omp)).rejects.toMatchObject({ code: "nothing_staged" });
		expect(calls).toEqual([]);
		await fs.writeFile(path.join(root, "a.txt"), "a\n");
		await scm.stage(root, ["a.txt"]);
		expect(await scm.commitMessage(root, omp)).toEqual({ message: "feat(a): add a\n\n- adds a" });
		expect(calls).toEqual([
			{ args: ["commit", "--dry-run", "--legacy", "--no-changelog"], cwd: await fs.realpath(root) },
		]);
		expect(gitSync(root, "log", "-1", "--format=%s")).toBe("init");
	});

	it("reports stock's failure text when no message came back", async () => {
		await fs.writeFile(path.join(root, "a.txt"), "a\n");
		await scm.stage(root, ["a.txt"]);
		const omp: OmpRuntime = {
			bin: "omp",
			version: "18.10.3",
			run: async () => ({ code: 1, stdout: "", stderr: "No model available" }),
		};
		await expect(scm.commitMessage(root, omp)).rejects.toMatchObject({
			code: "commit_message_failed",
			message: expect.stringContaining("No model available"),
		});
	});
});

describe("remote", () => {
	it("publishes a branch without upstream, then pushes, fetches and pulls", async () => {
		const remote = path.join(dir, "remote.git");
		gitSync(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
		await expect(scm.remote(root, "push")).rejects.toMatchObject({ code: "no_remote" });
		gitSync(root, "remote", "add", "origin", remote);
		expect(await scm.remote(root, "push")).toMatchObject({ published: "origin/main" });
		await fs.writeFile(path.join(root, "a.txt"), "a\n");
		await scm.stage(root, "all");
		await scm.commit(root, { message: "second" });
		expect((await getGitChanges(root)).head).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 1 });
		await scm.remote(root, "push");
		expect((await getGitChanges(root)).head).toMatchObject({ ahead: 0, behind: 0 });

		const other = path.join(dir, "other");
		gitSync(dir, "clone", "-q", remote, "other");
		gitSync(other, "config", "user.email", "o@example.com");
		gitSync(other, "config", "user.name", "Other");
		await fs.writeFile(path.join(other, "b.txt"), "b\n");
		gitSync(other, "add", ".");
		gitSync(other, "commit", "-qm", "from other");
		gitSync(other, "push", "-q");
		await scm.remote(root, "fetch");
		expect((await getGitChanges(root)).head).toMatchObject({ behind: 1 });
		await scm.remote(root, "pull");
		expect(gitSync(root, "log", "-1", "--format=%s")).toBe("from other");
	});

	it("reports a rejected push as push_rejected", async () => {
		const remote = path.join(dir, "remote.git");
		gitSync(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
		gitSync(root, "remote", "add", "origin", remote);
		await scm.remote(root, "push");
		const other = path.join(dir, "other");
		gitSync(dir, "clone", "-q", remote, "other");
		gitSync(other, "config", "user.email", "o@example.com");
		gitSync(other, "config", "user.name", "Other");
		gitSync(other, "commit", "-q", "--allow-empty", "-m", "theirs");
		gitSync(other, "push", "-q");
		gitSync(root, "commit", "-q", "--allow-empty", "-m", "ours");
		await expect(scm.remote(root, "push")).rejects.toMatchObject({ code: "push_rejected" });
	});
});

describe("branches, merge, stash and operations", () => {
	it("creates, switches, renames and deletes branches", async () => {
		await scm.branch(root, { action: "create", name: "feature/x" });
		expect(gitSync(root, "branch", "--show-current")).toBe("feature/x");
		await scm.branch(root, { action: "switch", name: "main" });
		await scm.branch(root, { action: "rename", name: "feature/x", newName: "feature/y" });
		const list = await scm.branches(root);
		expect(list.map(entry => [entry.name, entry.current])).toEqual(
			expect.arrayContaining([
				["main", true],
				["feature/y", false],
			]),
		);
		await expect(scm.branch(root, { action: "delete", name: "main" })).rejects.toMatchObject({ code: "git_failed" });
		await scm.branch(root, { action: "delete", name: "feature/y" });
		expect((await scm.branches(root)).map(entry => entry.name)).toEqual(["main"]);
		await expect(scm.branch(root, { action: "create", name: "bad name" })).rejects.toMatchObject({
			code: "invalid_name",
		});
	});

	it("names the worktree that holds a branch and refuses to switch to it", async () => {
		gitSync(root, "worktree", "add", "-q", "-b", "held", path.join(dir, "held"));
		const held = (await scm.branches(root)).find(entry => entry.name === "held");
		expect(held?.worktree).toBeTruthy();
		await expect(scm.branch(root, { action: "switch", name: "held" })).rejects.toMatchObject({
			code: "branch_checked_out",
		});
	});

	it("stops a conflicting merge with a conflict count, blocks commit and aborts", async () => {
		gitSync(root, "switch", "-q", "-c", "side");
		await fs.writeFile(path.join(root, "README.md"), "side\n");
		gitSync(root, "commit", "-qam", "side");
		gitSync(root, "switch", "-q", "main");
		await fs.writeFile(path.join(root, "README.md"), "main\n");
		gitSync(root, "commit", "-qam", "main");
		expect(await scm.branch(root, { action: "merge", name: "side" })).toEqual({ conflicts: 1 });
		const changes = await getGitChanges(root);
		expect(changes.head?.operation).toBe("merge");
		expect(changes.files.find(file => file.path === "README.md")?.status).toBe("UU");
		await expect(scm.commit(root, { message: "merge" })).rejects.toMatchObject({ code: "git_failed" });
		await expect(scm.operation(root, "continue")).rejects.toMatchObject({ code: "git_failed" });
		await scm.operation(root, "abort");
		expect((await getGitChanges(root)).head?.operation).toBeNull();
	});

	it("stashes untracked work and pops it back", async () => {
		await fs.writeFile(path.join(root, "wip.txt"), "wip\n");
		await scm.stash(root, "push", "wip");
		expect((await getGitChanges(root)).head?.stashes).toBe(1);
		expect(await pathExists(path.join(root, "wip.txt"))).toBe(false);
		expect(await scm.stash(root, "pop")).toEqual({ conflicts: 0 });
		expect(await pathExists(path.join(root, "wip.txt"))).toBe(true);
	});
});

describe("history", () => {
	it("pages the log, searches it and reads a commit's files and diff", async () => {
		await fs.writeFile(path.join(root, "a.txt"), "one\n");
		gitSync(root, "add", ".");
		gitSync(root, "commit", "-qm", "add a");
		gitSync(root, "tag", "v1");
		gitSync(root, "mv", "a.txt", "b.txt");
		await fs.appendFile(path.join(root, "b.txt"), "two\n");
		gitSync(root, "add", ".");
		gitSync(root, "commit", "-qm", "rename to b");
		gitSync(root, "remote", "add", "origin", "git@github.com:o/r.git");

		const page = await scm.log(root, { limit: 2 });
		expect(page.commits.map(entry => entry.subject)).toEqual(["rename to b", "add a"]);
		expect(page.more).toBe(true);
		expect(page.commits[0]?.refs).toEqual(["main"]);
		expect(page.commits[1]?.tags).toEqual(["v1"]);
		expect(page.commitUrl).toBe("https://github.com/o/r/commit/{sha}");
		expect((await scm.log(root, { skip: 2 })).commits.map(entry => entry.subject)).toEqual(["init"]);
		expect((await scm.log(root, { query: "RENAME" })).commits.map(entry => entry.subject)).toEqual(["rename to b"]);

		const head = page.commits[0]!;
		const detail = await scm.commitDetail(root, head.sha);
		expect(detail.files).toEqual([{ path: "b.txt", oldPath: "a.txt", status: "R", added: 1, removed: 0 }]);
		const diff = await scm.commitDiff(root, head.sha, "b.txt");
		expect(diff.diff).toContain("+two");
		await expect(scm.commitDetail(root, "not-a-sha")).rejects.toMatchObject({ code: "invalid_name" });
	});

	it("reverts, cherry-picks, resets, tags and branches from a commit", async () => {
		await fs.writeFile(path.join(root, "a.txt"), "a\n");
		gitSync(root, "add", ".");
		gitSync(root, "commit", "-qm", "add a");
		const added = gitSync(root, "rev-parse", "HEAD");
		expect(await scm.historyAction(root, { action: "revert", sha: added })).toEqual({ conflicts: 0 });
		expect(await pathExists(path.join(root, "a.txt"))).toBe(false);
		expect(await scm.historyAction(root, { action: "cherry_pick", sha: added })).toEqual({ conflicts: 0 });
		expect(await pathExists(path.join(root, "a.txt"))).toBe(true);
		await scm.historyAction(root, { action: "tag", sha: added, name: "marked" });
		expect(gitSync(root, "tag")).toBe("marked");
		await scm.historyAction(root, { action: "delete_tag", sha: added, name: "marked" });
		expect(gitSync(root, "tag")).toBe("");
		await scm.historyAction(root, { action: "reset", sha: added, mode: "hard" });
		expect(gitSync(root, "rev-parse", "HEAD")).toBe(added);
		await scm.historyAction(root, { action: "branch", sha: added, name: "from-a" });
		expect(gitSync(root, "branch", "--show-current")).toBe("from-a");
		await scm.historyAction(root, { action: "checkout", sha: added });
		expect((await getGitChanges(root)).head?.branch).toBeNull();
	});

	it("moves a commit earlier or later on the current line, and refuses the tip, a dirty tree and pushed commits", async () => {
		const commitFile = (name: string) => {
			gitSync(root, "commit", "-qm", name, "--allow-empty");
			return gitSync(root, "rev-parse", "HEAD");
		};
		const subjects = () => gitSync(root, "log", "--format=%s").split("\n");
		const a = commitFile("a");
		commitFile("b");
		const c = commitFile("c");
		expect(subjects()).toEqual(["c", "b", "a", "init"]);
		expect(await scm.historyAction(root, { action: "move_earlier", sha: c })).toEqual({ conflicts: 0 });
		expect(subjects()).toEqual(["b", "c", "a", "init"]);
		expect(await scm.historyAction(root, { action: "move_later", sha: a })).toEqual({ conflicts: 0 });
		expect(subjects()).toEqual(["b", "a", "c", "init"]);
		const head = gitSync(root, "rev-parse", "HEAD");
		await expect(scm.historyAction(root, { action: "move_later", sha: head })).rejects.toMatchObject({
			code: "git_failed",
		});

		await fs.writeFile(path.join(root, "README.md"), "dirty\n");
		await expect(scm.historyAction(root, { action: "move_earlier", sha: head })).rejects.toMatchObject({
			code: "dirty_worktree",
		});
		gitSync(root, "checkout", "--", "README.md");

		const remote = path.join(dir, "remote.git");
		gitSync(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
		gitSync(root, "remote", "add", "origin", remote);
		gitSync(root, "push", "-q", "-u", "origin", "HEAD");
		await expect(scm.historyAction(root, { action: "move_earlier", sha: head })).rejects.toMatchObject({
			code: "commit_pushed",
		});
	});

	it("stops a move that conflicts as a rebase the user continues or aborts", async () => {
		await fs.writeFile(path.join(root, "a.txt"), "one\n");
		gitSync(root, "add", ".");
		gitSync(root, "commit", "-qm", "one");
		await fs.writeFile(path.join(root, "a.txt"), "two\n");
		gitSync(root, "commit", "-qam", "two");
		const two = gitSync(root, "rev-parse", "HEAD");
		expect(await scm.historyAction(root, { action: "move_earlier", sha: two })).toEqual({ conflicts: 1 });
		expect((await getGitChanges(root)).head?.operation).toBe("rebase");
		await scm.operation(root, "abort");
		expect(gitSync(root, "rev-parse", "HEAD")).toBe(two);
	});
});

describe("parsers", () => {
	it("reads branch headers", () => {
		expect(
			parseBranchHeaders("# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0"),
		).toEqual({ branch: "main", upstream: "origin/main", ahead: 2, behind: 3 });
		expect(parseBranchHeaders("# branch.head (detached)\0")).toEqual({
			branch: null,
			upstream: null,
			ahead: 0,
			behind: 0,
		});
	});

	it("splits decorations into refs and tags", () => {
		expect(parseDecorations("HEAD -> main, tag: v1.0, origin/main, origin/HEAD")).toEqual({
			refs: ["main", "origin/main", "origin/HEAD"],
			tags: ["v1.0"],
		});
	});

	it("derives a hosted remote's web base", () => {
		expect(remoteWebBase("git@github.com:o/r.git")).toBe("https://github.com/o/r");
		expect(remoteWebBase("https://gitlab.com/group/sub/r.git\n")).toBe("https://gitlab.com/group/sub/r");
		expect(remoteWebBase("ssh://git@github.com/o/r")).toBe("https://github.com/o/r");
		expect(remoteWebBase("/srv/git/r.git")).toBeNull();
		expect(remoteWebBase("file:///srv/git/r.git")).toBeNull();
	});

	it("accepts git ref names and refuses the rest", () => {
		for (const name of ["main", "feature/x-1", "v1.2.3"]) expect(isValidRefName(name), name).toBe(true);
		for (const name of ["", "-x", "a..b", "a b", "a~1", "x.lock", "a/.b", "@", "a@{1}", "a:b"])
			expect(isValidRefName(name), name).toBe(false);
	});

	it("reads stock's dry-run output", () => {
		expect(scm.parseGeneratedMessage("progress\nGenerated commit message:\nfix: x\n")).toBe("fix: x");
		expect(scm.parseGeneratedMessage("No changes to commit.\n")).toBeNull();
	});
});
