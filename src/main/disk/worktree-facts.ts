/**
 * What disk care reads of one worktree before it touches it: its files split by what git and the project say about
 * them, when anyone last changed anything in it, whether a git operation is half done, and which running processes
 * sit inside it. Read-only.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import { agentDir } from "../agent-paths";
import { git, gitRaw } from "../local/git/exec";
import { isInside } from "../local/git/parse";
import { realFolder } from "../worktree-removals";
import { classifyIgnored, type IgnoredVerdict, readEvidence } from "./regenerable";

/** A worktree's files outside its HEAD, relative and `/`-separated (a directory ends with `/`). */
export interface WorktreeFiles {
	/** Ignored entries with the evidence that the project makes them again, or none. */
	ignored: IgnoredVerdict[];
	/** Untracked entries git does not ignore, collapsed to a directory where git collapses them. */
	untracked: IgnoredVerdict[];
	/** Every untracked file, one per file (what a commit of the worktree would add). */
	untrackedFiles: string[];
	/** Tracked paths with changes (modified, added, deleted, renamed). */
	changed: string[];
	/** Every tracked path (`git ls-files`), read in the same pass. */
	tracked: string[];
	/** `git status` as printed: equal before and after means nothing moved in between. */
	fingerprint: string;
}

/** `git status --porcelain=v1 -z` split by kind. A rename prints its old path as one more NUL field. */
function parseStatus(output: string): { ignored: string[]; untracked: string[]; changed: string[] } {
	const parsed = { ignored: [] as string[], untracked: [] as string[], changed: [] as string[] };
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index] ?? "";
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		const file = field.slice(3);
		if (code === "!!") parsed.ignored.push(file);
		else if (code === "??") parsed.untracked.push(file);
		else {
			parsed.changed.push(file);
			if (code.includes("R") || code.includes("C")) index++;
		}
	}
	return parsed;
}

export async function readWorktreeFiles(worktree: string): Promise<WorktreeFiles> {
	const [status, others] = await Promise.all([
		gitRaw(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=traditional"], {
			maxBytes: 64 * 1024 * 1024,
		}),
		gitRaw(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBytes: 64 * 1024 * 1024 }),
	]);
	if (status.code !== 0 || status.truncated) throw new Error(`git status failed in ${worktree}`);
	if (others.code !== 0 || others.truncated) throw new Error(`git ls-files failed in ${worktree}`);
	const fingerprint = status.stdout.toString("utf8");
	const parsed = parseStatus(fingerprint);
	const evidence = await readEvidence(worktree, parsed.ignored);
	return {
		ignored: await classifyIgnored(parsed.ignored, evidence),
		untracked: await classifyIgnored(parsed.untracked, evidence),
		untrackedFiles: others.stdout.toString("utf8").split("\0").filter(Boolean),
		changed: parsed.changed,
		tracked: [...evidence.tracked],
		fingerprint,
	};
}

/** Markers git leaves while a rebase, merge, cherry-pick, revert or bisect waits to be finished. */
const IN_PROGRESS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];

/**
 * The worktree's git dir, as `git rev-parse --git-dir` names it, read from its `.git`: the folder itself, or the file a
 * linked worktree has (`gitdir: <path>`, absolute or relative to the worktree). Git itself when neither is there.
 */
export async function gitDirOf(worktree: string): Promise<string> {
	const dotGit = path.join(worktree, ".git");
	const stat = await fs.stat(dotGit).catch(() => null);
	if (stat?.isDirectory()) return dotGit;
	const named = stat?.isFile() ? /^gitdir: (.+)$/m.exec(await fs.readFile(dotGit, "utf8"))?.[1]?.trim() : undefined;
	if (named) return path.resolve(worktree, named);
	return path.resolve(worktree, (await git(worktree, ["rev-parse", "--git-dir"])).trim());
}

/** The half-done git operation in the worktree, or null. */
export async function inProgressOperation(worktree: string): Promise<string | null> {
	const gitDir = await gitDirOf(worktree);
	for (const marker of IN_PROGRESS) {
		if (await fs.stat(path.join(gitDir, marker)).catch(() => null)) return marker;
	}
	return null;
}

/** Entries an activity walk reads before it gives up and calls the worktree active (fail closed). */
const ACTIVITY_WALK_LIMIT = 20_000;

async function newestUnder(target: string, budget: { left: number }): Promise<number> {
	const stat = await fs.lstat(target).catch(() => null);
	if (!stat) return 0;
	let newest = stat.mtimeMs;
	if (!stat.isDirectory()) return newest;
	for (const name of await fs.readdir(target).catch(() => [] as string[])) {
		if (--budget.left < 0) return Number.POSITIVE_INFINITY;
		newest = Math.max(newest, await newestUnder(path.join(target, name), budget));
	}
	return newest;
}

/** stock omp's session folder for a cwd under the home folder: `-` plus the path from home with `/` as `-`. */
function sessionFolder(worktree: string): string {
	const relative = path.relative(os.homedir(), worktree);
	return path.join(agentDir(), "sessions", `-${relative.split(path.sep).join("-")}`);
}

