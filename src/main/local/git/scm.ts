/**
 * Source control for the Changes panel: stage, commit, push/pull/fetch,
 * stash, branches and history over the git CLI on the session checkout.
 * Commit messages come from stock `omp commit --dry-run` (stock's
 * conventional-commit pipeline; it never commits on a dry run).
 *
 * Failures map to typed codes: not_a_repo / invalid_name / invalid_path /
 * git_failed / push_rejected / no_remote / detached_head / nothing_staged /
 * commit_message_failed / branch_checked_out / dirty_worktree / commit_pushed.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isConflictStatus } from "../../../shared/git-status";
import type {
	RpcGitBranch,
	RpcGitCommit,
	RpcGitCommitDetail,
	RpcGitDiff,
	RpcGitLog,
	RpcGitMutationResult,
	RpcGitRemoteResult,
} from "../../../shared/rpc-types";
import type { OmpRuntime } from "../types";
import { LocalCommandError } from "../types";
import { getGitHead, repoRoot } from "./changes";
import { type ExecResult, GitCommandError, git, gitRaw, withRepoLock } from "./exec";
import { isSafeRelativePath, isValidRefName, parseDecorations, parseGitStatus, remoteWebBase } from "./parse";

/** Hooks (pre-commit, commit-msg) and network round trips get longer than a status read. */
const COMMIT_TIMEOUT_MS = 300_000;
const REMOTE_TIMEOUT_MS = 300_000;
/** Stock `omp commit` reads the staged diff and asks the model (smol role first). */
const MESSAGE_TIMEOUT_MS = 180_000;
const LOG_PAGE = 100;
const MAX_DIFF_CHARS = 200_000;

/**
 * Longest each command runs before main answers. The renderer's RPC timeouts
 * (shared/rpc-client.ts) must not be shorter, or it reports a failure while
 * the commit or push still lands.
 */
export const SCM_COMMAND_BUDGETS_MS = {
	git_commit: COMMIT_TIMEOUT_MS + 60_000,
	git_commit_message: MESSAGE_TIMEOUT_MS + 60_000,
	git_remote: REMOTE_TIMEOUT_MS + 60_000,
	git_branch: COMMIT_TIMEOUT_MS + 60_000,
	git_history_action: COMMIT_TIMEOUT_MS + 60_000,
	git_operation: COMMIT_TIMEOUT_MS + 60_000,
} as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function requireRoot(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (!root) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	return root;
}

/** Run a mutation under the repository lock; git's own failure text becomes a `git_failed` error. */
async function mutate<T>(cwd: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = await requireRoot(cwd);
	try {
		return await withRepoLock(root, () => fn(root));
	} catch (error) {
		if (error instanceof LocalCommandError) throw error;
		throw new LocalCommandError(errorText(error), "git_failed");
	}
}

function checkPaths(paths: unknown): string[] {
	if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === "string" && isSafeRelativePath(p)))
		throw new LocalCommandError("Invalid repository-relative path", "invalid_path");
	return paths as string[];
}

function checkRef(name: string): string {
	if (!isValidRefName(name)) throw new LocalCommandError(`Invalid branch or tag name: ${name}`, "invalid_name");
	return name;
}

function checkSha(sha: string): string {
	if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new LocalCommandError(`Invalid commit: ${sha}`, "invalid_name");
	return sha;
}

const literal = (paths: string[]) => paths.map(file => `:(literal)${file}`);

