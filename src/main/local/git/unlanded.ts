/**
 * `get_git_unlanded`: what a session's own branch has not landed in the default branch yet: its commits and its
 * uncommitted and untracked work, measured from the merge-base with the remote's default branch (`origin/HEAD`, else
 * `origin/main`/`origin/master`, else a local `main`/`master`). Null on the default branch itself, where sessions share
 * one working tree and nothing in it is one session's, on a detached HEAD and outside a repository.
 */
import type { RpcGitChanges, RpcGitUnlanded } from "../../../shared/rpc-types";
import { repoRoot } from "./changes";
import { git, gitRaw } from "./exec";
import { parseGitStatus } from "./parse";

const MAX_FILES = 1000;

async function revParse(root: string, args: string[]): Promise<string | null> {
	const out = await gitRaw(root, ["rev-parse", ...args]);
	const text = out.code === 0 ? out.stdout.toString("utf8").trim() : "";
	return text || null;
}

/** The ref a branch lands in and its short name: `origin/main` → `main`. */
async function landingTarget(root: string): Promise<{ ref: string; name: string } | null> {
	const remoteHead = await revParse(root, ["--abbrev-ref", "--verify", "--quiet", "refs/remotes/origin/HEAD"]);
	const candidates = [remoteHead, "origin/main", "origin/master", "main", "master"].filter(
		(ref): ref is string => !!ref,
	);
	for (const ref of candidates)
		if (await revParse(root, ["--verify", "--quiet", `${ref}^{commit}`]))
			return { ref, name: ref.replace(/^origin\//, "") };
	return null;
}

/** `--name-status -z` and `--numstat -z` output as files. */
function parseDiff(names: string, numstat: string): RpcGitChanges["files"] {
	const counts = new Map<string, { added: number; removed: number }>();
	const numbers = numstat.split("\0");
	for (let index = 0; index < numbers.length; index++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numbers[index]!);
		if (!match) continue;
		// With -z, a renamed path is an empty field followed by old/new NUL records.
		const filePath = match[3] || numbers[index + 2];
		if (!match[3]) index += 2;
		if (filePath && match[1] !== "-" && match[2] !== "-")
			counts.set(filePath, { added: Number(match[1]), removed: Number(match[2]) });
	}
	const files: RpcGitChanges["files"] = [];
	const records = names.split("\0");
	for (let index = 0; index < records.length; index++) {
		const code = records[index] ?? "";
		if (!code) continue;
		// `R100\0old\0new`, `C…` likewise; every other status is `X\0path`.
		const renamed = code[0] === "R" || code[0] === "C";
		const oldPath = renamed ? records[index + 1] : undefined;
		const filePath = records[index + (renamed ? 2 : 1)];
		index += renamed ? 2 : 1;
		if (filePath) files.push({ path: filePath, oldPath, status: code[0] ?? "M", ...counts.get(filePath) });
	}
	return files;
}

export async function getGitUnlanded(cwd: string): Promise<RpcGitUnlanded | null> {
	const root = await repoRoot(cwd);
	if (!root) return null;
	const branch = (await gitRaw(root, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.toString("utf8").trim();
	if (!branch) return null;
	const target = await landingTarget(root);
	if (!target || target.name === branch) return null;
	const mergeBase = (await gitRaw(root, ["merge-base", "HEAD", target.ref])).stdout.toString("utf8").trim();
	if (!mergeBase) return null;
	const diff = ["--find-renames", "--no-ext-diff", "-z", mergeBase];
	const [names, numstat, status] = await Promise.all([
		git(root, ["diff", "--name-status", ...diff]),
		git(root, ["diff", "--numstat", ...diff]),
		git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
	]);
	const files = parseDiff(names, numstat);
	for (const entry of parseGitStatus(status)) if (entry.index === "?") files.push({ path: entry.path, status: "??" });
	return { branch, target: target.name, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}
