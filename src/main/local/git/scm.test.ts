import * as fs from "node:fs/promises";
import { promises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RM_TEMP } from "../../test-fake-omp";
import type { OmpRuntime } from "../types";
import { getGitChanges, repoRoot } from "./changes";
import { REPO_LOCK_HOLD_MS, withRepoLock } from "./exec";
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

	it("discards a staged rename, whether the new path alone or both paths are selected", async () => {
		gitSync(root, "mv", "README.md", "renamed.md");
		expect(await statusOf("renamed.md")).toBe("R ");
		await scm.discard(root, ["renamed.md"]);
		expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("hello\n");
		expect(await pathExists(path.join(root, "renamed.md"))).toBe(false);
		expect((await getGitChanges(root)).files).toEqual([]);

		gitSync(root, "mv", "README.md", "renamed.md");
		await fs.writeFile(path.join(root, "renamed.md"), "edited after the move\n");
		await scm.discard(root, ["renamed.md", "README.md"]);
		expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("hello\n");
		expect(await pathExists(path.join(root, "renamed.md"))).toBe(false);
		expect((await getGitChanges(root)).files).toEqual([]);
	});

	it("discards an intent-to-add file together with a tracked edit", async () => {
		await fs.writeFile(path.join(root, "added.txt"), "x\n");
		gitSync(root, "add", "-N", "added.txt");
		await fs.writeFile(path.join(root, "README.md"), "changed\n");
		await scm.discard(root, ["added.txt", "README.md"]);
		expect(await pathExists(path.join(root, "added.txt"))).toBe(false);
		expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("hello\n");
		expect((await getGitChanges(root)).files).toEqual([]);
	});

	it("refuses paths that leave the checkout", async () => {
		await expect(scm.stage(root, ["../outside"])).rejects.toMatchObject({ code: "invalid_path" });
		await expect(scm.discard(root, [])).rejects.toMatchObject({ code: "invalid_path" });
	});
});

describe("a discard that outlives the repository lock", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("does not remove what the next holder created at the same path once its realpath resolves", async () => {
		const file = path.join(root, "fresh.txt");
		await fs.writeFile(file, "mine\n");
		await scm.stage(root, ["fresh.txt"]);
		const lockRoot = (await repoRoot(root)) as string;
		const realRealpath = promises.realpath.bind(promises) as (...args: unknown[]) => Promise<string>;
		const realRm = promises.rm.bind(promises) as (...args: unknown[]) => Promise<void>;
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resolved = Promise.withResolvers<void>();
		const removals: Promise<void>[] = [];
		// The seam: the module's fenced `fs` calls `promises.realpath` / `promises.rm` at call time.
		vi.spyOn(promises, "realpath").mockImplementation((async (...args: unknown[]) => {
			if (args[0] === lockRoot) {
				reached.resolve();
				await release.promise;
				const real = await realRealpath(...args);
				resolved.resolve();
				return real;
			}
			return realRealpath(...args);
		}) as never);
		vi.spyOn(promises, "rm").mockImplementation(((...args: unknown[]) => {
			const done = realRm(...args);
			removals.push(done);
			return done;
		}) as never);
		vi.useFakeTimers();

		const old = scm.discard(root, ["fresh.txt"]).then(
			() => null,
			error => error,
		);
		await reached.promise;
		await vi.advanceTimersByTimeAsync(REPO_LOCK_HOLD_MS);
		await withRepoLock(lockRoot, () => fs.writeFile(file, "next holder\n"));
		release.resolve();
		await resolved.promise;
		// The old holder's continuation after realpath is a fixed run of microtasks: let it all run, then its removals.
		for (let hop = 0; hop < 100; hop++) await Promise.resolve();
		await Promise.all(removals);

		expect(await old).toBeInstanceOf(Error);
		expect(await fs.readFile(file, "utf8")).toBe("next holder\n");
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