async function hasHead(root: string): Promise<boolean> {
	return (await gitRaw(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
}

/** Unmerged paths left in the index after a merge, cherry-pick or revert stopped. */
async function conflictCount(root: string): Promise<number> {
	const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
	return parseGitStatus(status).filter(entry => isConflictStatus(`${entry.index}${entry.worktree}`)).length;
}

/** A command that may stop on conflicts: success or conflicts both answer; anything else throws. */
async function runMayConflict(
	root: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<RpcGitMutationResult> {
	const result = await gitRaw(root, args, { timeoutMs: COMMIT_TIMEOUT_MS, env: { GIT_EDITOR: "true", ...env } });
	if (result.code === 0) return { conflicts: 0 };
	const conflicts = await conflictCount(root);
	if (conflicts > 0) return { conflicts };
	throw new GitCommandError(args, result);
}

export async function stage(cwd: string, paths: string[] | "all"): Promise<void> {
	await mutate(cwd, async root => {
		await git(root, paths === "all" ? ["add", "-A"] : ["add", "-A", "--", ...literal(checkPaths(paths))]);
	});
}

export async function unstage(cwd: string, paths: string[] | "all"): Promise<void> {
	await mutate(cwd, async root => {
		const spec = paths === "all" ? ["."] : literal(checkPaths(paths));
		// An unborn branch has no HEAD to restore the index from: drop the entries instead.
		if (await hasHead(root)) await git(root, ["restore", "--staged", "--", ...spec]);
		else await git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...spec]);
	});
}

/** Back to HEAD in index and worktree; untracked or newly added paths are removed. */
export async function discard(cwd: string, paths: string[]): Promise<void> {
	await mutate(cwd, async root => {
		const checked = checkPaths(paths);
		const status = parseGitStatus(
			await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...literal(checked)]),
		);
		const fresh = status.filter(entry => entry.index === "?" || entry.index === "A").map(entry => entry.path);
		const tracked = status
			.filter(entry => entry.index !== "?" && entry.index !== "A")
			.flatMap(entry => (entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]));
		if (tracked.length > 0)
			await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...literal(tracked)]);
		if (fresh.length > 0) {
			await gitRaw(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...literal(fresh)]);
			const realRoot = await fs.realpath(root);
			for (const file of fresh) {
				const target = path.join(realRoot, file);
				if (path.relative(realRoot, target).startsWith("..")) continue;
				await fs.rm(target, { force: true, recursive: true });
			}
		}
	});
}

export async function commit(cwd: string, input: { message: string; amend?: boolean }): Promise<{ sha: string }> {
	const message = input.message.trim();
	if (!message) throw new LocalCommandError("A commit needs a message", "invalid_name");
	return mutate(cwd, async root => {
		if ((await conflictCount(root)) > 0)
			throw new LocalCommandError("Resolve every conflict before committing", "git_failed");
		const args = ["commit", "--cleanup=strip", "-m", message];
		if (input.amend) args.push("--amend");
		else if ((await gitRaw(root, ["diff", "--cached", "--quiet"])).code === 0)
			throw new LocalCommandError("Nothing is staged to commit", "nothing_staged");
		await git(root, args, { timeoutMs: COMMIT_TIMEOUT_MS });
		return { sha: (await git(root, ["rev-parse", "HEAD"])).trim() };
	});
}

export async function lastCommitMessage(cwd: string): Promise<{ message: string }> {
	const root = await requireRoot(cwd);
	if (!(await hasHead(root))) return { message: "" };
	return { message: (await git(root, ["log", "-1", "--format=%B"])).trim() };
}

/** Undo the last commit and keep its changes staged (`reset --soft HEAD~1`). */
export async function undoCommit(cwd: string): Promise<void> {
	await mutate(cwd, async root => {
		if ((await gitRaw(root, ["rev-parse", "--verify", "--quiet", "HEAD~1"])).code !== 0)
			throw new LocalCommandError("The first commit has no parent to go back to", "git_failed");
		await git(root, ["reset", "--soft", "HEAD~1"]);
	});
}

/** The message stock `omp commit --dry-run` prints after "Generated commit message:". */
export function parseGeneratedMessage(stdout: string): string | null {
	const marker = "Generated commit message:";
	const at = stdout.lastIndexOf(marker);
	if (at < 0) return null;
	const message = stdout.slice(at + marker.length).trim();
	return message || null;
}

/** A commit message for the staged changes from stock's commit pipeline; never stages or commits. */
export async function commitMessage(cwd: string, omp: OmpRuntime): Promise<{ message: string; warning?: string }> {
	const root = await requireRoot(cwd);
	// Stock stages everything when the index is empty; the panel only asks with something staged.
	if ((await gitRaw(root, ["diff", "--cached", "--quiet"])).code === 0)
		throw new LocalCommandError("Stage changes first", "nothing_staged");
	let output: { code: number; stdout: string; stderr: string };
	try {
		output = await omp.run(["commit", "--dry-run", "--legacy", "--no-changelog"], {
			cwd: root,
			timeoutMs: MESSAGE_TIMEOUT_MS,
		});
	} catch (error) {
		throw new LocalCommandError(`omp commit failed: ${errorText(error)}`, "commit_message_failed");
	}
	const message = output.code === 0 ? parseGeneratedMessage(output.stdout) : null;
	if (!message) {
		const detail = (output.stderr || output.stdout).trim().slice(-400);
		throw new LocalCommandError(`omp commit gave no message${detail ? `: ${detail}` : ""}`, "commit_message_failed");
	}
	const warning = /requires manual correction: (.+)/.exec(output.stderr)?.[1]?.trim();
	return warning ? { message, warning } : { message };
}

