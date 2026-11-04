/**
 * Prepares a worktree OMPdesk just created (`createWorktree`: the worktree dialog, Autopilot, the agent's
 * `ompdesk_session_open` worktrees), so a parallel session does not start without the project's local files.
 *
 * 1. `.worktreeinclude` at the main checkout's root (the cross-tool convention Orca and others read): one path or
 *    glob per line (`#` comments; `*`, `?`, `**`), relative to the root. A match is copied from the main checkout
 *    only when git ignores it there (`git check-ignore`, which never reports a tracked file), so a tracked file is
 *    never copied over the checkout git made. Absolute paths, `..`, `.git` and `!` negations are refused; a match
 *    whose real path leaves the main checkout is refused, and a symlink inside a copied folder is recreated only when
 *    it points inside the main checkout. At most `SEED_MAX_FILES` files are copied, and `SEED_MAX_BYTES` bytes
 *    unless the filesystem clones (the first file is copied with `COPYFILE_FICLONE_FORCE`; when that works every file
 *    is a reflink that takes no disk, so only the file count, the walk's cost, bounds the seed); the rest is skipped
 *    with a note. Existing files in the worktree are never overwritten.
 * 2. `.ompdesk/worktree-setup` (`.ompdesk/worktree-setup.cmd` on Windows), only when that file exists in the new
 *    worktree or the main checkout: run in the worktree under the setup supervisor (its whole process tree dies with
 *    a timeout, a quit or a crash), `SETUP_TIMEOUT_MS`, output logged to the worktree's own git dir. A failure is
 *    reported, never fatal: the worktree stays. The script is the repository's own, run with the user's rights, as
 *    the agent's first `bun install` there would be.
 *
 * `runWorktreeHook` also runs `.ompdesk/worktree-pre-merge` (in the worktree, before `ompdesk_merge` starts git) and
 * `.ompdesk/worktree-post-merge` (in the parent checkout, after the merge landed), found and logged the same way.
 *
 * Stock omp (18.12.1) has neither: no `worktreeinclude` and no worktree hook in its sources, and worktree creation
 * here is OMPdesk's own (`worktree.ts`), so nothing of stock is duplicated.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { WorktreeSeedReport, WorktreeSetupReport } from "../../../shared/rpc-types";
import { fs } from "../../fenced-fs";
import { SUPERVISOR_STOPPED_CODE, spawnSupervised } from "../../setup/supervisor";
import { DEFAULT_TIMEOUT_MS, gitRaw } from "./exec";
import { isInside } from "./parse";

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";
export const SEED_MAX_BYTES = 50 * 1024 * 1024;
export const SEED_MAX_FILES = 10_000;
const MAX_INCLUDE_BYTES = 64 * 1024;
const MAX_PATTERNS = 200;
export const SETUP_TIMEOUT_MS = 120_000;
const SETUP_OUTPUT_TAIL = 4096;
/** The repository's own scripts around a worktree's life: when it is made, and either side of `ompdesk_merge`. */
export type WorktreeHook = "setup" | "pre-merge" | "post-merge";
const HOOK_EXTENSION = process.platform === "win32" ? ".cmd" : "";
export const WORKTREE_HOOK_SCRIPTS: Record<WorktreeHook, string> = {
	setup: `.ompdesk/worktree-setup${HOOK_EXTENSION}`,
	"pre-merge": `.ompdesk/worktree-pre-merge${HOOK_EXTENSION}`,
	"post-merge": `.ompdesk/worktree-post-merge${HOOK_EXTENSION}`,
};
/** What `ompdesk_merge` may spend in hooks: one before the merge, one after. */
export const MERGE_HOOKS_BUDGET_MS = 2 * SETUP_TIMEOUT_MS;
/** Longest `prepareWorktree` holds `worktree_create`'s answer (check-ignore runs, the git dir, the hook). */
export const WORKTREE_PREPARE_BUDGET_MS = 3 * DEFAULT_TIMEOUT_MS + SETUP_TIMEOUT_MS;