/**
 * When anything in the worktree last changed (epoch ms): its HEAD commit, its git dir's HEAD, index and reflog, the
 * folder, every tracked and untracked file, every ignored entry no tool makes again (a seeded `.env` someone edited)
 * and the newest session file stock omp wrote for it. Regenerable output is left out: a build is no one's work.
 * `Infinity` when an ignored tree is too big to read.
 */
export async function lastActivity(worktree: string, files: WorktreeFiles): Promise<number> {
	const [committed, gitDir] = await Promise.all([
		git(worktree, ["log", "-1", "--format=%ct", "HEAD"]).catch(() => "0"),
		gitDirOf(worktree),
	]);
	let newest = (Number(committed.trim()) || 0) * 1000;
	const stamps = [
		worktree,
		path.join(gitDir, "HEAD"),
		path.join(gitDir, "index"),
		path.join(gitDir, "logs", "HEAD"),
		...files.tracked,
		...files.untrackedFiles,
	];
	for (const stamp of stamps) {
		const stat = await fs.lstat(path.resolve(worktree, stamp)).catch(() => null);
		if (stat) newest = Math.max(newest, stat.mtimeMs);
	}
	const budget = { left: ACTIVITY_WALK_LIMIT };
	for (const entry of files.ignored) {
		if (entry.regenerable) continue;
		newest = Math.max(newest, await newestUnder(path.join(worktree, entry.path), budget));
	}
	const sessions = sessionFolder(worktree);
	for (const name of await fs.readdir(sessions).catch(() => [] as string[])) {
		const stat = await fs.stat(path.join(sessions, name)).catch(() => null);
		if (stat) newest = Math.max(newest, stat.mtimeMs);
	}
	return newest;
}

function run(command: string, args: string[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(command, args, { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
		resolve(error && !stdout ? null : String(stdout)),
	);
	return promise;
}

/**
 * The working folders of this user's running processes, as real paths; null when this platform cannot tell
 * (Windows), and every caller then keeps what it would have touched.
 */
export async function processWorkingFolders(): Promise<string[] | null> {
	if (process.platform === "darwin") {
		// `lsof -d cwd` over every process: lines `p<pid>` then `n<path>`. A non-zero exit with output is lsof
		// complaining about processes it may not read (other users'); the ones it lists are the ones that count.
		const output = await run("lsof", ["-a", "-d", "cwd", "-Fn", "-w"]);
		if (output === null) return null;
		return output
			.split("\n")
			.filter(line => line.startsWith("n/"))
			.map(line => line.slice(1));
	}
	if (process.platform === "linux") {
		const folders: string[] = [];
		for (const pid of await fs.readdir("/proc").catch(() => [] as string[])) {
			if (!/^\d+$/.test(pid)) continue;
			const cwd = await fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
			if (cwd) folders.push(cwd);
		}
		return folders;
	}
	return null;
}

/** Whether a process works in the worktree; null (unknown) counts as yes for every caller. */
export function processInside(worktree: string, folders: readonly string[] | null): boolean {
	if (folders === null) return true;
	const real = realFolder(worktree);
	return folders.some(folder => folder === real || isInside(real, folder));
}

/** A file whose name says it holds a secret: never committed, kept in the private archive instead. */
const SECRET_NAME =
	/(?:^|\/)(?:\.env(?:\..+)?|\.envrc|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials[^/]*|[^/]*secret[^/]*|[^/]*\.(?:pem|key|p12|pfx|keystore|jks|kdbx))$/i;
/** Files are read whole up to this size; a bigger one is never committed (it goes to the archive unread). */
export const SECRET_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const MARKERS = /<secret>|<token>/g;

/**
 * The text holds a credential by the central redactor's rules (`resources/gui-bridge/redactor.ts`, the one diagnostics
 * and memory use): it puts a `<secret>` or `<token>` where there was none. That also catches a long hex or base64
 * run (a lockfile's hashes), which only sends that file to the archive instead of the commit: nothing is lost.
 */
function holdsCredential(text: string): boolean {
	return (redactDiagnosticsText(text).match(MARKERS)?.length ?? 0) > (text.match(MARKERS)?.length ?? 0);
}

/**
 * Whether a file named `relative` with these bytes may never enter a commit: its name says secret, its content holds a
 * credential, or it was not read whole (`complete` false, over `SECRET_SCAN_MAX_BYTES`).
 */
export function secretIn(relative: string, bytes: Buffer, complete = true): boolean {
	return !complete || SECRET_NAME.test(relative) || holdsCredential(bytes.toString("latin1"));
}

/** The worktree's file `relative` may never enter a commit (`secretIn`); a file that cannot be read whole counts. */
export async function looksSecret(worktree: string, relative: string): Promise<boolean> {
	if (SECRET_NAME.test(relative)) return true;
	const file = path.join(worktree, relative);
	const stat = await fs.stat(file).catch(() => null);
	if (!stat || stat.size > SECRET_SCAN_MAX_BYTES) return true;
	const bytes = await fs.readFile(file).catch(() => null);
	return bytes === null || secretIn(relative, bytes);
}