function remoteFailure(action: string, result: ExecResult): LocalCommandError {
	const text = result.stderr.trim() || `git ${action} exited with code ${result.code}`;
	if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/.test(text))
		return new LocalCommandError(text, "push_rejected");
	return new LocalCommandError(text, "git_failed");
}

export async function remote(cwd: string, action: "push" | "pull" | "fetch"): Promise<RpcGitRemoteResult> {
	return mutate(cwd, async root => {
		const head = await getGitHead(root);
		if (!head.hasRemote) throw new LocalCommandError("This repository has no remote", "no_remote");
		if (action === "fetch") {
			const result = await gitRaw(root, ["fetch", "--prune"], { timeoutMs: REMOTE_TIMEOUT_MS });
			if (result.code !== 0) throw remoteFailure(action, result);
			return { output: result.stderr.trim() };
		}
		if (!head.branch)
			throw new LocalCommandError(`Switch to a branch before you ${action}: HEAD is detached`, "detached_head");
		if (action === "pull") {
			if (!head.upstream) throw new LocalCommandError(`${head.branch} has no upstream to pull from`, "no_remote");
			// Without the user's own pull.rebase/pull.ff, git refuses a divergent pull; merge then, like a plain `git pull` did.
			const configured = (await gitRaw(root, ["config", "--get-regexp", "^pull\\.(rebase|ff)$"])).code === 0;
			const args = ["pull", "--no-edit", ...(configured ? [] : ["--no-rebase"])];
			const result = await gitRaw(root, args, { timeoutMs: REMOTE_TIMEOUT_MS, env: { GIT_EDITOR: "true" } });
			if (result.code !== 0) {
				if ((await conflictCount(root)) > 0)
					throw new LocalCommandError("Pull stopped on conflicts; resolve them, then continue", "git_failed");
				throw remoteFailure(action, result);
			}
			return { output: result.stdout.toString("utf8").trim() || result.stderr.trim() };
		}
		if (head.upstream) {
			const result = await gitRaw(root, ["push"], { timeoutMs: REMOTE_TIMEOUT_MS });
			if (result.code !== 0) throw remoteFailure(action, result);
			return { output: result.stderr.trim() };
		}
		const remotes = (await git(root, ["remote"])).split("\n").filter(Boolean);
		const target = remotes.includes("origin") ? "origin" : remotes[0]!;
		const result = await gitRaw(root, ["push", "--set-upstream", target, head.branch], {
			timeoutMs: REMOTE_TIMEOUT_MS,
		});
		if (result.code !== 0) throw remoteFailure(action, result);
		return { published: `${target}/${head.branch}`, output: result.stderr.trim() };
	});
}

export async function stash(cwd: string, action: "push" | "pop", message?: string): Promise<RpcGitMutationResult> {
	return mutate(cwd, async root => {
		if (action === "push") {
			const args = ["stash", "push", "--include-untracked"];
			if (message?.trim()) args.push("-m", message.trim());
			await git(root, args);
			return { conflicts: 0 };
		}
		return runMayConflict(root, ["stash", "pop"]);
	});
}

export async function operation(cwd: string, action: "continue" | "abort"): Promise<RpcGitMutationResult> {
	return mutate(cwd, async root => {
		const head = await getGitHead(root);
		if (!head.operation)
			throw new LocalCommandError("No merge, rebase, cherry-pick or revert is in progress", "git_failed");
		if (action === "abort") {
			await git(root, [head.operation, "--abort"]);
			return { conflicts: 0 };
		}
		if ((await conflictCount(root)) > 0)
			throw new LocalCommandError("Resolve every conflict before continuing", "git_failed");
		return runMayConflict(root, [head.operation, "--continue"]);
	});
}

const BRANCH_FORMAT = [
	"%(refname)",
	"%(refname:short)",
	"%(upstream:short)",
	"%(objectname:short)",
	"%(committerdate:unix)",
	"%(worktreepath)",
	"%(HEAD)",
].join("%00");

