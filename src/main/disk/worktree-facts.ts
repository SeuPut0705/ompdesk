/**
 * What disk care reads of one worktree before it touches it: its files split by what git and the project say about
 * them, when anyone last changed anything in it, whether a git operation is half done, its HEAD, and which running
 * processes sit inside it. Read-only. The reads run in the core process (`native/ompdesk/crates/core/src/disk/facts.rs`
 * and `regenerable.rs`, the rule table of what a project makes again); what stays here is main's: where stock omp keeps
 * a folder's sessions, whether a process folder is inside a worktree (real paths, `realFolder`), and the secret check,
 * which reads the central redactor.
 */
import * as os from "node:os";
import * as path from "node:path";
import { redactDiagnosticsText } from "../../../resources/gui-bridge/redactor";
import { agentDir } from "../agent-paths";
import { fs } from "../fenced-fs";
import { coreGit, coreHeld } from "../local/git/exec";
import { isInside } from "../local/git/parse";
import { stepStalled } from "../serial-chain";
import { realFolder } from "../worktree-removals";

export type RegenerableReason =
	| "cachedir-tag"
	| "lockfile-dependencies"
	| "python-bytecode"
	| "build-tool-output"
	| "gitignore-build-section";

export interface IgnoredVerdict {
	/** Relative to the worktree, `/`-separated; a directory ends with `/` (as `git status` prints it). */
	path: string;
	/** Null: no evidence the project makes it again. */
	regenerable: { reason: RegenerableReason; evidence: string } | null;
}

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

/**
 * Deadlines of the core requests, in default-timeout gits one after another: the files are status and the untracked
 * list, then the tracked list and `check-ignore`, then the rules' reads; the activity is the HEAD commit and the git
 * dir, then the stamps and the walk of what no tool makes again.
 */
const FILES_ROUNDS = 3;
const ACTIVITY_ROUNDS = 3;
/** `lsof` over every process. */
const PROCESS_LIST_MS = 30_000;

export function readWorktreeFiles(worktree: string): Promise<WorktreeFiles> {
	return coreGit("disk.worktreeFiles", { worktree }, FILES_ROUNDS);
}

/** The half-done git operation in the worktree (a rebase, merge, cherry-pick, revert or bisect marker), or null. */
export function inProgressOperation(worktree: string): Promise<string | null> {
	return coreGit("disk.inProgress", { worktree }, 2);
}

/** The worktree's HEAD commit. */
export function worktreeHead(worktree: string): Promise<string> {
	return coreGit("disk.head", { worktree }, 1);
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
	const newest = await coreGit<number | null>(
		"disk.lastActivity",
		{
			worktree,
			stamps: [...files.tracked, ...files.untrackedFiles],
			ignored: files.ignored.filter(entry => !entry.regenerable).map(entry => entry.path),
			sessions: sessionFolder(worktree),
		},
		ACTIVITY_ROUNDS,
	);
	return newest ?? Number.POSITIVE_INFINITY;
}

/**
 * The working folders of this user's running processes, as real paths; null when this platform cannot tell
 * (Windows), and every caller then keeps what it would have touched.
 */
export function processWorkingFolders(): Promise<string[] | null> {
	// A core that cannot answer cannot tell either; a stopped lock step still hears of its stop.
	return coreHeld<string[] | null>("disk.processFolders", {}, PROCESS_LIST_MS).catch((error: unknown) => {
		if (stepStalled()) throw error;
		return null;
	});
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
