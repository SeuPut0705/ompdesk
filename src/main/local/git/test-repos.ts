/** Temp git repositories for tests of the worktree code (never imported by app code). */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LifecycleWorktree } from "./session-worktree";

export function gitSync(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with one commit and an ignored `.env`. */
export async function initRepo(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	gitSync(dir, "init", "-q", "-b", "main");
	gitSync(dir, "config", "user.email", "test@example.com");
	gitSync(dir, "config", "user.name", "Test");
	gitSync(dir, "config", "commit.gpgsign", "false");
	// Git for Windows' installer sets core.autocrlf=true system-wide; tests compare file bytes exactly.
	gitSync(dir, "config", "core.autocrlf", "false");
	await fs.writeFile(path.join(dir, "README.md"), "hello\n");
	await fs.writeFile(path.join(dir, ".gitignore"), ".env\n");
	gitSync(dir, "add", ".");
	gitSync(dir, "commit", "-q", "-m", "init");
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