export async function branches(cwd: string): Promise<RpcGitBranch[]> {
	const root = await requireRoot(cwd);
	const realRoot = await fs.realpath(root);
	const output = await git(root, [
		"for-each-ref",
		"--sort=-committerdate",
		`--format=${BRANCH_FORMAT}`,
		"refs/heads",
		"refs/remotes",
	]);
	const list: RpcGitBranch[] = [];
	for (const line of output.split("\n")) {
		const [ref, name, upstream, sha, date, worktree, headMark] = line.split("\0");
		if (!ref || !name || ref.endsWith("/HEAD")) continue;
		const current = headMark === "*";
		let elsewhere: string | null = null;
		if (worktree && !current) {
			const real = await fs.realpath(worktree).catch(() => worktree);
			elsewhere = real === realRoot ? null : worktree;
		}
		list.push({
			name,
			remote: ref.startsWith("refs/remotes/"),
			current,
			upstream: upstream || null,
			worktree: elsewhere,
			sha: sha ?? "",
			date: Number(date) || 0,
		});
	}
	return list;
}

export async function branch(
	cwd: string,
	input: {
		action: "switch" | "create" | "rename" | "delete" | "merge";
		name: string;
		newName?: string;
		base?: string;
		force?: boolean;
	},
): Promise<RpcGitMutationResult> {
	const name = checkRef(input.name);
	return mutate(cwd, async root => {
		const known = await branches(root);
		const entry = known.find(item => item.name === name);
		switch (input.action) {
			case "switch": {
				if (entry?.worktree)
					throw new LocalCommandError(`${name} is checked out in ${entry.worktree}`, "branch_checked_out");
				if (entry?.remote) {
					const local = name.slice(name.indexOf("/") + 1);
					if (known.some(item => !item.remote && item.name === local)) await git(root, ["switch", local]);
					else await git(root, ["switch", "--track", name]);
				} else {
					await git(root, ["switch", name]);
				}
				return { conflicts: 0 };
			}
			case "create": {
				const args = ["switch", "-c", name];
				if (input.base) args.push(checkRef(input.base));
				await git(root, args);
				return { conflicts: 0 };
			}
			case "rename":
				await git(root, ["branch", "-m", name, checkRef(input.newName ?? "")]);
				return { conflicts: 0 };
			case "delete":
				if (entry?.current)
					throw new LocalCommandError("Switch away before deleting the current branch", "git_failed");
				if (entry?.worktree)
					throw new LocalCommandError(`${name} is checked out in ${entry.worktree}`, "branch_checked_out");
				await git(root, ["branch", input.force ? "-D" : "-d", name]);
				return { conflicts: 0 };
			case "merge":
				return runMayConflict(root, ["merge", "--no-edit", name]);
		}
	});
}

const LOG_FORMAT = "%H%x00%h%x00%an%x00%at%x00%s%x00%D%x00%P%x1e";

function parseLogRecord(record: string): RpcGitCommit | null {
	const [sha, shortSha, author, date, subject, decoration, parents] = record.replace(/^\n/, "").split("\0");
	if (!sha || !shortSha) return null;
	return {
		sha,
		shortSha,
		author: author ?? "",
		date: Number(date) || 0,
		subject: subject ?? "",
		...parseDecorations(decoration ?? ""),
		parents: (parents ?? "").split(" ").filter(Boolean),
	};
}

async function commitUrl(root: string): Promise<string | null> {
	const remotes = (await git(root, ["remote"])).split("\n").filter(Boolean);
	const name = remotes.includes("origin") ? "origin" : remotes[0];
	if (!name) return null;
	const url = await gitRaw(root, ["remote", "get-url", name]);
	const base = url.code === 0 ? remoteWebBase(url.stdout.toString("utf8")) : null;
	return base ? `${base}/commit/{sha}` : null;
}

