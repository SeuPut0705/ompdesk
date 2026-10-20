/**
 * `get_git_session_changes`: what this checkout changed since the session started, from git. The baseline is the
 * newest commit of HEAD's history committed before the session's first entry (`git rev-list -1 --before`), so the
 * session's own commits stay counted after it commits or pushes them; the diff runs from that baseline to the
 * working tree (committed, staged and unstaged together) plus untracked files. A session with no file yet, or a
 * checkout with no commit before it, has HEAD as its baseline: its uncommitted changes, as `get_git_changes`.
 */
import * as fs from "node:fs/promises";
import type { RpcGitChanges } from "../../../shared/rpc-types";
import { getGitChanges, repoRoot } from "./changes";
import { git, gitRaw } from "./exec";
import { parseGitStatus } from "./parse";

const MAX_FILES = 1000;
/** Enough of a session file for its header line (`{"type":"session",…,"timestamp":…}`). */
const HEADER_BYTES = 4096;

/** When the session started: its header's timestamp, else the file's birth time; null when neither is readable. */
export async function sessionStartedAt(sessionFile: string): Promise<number | null> {
	try {
		const handle = await fs.open(sessionFile, "r");
		try {
			const buffer = Buffer.alloc(HEADER_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
			const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
			const header: unknown = JSON.parse(first);
			if (header && typeof header === "object" && "timestamp" in header) {
				const at = Date.parse(String(header.timestamp));
				if (Number.isFinite(at)) return at;
			}
		} finally {
			await handle.close();
		}
	} catch {
		// No header to read: the birth time below.
	}
	const stat = await fs.stat(sessionFile).catch(() => null);
	return stat && stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
}

/** The newest commit of HEAD's history committed before `since`; null when there is none. */
async function baselineCommit(root: string, since: number): Promise<string | null> {
	const result = await gitRaw(root, ["rev-list", "-1", `--before=${Math.floor(since / 1000)}`, "HEAD", "--"]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

export async function getGitSessionChanges(cwd: string, since: number | null): Promise<RpcGitChanges> {
	const root = await repoRoot(cwd);
	if (!root) return { isRepo: false, root: null, base: null, files: [], truncated: false };
	const base = since === null ? null : await baselineCommit(root, since);
	if (!base) return getGitChanges(cwd);
	const [names, numstat, status] = await Promise.all([
		git(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", base]),
		git(root, ["diff", "--numstat", "-z", "--find-renames", "--no-ext-diff", base]),
		git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
	]);
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
	for (const entry of parseGitStatus(status)) if (entry.index === "?") files.push({ path: entry.path, status: "??" });
	return { isRepo: true, root, base, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}
