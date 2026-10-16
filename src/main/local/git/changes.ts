/** `get_git_status`, `get_git_changes`, `get_git_diff` over the git CLI (port of fork rpc-git-diff.ts / buildRpcGitStatus). */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcGitChanges, RpcGitDiff, RpcGitFingerprint, RpcGitHead, RpcGitStatus } from "../../../shared/rpc-types";
import { git, gitRaw } from "./exec";
import {
	isInside,
	isProbablyBinaryHeader,
	isSafeRelativePath,
	newFileDiff,
	parseBranchHeaders,
	parseGitStatus,
	parseStatusV2,
} from "./parse";

const MAX_FILES = 1000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_CHARS = 200_000;
const BINARY_SNIFF_BYTES = 8192;

/** Worktree top-level for `cwd`, or null outside a repository. */
export async function repoRoot(cwd: string): Promise<string | null> {
	const result = await gitRaw(cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return null;
	const root = result.stdout.toString("utf8").trim();
	return root ? path.resolve(root) : null;
}

/** Main checkout root shared by every linked worktree (`--git-common-dir`'s parent). */
export async function primaryRoot(cwd: string): Promise<string> {
	const common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
	return path.basename(common) === ".git" ? path.dirname(common) : common;
}

async function headSha(cwd: string): Promise<string | null> {
	const result = await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

export async function getGitStatus(cwd: string): Promise<RpcGitStatus> {
	const result = await gitRaw(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	if (result.code !== 0) return { isRepo: false, branch: null, staged: 0, unstaged: 0, untracked: 0 };
	return { isRepo: true, ...parseStatusV2(result.stdout.toString("utf8")) };
}

/** Which stopped operation (merge, rebase, cherry-pick, revert) waits in `gitDir`, if any. */
async function pendingOperation(gitDir: string): Promise<RpcGitHead["operation"]> {
	const exists = (name: string) =>
		fs.stat(path.join(gitDir, name)).then(
			() => true,
			() => false,
		);
	const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
		["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].map(exists),
	);
	if (rebaseMerge || rebaseApply) return "rebase";
	if (merge) return "merge";
	if (cherryPick) return "cherry-pick";
	if (revert) return "revert";
	return null;
}

/** Branch, upstream, ahead/behind, stopped operation and stash count of the checkout at `root`. */
export async function getGitHead(root: string): Promise<RpcGitHead> {
	const [branchStatus, gitDir, stashes, remotes] = await Promise.all([
		git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"]),
		git(root, ["rev-parse", "--absolute-git-dir"]),
		gitRaw(root, ["stash", "list", "--format=%H"]),
		git(root, ["remote"]),
	]);
	return {
		...parseBranchHeaders(branchStatus),
		operation: await pendingOperation(gitDir.trim()),
		stashes: stashes.code === 0 ? stashes.stdout.toString("utf8").split("\n").filter(Boolean).length : 0,
		hasRemote: remotes.trim().length > 0,
	};
}

/**
 * A cheap stand-in for `getGitChanges` that the Changes panel polls: one `status --porcelain=v2 --branch -z
 * --untracked-files=all` (whose `branch.oid` header is the HEAD oid) plus an in-process `lstat` of every
 * listed path, and a `rev-parse --show-toplevel` only when the caller does not pass the root its last full
 * read reported (or passes one that does not hold `cwd`). The stats matter because a file edited again keeps
 * its ` M` status while its line counts and diff move. The fingerprint changes whenever the full answer may
 * have; it never reads a diff. A passed root that is no longer `cwd`'s worktree (a repository made inside
 * it) is harmless: that repository's status differs, so the panel reloads and passes the new root.
 */
export async function getGitFingerprint(cwd: string, knownRoot?: string): Promise<RpcGitFingerprint> {
	// Git reports the root as a real path; the tab's cwd may reach it through a symlink (macOS /var, /tmp).
	const known = knownRoot && path.isAbsolute(knownRoot) ? path.resolve(knownRoot) : null;
	const real = known ? await fs.realpath(cwd).catch(() => null) : null;
	const trusted = known && real && (known === real || isInside(known, real)) ? known : null;
	const [root, status] = await Promise.all([
		trusted ?? repoRoot(cwd),
		gitRaw(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
	]);
	const hash = createHash("sha1");
	if (!root || status.code !== 0) return { fingerprint: hash.update("not-a-repository").digest("hex") };
	const text = status.stdout.toString("utf8");
	hash.update(text);
	const records = text.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < records.length && paths.length < MAX_FILES; index++) {
		const record = records[index]!;
		// Fields before the path: `1` has 8, `2` has 9 (and a second record holds the old path), `u` has 10.
		const skip = record.startsWith("1 ") ? 8 : record.startsWith("2 ") ? 9 : record.startsWith("u ") ? 10 : -1;
		if (record.startsWith("? ")) paths.push(record.slice(2));
		else if (skip > 0) paths.push(record.split(" ").slice(skip).join(" "));
		if (record.startsWith("2 ")) index++;
	}
	const stamps = await Promise.all(
		paths.map(file =>
			fs.lstat(path.join(root, file)).then(
				stat => `${stat.mtimeMs}:${stat.size}`,
				() => "gone",
			),
		),
	);
	for (const stamp of stamps) hash.update(`\0${stamp}`);
	return { fingerprint: hash.digest("hex") };
}

export async function getGitChanges(cwd: string): Promise<RpcGitChanges> {
	// HEAD resolves the same from anywhere in the worktree, so it does not wait for the root.
	const [root, base] = await Promise.all([repoRoot(cwd), headSha(cwd)]);
	if (!root) return { isRepo: false, root: null, base: null, files: [], truncated: false };
	const [status, changed, numstat, head] = await Promise.all([
		git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		base ? git(root, ["diff", "--name-only", "-z", "--no-renames", base]) : Promise.resolve(null),
		base ? git(root, ["diff", "--numstat", "-z", "--find-renames", "--no-ext-diff", base]) : Promise.resolve(""),
		getGitHead(root),
	]);
	const counts = new Map<string, { added: number; removed: number }>();
	const records = numstat.split("\0");
	for (let index = 0; index < records.length; index++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index]!);
		if (!match) continue;
		// With -z, a renamed path is an empty field followed by old/new NUL records.
		const filePath = match[3] || records[index + 2];
		if (!match[3]) index += 2;
		if (filePath && match[1] !== "-" && match[2] !== "-")
			counts.set(filePath, { added: Number(match[1]), removed: Number(match[2]) });
	}
	// Net change vs HEAD: a file edited then reverted in the worktree shows in status but not here.
	// A staged path stays: the next commit would record it.
	const net = changed === null ? null : new Set(changed.split("\0").filter(Boolean));
	const files = parseGitStatus(status)
		.filter(
			entry =>
				entry.index !== " " ||
				entry.oldPath !== undefined ||
				(net
					? net.has(entry.path) || (entry.oldPath !== undefined && net.has(entry.oldPath))
					: entry.worktree !== "D"),
		)
		.map(entry => ({
			path: entry.path,
			oldPath: entry.oldPath,
			status: `${entry.index}${entry.worktree}`,
			...counts.get(entry.path),
		}));
	return {
		isRepo: true,
		root,
		base,
		files: files.slice(0, MAX_FILES),
		truncated: files.length > MAX_FILES,
		head,
	};
}

async function readHeader(file: string): Promise<Uint8Array> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** Read one authorized changed path; never follow a symlink out of the checkout. */
export async function getGitDiff(cwd: string, filePath: string): Promise<RpcGitDiff> {
	if (!isSafeRelativePath(filePath)) throw new Error("Invalid repository-relative path");
	const changes = await getGitChanges(cwd);
	const entry = changes.files.find(file => file.path === filePath);
	if (!changes.root || !entry)
		throw new Error("This file is no longer in the changed file list. Refresh to continue.");
	const root = changes.root;
	const result: RpcGitDiff = { path: filePath, diff: "", kind: "text", truncated: false };
	const absolute = path.join(root, filePath);
	let exists = true;
	try {
		const stat = await fs.lstat(absolute);
		if (stat.isSymbolicLink()) return { ...result, kind: "symlink" };
		if (stat.isDirectory()) return { ...result, kind: "directory" };
		const resolved = await fs.realpath(absolute);
		if (!isInside(await fs.realpath(root), resolved)) throw new Error("File resolves outside this checkout");
		if (stat.size > MAX_DIFF_BYTES) return { ...result, kind: "large", truncated: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		exists = false;
	}
	if (exists && isProbablyBinaryHeader(await readHeader(absolute))) return { ...result, kind: "binary" };
	const isNew = !changes.base || entry.status === "??" || entry.status[0] === "A";
	if (!isNew && changes.base) {
		const spec = `${changes.base}:${entry.oldPath ?? filePath}`;
		const size = await gitRaw(root, ["cat-file", "-s", spec]);
		if (size.code === 0) {
			if (Number(size.stdout.toString("utf8").trim()) > MAX_DIFF_BYTES)
				return { ...result, kind: "large", truncated: true };
			const old = await gitRaw(root, ["cat-file", "blob", spec], { maxBytes: BINARY_SNIFF_BYTES });
			if (isProbablyBinaryHeader(old.stdout.subarray(0, BINARY_SNIFF_BYTES))) return { ...result, kind: "binary" };
		}
	}
	let diff: string;
	if (isNew) {
		diff = newFileDiff(exists ? await fs.readFile(absolute, "utf8") : "");
	} else {
		const raw = await gitRaw(
			root,
			[
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--find-renames",
				"-U3",
				changes.base!,
				"--",
				...[filePath, ...(entry.oldPath ? [entry.oldPath] : [])].map(file => `:(literal)${file}`),
			],
			{ maxBytes: MAX_DIFF_BYTES },
		);
		if (raw.code !== 0) throw new Error(raw.stderr.trim() || "git diff failed");
		diff = raw.stdout.toString("utf8");
	}
	// Content-identical renames produce an empty diff. Preserve the status metadata.
	if (!diff && entry.oldPath) diff = `rename from ${entry.oldPath}\nrename to ${filePath}`;
	return { ...result, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS };
}