export async function log(cwd: string, input: { limit?: number; skip?: number; query?: string }): Promise<RpcGitLog> {
	const root = await requireRoot(cwd);
	if (!(await hasHead(root))) return { commits: [], more: false, commitUrl: null };
	const limit = Math.min(Math.max(input.limit ?? LOG_PAGE, 1), 500);
	const args = ["log", `--format=${LOG_FORMAT}`, "-n", String(limit + 1), `--skip=${Math.max(input.skip ?? 0, 0)}`];
	const query = input.query?.trim();
	if (query) {
		// A hex query may be a commit id; otherwise match subject/body and author.
		if (/^[0-9a-f]{4,40}$/i.test(query)) {
			const match = await gitRaw(root, ["rev-parse", "--verify", "--quiet", `${query}^{commit}`]);
			if (match.code === 0) args.push("--no-walk", match.stdout.toString("utf8").trim());
			else args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${query}`);
		} else {
			args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${query}`);
		}
	}
	const [output, url] = await Promise.all([git(root, args), commitUrl(root)]);
	const commits = output
		.split("\x1e")
		.map(parseLogRecord)
		.filter(entry => entry !== null);
	return { commits: commits.slice(0, limit), more: commits.length > limit, commitUrl: url };
}

export async function commitDetail(cwd: string, sha: string): Promise<RpcGitCommitDetail> {
	const root = await requireRoot(cwd);
	const id = checkSha(sha);
	const [header, body, numstat, names] = await Promise.all([
		git(root, ["log", "-1", `--format=${LOG_FORMAT}`, id]),
		git(root, ["log", "-1", "--format=%b", id]),
		git(root, ["show", "--format=", "--numstat", "-z", "--find-renames", "--first-parent", id]),
		git(root, ["show", "--format=", "--name-status", "-z", "--find-renames", "--first-parent", id]),
	]);
	const entry = parseLogRecord(header.split("\x1e")[0] ?? "");
	if (!entry) throw new LocalCommandError(`Unknown commit: ${sha}`, "invalid_name");
	const counts = new Map<string, { added: number; removed: number }>();
	const records = numstat.split("\0");
	for (let index = 0; index < records.length; index++) {
		const match = /^\n?(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index]!);
		if (!match) continue;
		const filePath = match[3] || records[index + 2];
		if (!match[3]) index += 2;
		if (filePath && match[1] !== "-" && match[2] !== "-")
			counts.set(filePath, { added: Number(match[1]), removed: Number(match[2]) });
	}
	const files: RpcGitCommitDetail["files"] = [];
	const fields = names.split("\0").map(field => field.replace(/^\n/, ""));
	for (let index = 0; index < fields.length; index++) {
		const status = fields[index];
		if (!status) continue;
		if (status.startsWith("R") || status.startsWith("C")) {
			const oldPath = fields[index + 1] ?? "";
			const newPath = fields[index + 2] ?? "";
			index += 2;
			files.push({ path: newPath, oldPath, status: status[0]!, ...counts.get(newPath) });
		} else {
			const filePath = fields[index + 1] ?? "";
			index += 1;
			files.push({ path: filePath, status: status[0]!, ...counts.get(filePath) });
		}
	}
	return { ...entry, body: body.trim(), files };
}

export async function commitDiff(cwd: string, sha: string, filePath: string): Promise<RpcGitDiff> {
	const root = await requireRoot(cwd);
	const id = checkSha(sha);
	if (!isSafeRelativePath(filePath)) throw new LocalCommandError("Invalid repository-relative path", "invalid_path");
	const result = await gitRaw(
		root,
		[
			"show",
			"--format=",
			"--no-color",
			"--no-ext-diff",
			"--find-renames",
			"--first-parent",
			"-U3",
			id,
			"--",
			`:(literal)${filePath}`,
		],
		{ maxBytes: 4 * 1024 * 1024 },
	);
	if (result.code !== 0) throw new LocalCommandError(result.stderr.trim() || "git show failed", "git_failed");
	const diff = result.stdout.toString("utf8");
	if (/^Binary files /m.test(diff)) return { path: filePath, diff: "", kind: "binary", truncated: false };
	return {
		path: filePath,
		diff: diff.slice(0, MAX_DIFF_CHARS),
		kind: "text",
		truncated: result.truncated || diff.length > MAX_DIFF_CHARS,
	};
}

/**
 * C77: swap `sha` with its parent ("earlier") or with its child on HEAD's line ("later") through an interactive
 * rebase whose todo main writes itself (GIT_SEQUENCE_EDITOR copies it in). Only a clean, merge-free, unpushed
 * stretch of the current line is rewritten; a conflict stops the rebase for continue/abort like any other.
 */
