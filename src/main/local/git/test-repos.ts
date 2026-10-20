/** Temp git repositories for tests of the worktree code (never imported by app code). */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { withoutGitSelectors } from "../../../shared/git-env";
import type { LifecycleWorktree } from "./session-worktree";

export function gitSync(cwd: string, ...args: string[]): string {
	// Never the repository a leaked GIT_DIR names (src/shared/git-env.ts): only the one `cwd` is in.
	return execFileSync("git", args, { cwd, encoding: "utf8", env: withoutGitSelectors(process.env) }).trim();
}

/**
 * Builds what `initRepo` hands out, with eight git processes: about 30 ms each on an idle windows-latest runner and
 * past a second on a saturated one, which is why the helpers below copy a template instead.
 */
async function buildRepo(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	gitSync(dir, "init", "-q", "-b", "main");
	gitSync(dir, "config", "user.email", "test@example.com");
	gitSync(dir, "config", "user.name", "Test");
	gitSync(dir, "config", "commit.gpgsign", "false");
	// Git for Windows' installer sets core.autocrlf=true system-wide; tests compare file bytes exactly.
	gitSync(dir, "config", "core.autocrlf", "false");
	// Every commit would otherwise start one more process (`git maintenance run --auto`) that never has work in a
	// repository this small.
	gitSync(dir, "config", "maintenance.auto", "false");
	await fs.writeFile(path.join(dir, "README.md"), "hello\n");
	await fs.writeFile(path.join(dir, ".gitignore"), ".env\n");
	gitSync(dir, "add", ".");
	gitSync(dir, "commit", "-q", "-m", "init");
}

let templates: Promise<string> | null = null;

/**
 * The folder this test process builds its template repositories in, once; the helpers below copy them (a repository
 * holds no absolute path but its remotes' urls). It lives in the run's folder (`OMP_TEST_REPO_ROOT`,
 * `scripts/vitest-test-repos.ts`), which the run deletes.
 */
function templateRoot(): Promise<string> {
	templates ??= (async () => {
		const parent = process.env.OMP_TEST_REPO_ROOT;
		const root = await fs.mkdtemp(path.join(parent ?? tmpdir(), "omp-test-repo-"));
		if (!parent) process.once("exit", () => rmSync(root, { recursive: true, force: true }));
		return root;
	})();
	return templates;
}

const built = new Map<string, Promise<string>>();

/** The template `name`, built by `build` into a fresh folder the first time it is asked for. */
function template(name: string, build: (dir: string) => Promise<void>): Promise<string> {
	let pending = built.get(name);
	if (!pending) {
		pending = templateRoot().then(async root => {
			await build(path.join(root, name));
			return path.join(root, name);
		});
		built.set(name, pending);
	}
	return pending;
}

const copy = (from: string, to: string) => fs.cp(from, to, { recursive: true, preserveTimestamps: true });

/** A repository with one commit and an ignored `.env`. */
export async function initRepo(dir: string): Promise<void> {
	// A folder that already holds files gets them committed too, as `git add .` always did.
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	if (entries.length > 0) return buildRepo(dir);
	await copy(await template("repo", buildRepo), dir);
}

/**
 * `initRepo(main)` plus a bare `remote` on `main` holding its commit as `origin` (fetched: `origin/main` is there),
 * as `git init --bare`, `remote add`, `push` and `fetch` leave them.
 */
export async function initRepoWithRemote(main: string, remote: string): Promise<void> {
	const from = await template("with-remote", async dir => {
		await buildRepo(path.join(dir, "main"));
		gitSync(dir, "init", "-q", "--bare", "-b", "main", path.join(dir, "remote.git"));
		// Every push would otherwise end in one more process on the remote's side (`git maintenance run --auto`).
		gitSync(path.join(dir, "remote.git"), "config", "receive.autogc", "false");
		gitSync(path.join(dir, "main"), "remote", "add", "origin", path.join(dir, "remote.git"));
		gitSync(path.join(dir, "main"), "push", "-q", "origin", "main");
		gitSync(path.join(dir, "main"), "fetch", "-q", "origin");
	});
	await copy(path.join(from, "main"), main);
	await copy(path.join(from, "remote.git"), remote);
	gitSync(main, "remote", "set-url", "origin", remote);
}

/** What stock `createSessionWorktree` leaves behind: `wt/<name>` at HEAD, checked out under `root`. */
export async function stockShapedWorktree(source: string, root: string, name: string): Promise<LifecycleWorktree> {
	const baseCommit = gitSync(source, "rev-parse", "HEAD");
	const branch = `wt/${name}`;
	const target = path.join(root, `${name}-1234567`);
	await fs.mkdir(root, { recursive: true });
	gitSync(source, "branch", branch, baseCommit);
	gitSync(source, "worktree", "add", "-q", target, branch);
	return { path: await fs.realpath(target), branch, sourceCwd: source, baseCommit, root };
}

export function pathExists(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}