/** A pattern line is usable, or the reason it is refused. */
export function includePattern(line: string): { pattern: string } | { refused: string } | null {
	const text = line.trim();
	if (!text || text.startsWith("#")) return null;
	if (text.startsWith("!")) return { refused: "negation" };
	const pattern = text.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!pattern || pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) return { refused: "absolute" };
	const parts = pattern.split("/");
	if (parts.some(part => part === ".." || part === "." || part === "")) return { refused: "outside" };
	if (parts.some(part => part === ".git")) return { refused: "git" };
	return { pattern };
}

function globRegex(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			out += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += pattern[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") out += "[^/]*";
		else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/**
 * Paths git ignores among `paths` (relative to `root`, either separator), named with `/` as git prints them; tracked
 * files are never among them. A `\` in the argument would come back quoted (`"secrets\\key"`) on Windows.
 */
async function ignoredAmong(root: string, paths: string[]): Promise<Set<string>> {
	const ignored = new Set<string>();
	for (let i = 0; i < paths.length; i += 100) {
		const chunk = paths.slice(i, i + 100).map(item => item.replace(/\\/g, "/"));
		// `-z` needs `--stdin`, which the git runner has no input for; a path never holds a newline here.
		const result = await gitRaw(root, ["check-ignore", "--", ...chunk]);
		if (result.code > 1) continue;
		for (const item of result.stdout.toString("utf8").split("\n")) if (item) ignored.add(item.replace(/\/$/, ""));
	}
	return ignored;
}

async function candidates(root: string, patterns: string[]): Promise<string[]> {
	const found = new Set<string>();
	const globs = patterns.filter(p => /[*?]/.test(p)).map(globRegex);
	for (const pattern of patterns.filter(p => !/[*?]/.test(p))) {
		if (await fs.lstat(path.join(root, pattern)).catch(() => null)) found.add(pattern);
	}
	if (globs.length) {
		// Ignored, untracked paths; an ignored folder is listed once (`--directory`), its contents not walked.
		const listed = await gitRaw(root, [
			"ls-files",
			"-z",
			"--others",
			"--ignored",
			"--exclude-standard",
			"--directory",
		]);
		if (listed.code === 0) {
			for (const raw of listed.stdout.toString("utf8").split("\0")) {
				const item = raw.replace(/\/$/, "");
				if (item && globs.some(re => re.test(item))) found.add(item);
			}
		}
	}
	return [...found].sort();
}

/**
 * `fs.copyFile` plus what Node lacks on macOS: there libuv answers `COPYFILE_FICLONE_FORCE` with ENOSYS and
 * `COPYFILE_FICLONE` copies in full, so a clone is `cp -c` (clonefile), asked only on an APFS volume the file and its
 * destination share. Elsewhere (Linux btrfs/XFS) libuv's own reflink does it.
 */
export function cloningCopier(): CopyFile {
	const apfs = new Map<number, Promise<boolean>>();
	const cloneable = async (from: string, to: string): Promise<boolean> => {
		const source = await fs.stat(from);
		if ((await fs.stat(path.dirname(to))).dev !== source.dev) return false;
		let known = apfs.get(source.dev);
		if (!known) {
			// `df -T apfs <path>` prints a row only when the path's volume is APFS.
			known = new Promise<boolean>(resolve =>
				execFile("/bin/df", ["-T", "apfs", from], (error, stdout) =>
					resolve(!error && stdout.trim().split("\n").length > 1),
				),
			);
			apfs.set(source.dev, known);
		}
		return known;
	};
	return async (from, to, mode = 0) => {
		const wantsClone = (mode & (fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_FICLONE_FORCE)) !== 0;
		if (process.platform === "darwin" && wantsClone) {
			const cloned =
				(await cloneable(from, to)) &&
				(await new Promise<boolean>(resolve =>
					execFile("/bin/cp", ["-c", "--", from, to], error => resolve(!error)),
				));
			if (cloned) return;
			if (mode & fs.constants.COPYFILE_FICLONE_FORCE) throw new Error("ENOTSUP: no clone on this volume");
		}
		await fs.copyFile(from, to, mode);
	};
}

/** `seedWorktree`'s copy seam: a test passes one that refuses `COPYFILE_FICLONE_FORCE`, as a filesystem without reflinks does. */
export type CopyFile = (from: string, to: string, mode?: number) => Promise<void>;

interface CopyState {
	root: string;
	target: string;
	copyFile: CopyFile;
	/** Whether the filesystem clones: null until the first file was tried. */
	clone: boolean | null;
	files: number;
	bytes: number;
	skipped: { path: string; reason: string }[];
	full: boolean;
	/** Links recreated with an absolute target in the main checkout, and where that target is in the worktree. */
	absolute: { to: string; mapped: string }[];
}

/**
 * The destination's nearest existing ancestor really lies in the worktree: a folder the target branch checked out as
 * a symlink would otherwise carry `mkdir`/`copyFile` outside it.
 */
async function destinationInside(target: string, to: string): Promise<boolean> {
	let dir = path.dirname(to);
	while (dir !== target && isInside(target, dir)) {
		const stat = await fs.lstat(dir).catch(() => null);
		if (stat) {
			if (!stat.isDirectory()) return false;
			break;
		}
		dir = path.dirname(dir);
	}
	const real = await fs.realpath(dir).catch(() => null);
	return real !== null && (real === target || isInside(target, real));
}

/** `rel` was checked ignored by the caller; a folder's entries are each checked again (a force-added file is tracked). */
async function copyEntry(state: CopyState, rel: string): Promise<void> {
	const from = path.join(state.root, rel);
	const to = path.join(state.target, rel);
	const stat = await fs.lstat(from).catch(() => null);
	if (!stat) return;
	if (stat.isDirectory()) {
		const entries = (await fs.readdir(from))
			.filter(name => name !== ".git")
			.sort()
			.map(name => path.join(rel, name));
		const ignored = await ignoredAmong(state.root, entries);
		for (const entry of entries) {
			// git names a path with `/` on every platform; `entry` is native.
			if (!ignored.has(entry.replace(/\\/g, "/"))) {
				state.skipped.push({ path: entry, reason: "not_ignored" });
				continue;
			}
			await copyEntry(state, entry);
			if (state.full) return;
		}
		return;
	}
	if (!stat.isFile() && !stat.isSymbolicLink()) return;
	if (await fs.lstat(to).catch(() => null)) {
		state.skipped.push({ path: rel, reason: "exists" });
		return;
	}
	if (!(await destinationInside(state.target, to))) {
		state.skipped.push({ path: rel, reason: "destination_outside" });
		return;
	}
	// A file link on Windows is copied: a symlink there needs Developer Mode or admin. A folder link becomes a
	// junction, which needs neither (pnpm's node_modules are junctions) and takes an absolute target.
	const linkedFolder = stat.isSymbolicLink() && (await fs.stat(from).catch(() => null))?.isDirectory() === true;
	if (stat.isSymbolicLink()) {
		const real = await fs.realpath(from).catch(() => null);
		if (!real || !isInside(state.root, real)) {
			state.skipped.push({ path: rel, reason: "symlink_outside" });
			return;
		}
		if (process.platform !== "win32" || linkedFolder) {
			await fs.mkdir(path.dirname(to), { recursive: true });
			const link = await fs.readlink(from);
			if (process.platform === "win32") await fs.symlink(path.resolve(path.dirname(to), link), to, "junction");
			else await fs.symlink(link, to);
			if (path.isAbsolute(link))
				state.absolute.push({ to, mapped: path.join(state.target, path.relative(state.root, real)) });
			return;
		}
	}
	const overBytes = state.bytes + stat.size > SEED_MAX_BYTES;
	if (state.files + 1 > SEED_MAX_FILES || (state.clone === false && overBytes)) {
		state.skipped.push({ path: rel, reason: "budget" });
		state.full = true;
		return;
	}
	await fs.mkdir(path.dirname(to), { recursive: true });
	if (state.clone === null) {
		// A failed forced clone leaves no file, so the plain copy below starts clean. Over the byte budget the file is
		// copied only if the clone worked: a filesystem that cannot clone would pay for it in disk.
		try {
			await state.copyFile(from, to, fs.constants.COPYFILE_FICLONE_FORCE);
			state.clone = true;
		} catch {
			state.clone = false;
			if (overBytes) {
				state.skipped.push({ path: rel, reason: "budget" });
				state.full = true;
				return;
			}
			await state.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
		}
	} else await state.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
	state.files++;
	state.bytes += stat.size;
}

/**
 * A link written with an absolute path into the main checkout points at the worktree's own copy once one exists (a
 * tracked file, or one this seed copied): the worktree's edits then reach what it links to, never the main checkout's
 * file. A target the worktree has no copy of keeps the main checkout's (`modules -> /repo/store`, a shared store).
 */
async function pointLinksAtWorktree(state: CopyState): Promise<void> {
	for (const { to, mapped } of state.absolute) {
		if (!(await fs.lstat(mapped).catch(() => null))) continue;
		await fs.rm(to, { force: true });
		if (process.platform === "win32") await fs.symlink(mapped, to, "junction");
		else await fs.symlink(path.relative(path.dirname(to), mapped), to);
	}
}

/** Copies the main checkout's `.worktreeinclude` matches into `target`; null when the repo has no such file. */
export async function seedWorktree(
	primary: string,
	target: string,
	deps: { copyFile?: CopyFile } = {},
): Promise<WorktreeSeedReport | null> {
	const root = await fs.realpath(primary);
	const listFile = path.join(root, WORKTREE_INCLUDE_FILE);
	const stat = await fs.stat(listFile).catch(() => null);
	if (!stat?.isFile()) return null;
	const state: CopyState = {
		root,
		target: await fs.realpath(target),
		copyFile: deps.copyFile ?? cloningCopier(),
		clone: null,
		files: 0,
		bytes: 0,
		skipped: [],
		full: false,
		absolute: [],
	};
	if (stat.size > MAX_INCLUDE_BYTES) {
		state.skipped.push({ path: WORKTREE_INCLUDE_FILE, reason: "too_large" });
		return { copied: 0, bytes: 0, cloned: false, skipped: state.skipped };
	}
	const patterns: string[] = [];
	for (const line of (await fs.readFile(listFile, "utf8")).split(/\r?\n/)) {
		const parsed = includePattern(line);
		if (!parsed) continue;
		if ("refused" in parsed) state.skipped.push({ path: line.trim(), reason: parsed.refused });
		else if (patterns.length < MAX_PATTERNS) patterns.push(parsed.pattern);
	}
	// A parent folder that is a symlink would carry the copy outside the checkout (and git refuses such a path).
	const found: string[] = [];
	for (const rel of await candidates(root, patterns)) {
		const realParent = await fs.realpath(path.dirname(path.join(root, rel))).catch(() => null);
		if (!realParent || (realParent !== root && !isInside(root, realParent))) {
			state.skipped.push({ path: rel, reason: "symlink_outside" });
		} else found.push(rel);
	}
	const ignored = await ignoredAmong(root, found);
	for (const rel of found) {
		// git never reports a folder holding a tracked file as ignored; `copyEntry` checks each of its entries instead.
		const folder = (await fs.lstat(path.join(root, rel)).catch(() => null))?.isDirectory() === true;
		if (!folder && !ignored.has(rel)) {
			state.skipped.push({ path: rel, reason: "not_ignored" });
			continue;
		}
		if (state.full) {
			state.skipped.push({ path: rel, reason: "budget" });
			continue;
		}
		try {
			await copyEntry(state, rel);
		} catch (error) {
			state.skipped.push({ path: rel, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	await pointLinksAtWorktree(state);
	return { copied: state.files, bytes: state.bytes, cloned: state.clone === true, skipped: state.skipped };
}

async function hookScript(hook: WorktreeHook, dirs: string[]): Promise<string | null> {
	for (const dir of dirs) {
		const file = path.join(dir, WORKTREE_HOOK_SCRIPTS[hook]);
		if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
	}
	return null;
}

/**
 * Runs the repository's script for `hook` in `where.cwd`; null when there is none (the worktree's own file wins over
 * the main checkout's). The log lands in the worktree's git dir. Never throws.
 */
export async function runWorktreeHook(
	hook: WorktreeHook,
	where: { primary: string; worktree: string; cwd: string; timeoutMs?: number },
): Promise<WorktreeSetupReport | null> {
	const { primary, worktree, cwd, timeoutMs = SETUP_TIMEOUT_MS } = where;
	const script = await hookScript(hook, [worktree, primary]);
	if (!script) return null;
	const gitDir = await gitRaw(worktree, ["rev-parse", "--absolute-git-dir"]);
	const logDir = gitDir.code === 0 ? gitDir.stdout.toString("utf8").trim() : worktree;
	const logPath = path.join(logDir, `ompdesk-worktree-${hook}.log`);
	const windows = process.platform === "win32";
	const spec = windows
		? { file: `"${script}"`, args: [], shell: true }
		: { file: "/bin/sh", args: [script], shell: false };
	const started = Date.now();
	const chunks: Buffer[] = [];
	return new Promise<WorktreeSetupReport>(resolve => {
		let timedOut = false;
		const child = spawnSupervised(
			spec,
			{ ...process.env, OMPDESK_ROOT_PATH: primary, OMPDESK_WORKTREE_PATH: worktree, OMPDESK_HOOK: hook },
			cwd,
		);
		const timer = setTimeout(() => {
			timedOut = true;
			child.stdin?.end();
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
		const finish = async (code: number | null, error?: string) => {
			clearTimeout(timer);
			const output = Buffer.concat(chunks).toString("utf8") + (error ? `${error}\n` : "");
			await fs.writeFile(logPath, output).catch(() => undefined);
			// A timed-out script's own exit code (a trap that exits 0) is never taken as success.
			const exitCode = timedOut || code === SUPERVISOR_STOPPED_CODE ? null : code;
			resolve({
				script: path.relative(path.dirname(path.dirname(script)), script) || script,
				ok: !timedOut && exitCode === 0,
				exitCode,
				timedOut,
				durationMs: Date.now() - started,
				logPath,
				outputTail: output.slice(-SETUP_OUTPUT_TAIL),
			});
		};
		child.on("error", error => void finish(null, error.message));
		child.on("close", code => void finish(code));
	});
}

/** Both steps after a successful `worktree add`; neither ever fails the creation. */
export async function prepareWorktree(
	primary: string,
	target: string,
): Promise<{ seed?: WorktreeSeedReport; setup?: WorktreeSetupReport }> {
	const seed = await seedWorktree(primary, target).catch(
		(error): WorktreeSeedReport => ({
			copied: 0,
			bytes: 0,
			cloned: false,
			skipped: [{ path: WORKTREE_INCLUDE_FILE, reason: error instanceof Error ? error.message : String(error) }],
		}),
	);
	const setup = await runWorktreeHook("setup", { primary, worktree: target, cwd: target });
	return { ...(seed ? { seed } : {}), ...(setup ? { setup } : {}) };
}

/** One line for the agent's `ompdesk_session_open` notes and Autopilot's log, or null when neither step ran. */
export function describePreparation(result: { seed?: WorktreeSeedReport; setup?: WorktreeSetupReport }): string | null {
	const parts: string[] = [];
	if (result.seed) {
		const skipped = result.seed.skipped.length;
		parts.push(
			`.worktreeinclude copied ${result.seed.copied} file(s)${result.seed.cloned ? " (reflink)" : ""}${
				skipped
					? `, skipped ${skipped} (${result.seed.skipped
							.slice(0, 3)
							.map(item => `${item.path}: ${item.reason}`)
							.join("; ")})`
					: ""
			}`,
		);
	}
	if (result.setup) {
		const setup = result.setup;
		parts.push(
			setup.ok
				? `${setup.script} ran (${Math.round(setup.durationMs / 1000)}s)`
				: `${setup.script} ${setup.timedOut ? "timed out" : `failed (exit ${setup.exitCode})`}, log ${setup.logPath}`,
		);
	}
	return parts.length ? parts.join("; ") : null;
}