async function reorderCommit(root: string, sha: string, direction: "earlier" | "later"): Promise<RpcGitMutationResult> {
	const head = await getGitHead(root);
	if (head.operation) throw new LocalCommandError(`Finish or abort the ${head.operation} first`, "git_failed");
	if ((await git(root, ["status", "--porcelain=v1", "--untracked-files=no"])).trim())
		throw new LocalCommandError("Commit or stash your changes before moving a commit", "dirty_worktree");
	const full = (await git(root, ["rev-parse", "--verify", `${sha}^{commit}`])).trim();
	let older = full;
	if (direction === "earlier") {
		const parents = (await git(root, ["rev-list", "--parents", "-n", "1", full])).trim().split(" ").slice(1);
		if (parents.length !== 1)
			throw new LocalCommandError("Only a commit with one parent can move earlier", "git_failed");
		older = parents[0]!;
	}
	const olderParents = (await git(root, ["rev-list", "--parents", "-n", "1", older])).trim().split(" ").slice(1);
	if (olderParents.length !== 1)
		throw new LocalCommandError("The first commit and merge commits can't be moved", "git_failed");
	const base = olderParents[0]!;
	// A merge anywhere above `base` would be flattened (or its side lost) by a plain todo: refuse those lines.
	if ((await git(root, ["rev-list", "--merges", "--count", `${base}..HEAD`])).trim() !== "0")
		throw new LocalCommandError("Commits after this one include a merge; reorder them in a terminal", "git_failed");
	// HEAD's line from `older` up, oldest first.
	const order = (await git(root, ["rev-list", "--reverse", `${base}..HEAD`])).trim().split("\n").filter(Boolean);
	if (order[0] !== older || order.length < 2 || (direction === "earlier" && order[1] !== full))
		throw new LocalCommandError("Only commits on the current branch with a commit after them can move", "git_failed");
	if (head.upstream && (await gitRaw(root, ["merge-base", "--is-ancestor", older, "@{upstream}"])).code === 0)
		throw new LocalCommandError(
			`${older.slice(0, 7)} is already on ${head.upstream}; moving it would rewrite pushed history`,
			"commit_pushed",
		);
	[order[0], order[1]] = [order[1]!, order[0]!];
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-reorder-"));
	try {
		const todo = path.join(dir, "git-rebase-todo");
		await fs.writeFile(todo, `${order.map(commit => `pick ${commit}`).join("\n")}\n`);
		// git runs the sequence editor through its shell (sh, also on Git for Windows) with the todo path appended.
		const quoted = `'${todo.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
		return await runMayConflict(root, ["rebase", "-i", "--no-autosquash", base], {
			GIT_SEQUENCE_EDITOR: `cp ${quoted}`,
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

export async function historyAction(
	cwd: string,
	input: {
		action:
			| "checkout"
			| "branch"
			| "cherry_pick"
			| "revert"
			| "reset"
			| "tag"
			| "delete_tag"
			| "move_earlier"
			| "move_later";
		sha: string;
		mode?: "soft" | "mixed" | "hard";
		name?: string;
	},
): Promise<RpcGitMutationResult> {
	const sha = checkSha(input.sha);
	return mutate(cwd, async root => {
		switch (input.action) {
			case "checkout":
				await git(root, ["switch", "--detach", sha]);
				return { conflicts: 0 };
			case "branch":
				await git(root, ["switch", "-c", checkRef(input.name ?? ""), sha]);
				return { conflicts: 0 };
			case "cherry_pick":
				return runMayConflict(root, ["cherry-pick", sha]);
			case "revert":
				return runMayConflict(root, ["revert", "--no-edit", sha]);
			case "reset": {
				const mode = input.mode ?? "mixed";
				if (!["soft", "mixed", "hard"].includes(mode))
					throw new LocalCommandError(`Unknown reset mode: ${mode}`, "invalid_name");
				await git(root, ["reset", `--${mode}`, sha]);
				return { conflicts: 0 };
			}
			case "tag":
				await git(root, ["tag", checkRef(input.name ?? ""), sha]);
				return { conflicts: 0 };
			case "delete_tag":
				await git(root, ["tag", "-d", checkRef(input.name ?? "")]);
				return { conflicts: 0 };
			case "move_earlier":
				return reorderCommit(root, sha, "earlier");
			case "move_later":
				return reorderCommit(root, sha, "later");
		}
	});
}
