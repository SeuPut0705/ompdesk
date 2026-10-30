/**
 * `get_git_fingerprint` (the Changes panel's 3 s check: every window's, every tab's, a paired device's served here)
 * answered from one watch per checkout folder for the whole app. Each open list used to run a `git status` every
 * 3 s whether or not anything moved; now the first ask of a folder starts a recursive `fs.watch` on its worktree and
 * its git directories, and later asks are answered from memory while no event came since the last read. Any event
 * there (an edit, a save, an index or HEAD or ref or stash write, ignored folders included) makes the next ask read git
 * again, so a change is seen by the very next check as before. Concurrent asks of one folder share one read.
 *
 * Where a watch cannot be trusted the ask reads git every time, as before: outside macOS and Windows (Linux's
 * recursive watch walks the whole tree), outside a repository (a repository made above the folder sends no event
 * here), or after a watcher error. An answer older than `FINGERPRINT_MAX_AGE_MS` is read again even with no event (a
 * volume whose changes the OS does not report, an event the OS dropped). A folder nobody asked about for
 * `FINGERPRINT_IDLE_MS` (its panels closed or hidden) is no longer watched.
 */
import { type FSWatcher, watch } from "node:fs";
import * as path from "node:path";
import type { RpcGitFingerprint } from "../shared/rpc-types";
import { getGitFingerprint } from "./local/git/changes";
import { gitRaw } from "./local/git/exec";
import { isInside } from "./local/git/parse";

/** An answer older than this is read again even with no event: the safety net for a change the OS did not report. */
export const FINGERPRINT_MAX_AGE_MS = 30_000;
/** A folder nobody asked about for this long stops being watched (the panel asks every 3 s while it shows). */
export const FINGERPRINT_IDLE_MS = 15_000;

export interface GitFingerprintDeps {
	/** One fingerprint read (`getGitFingerprint`). */
	read: (cwd: string, knownRoot?: string) => Promise<RpcGitFingerprint>;
	/** The worktree root and git directories of `cwd`, or null outside a repository. */
	locate: (cwd: string) => Promise<string[] | null>;
	/** A recursive watch of `dir` calling `changed` on any event; throws where the platform has none. */
	watch: (dir: string, changed: () => void, failed: () => void) => { close(): void };
	now?: () => number;
	/** Whether watches are trusted here (macOS and Windows). */
	watches?: boolean;
}

interface Entry {
	/** Settles once the watches are up (or known not to be): no answer is kept from a read that began before. */
	ready: Promise<void>;
	watching: boolean;
	root: string | undefined;
	watchers: Array<{ close(): void }>;
	/** Bumped by every event: an answer is kept only when no event came while it was read. */
	generation: number;
	cached: { generation: number; at: number; value: RpcGitFingerprint } | null;
	reading: { generation: number; promise: Promise<RpcGitFingerprint> } | null;
	idle: NodeJS.Timeout;
}

export class GitFingerprints {
	readonly #entries = new Map<string, Entry>();
	readonly #deps: GitFingerprintDeps;
	readonly #now: () => number;
	readonly #watches: boolean;

	constructor(deps: GitFingerprintDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#watches = deps.watches ?? (process.platform === "darwin" || process.platform === "win32");
	}

	/** `cwd`'s fingerprint: from memory while nothing under the checkout moved since the last read, else read now. */
	async read(cwd: string, knownRoot?: string): Promise<RpcGitFingerprint> {
		if (!this.#watches) return this.#deps.read(cwd, knownRoot);
		const key = path.resolve(cwd);
		const entry = this.#entries.get(key) ?? this.#open(key);
		entry.idle.refresh();
		await entry.ready;
		if (!entry.watching) return this.#deps.read(cwd, knownRoot);
		const { cached } = entry;
		if (cached && cached.generation === entry.generation && this.#now() - cached.at < FINGERPRINT_MAX_AGE_MS)
			return cached.value;
		if (entry.reading?.generation === entry.generation) return entry.reading.promise;
		const generation = entry.generation;
		const promise = this.#deps.read(cwd, knownRoot ?? entry.root).then(value => {
			if (entry.generation === generation) entry.cached = { generation, at: this.#now(), value };
			return value;
		});
		entry.reading = { generation, promise };
		void promise
			.finally(() => {
				if (entry.reading?.promise === promise) entry.reading = null;
			})
			.catch(() => {});
		return promise;
	}

	/** Stop every watch (app quit). */
	dispose(): void {
		for (const [key, entry] of this.#entries) this.#close(key, entry);
	}

	#open(key: string): Entry {
		const entry: Entry = {
			ready: Promise.resolve(),
			watching: false,
			root: undefined,
			watchers: [],
			generation: 0,
			cached: null,
			reading: null,
			idle: setTimeout(() => this.#close(key, entry), FINGERPRINT_IDLE_MS),
		};
		entry.idle.unref?.();
		this.#entries.set(key, entry);
		entry.ready = this.#watch(key, entry);
		return entry;
	}

	async #watch(key: string, entry: Entry): Promise<void> {
		const dirs = await this.#deps.locate(key).catch(() => null);
		if (!dirs || this.#entries.get(key) !== entry) return;
		const changed = () => {
			entry.generation += 1;
		};
		const failed = () => {
			// A watch that broke cannot say what moved: every ask reads git again until the folder is watched anew.
			for (const watcher of entry.watchers) watcher.close();
			entry.watchers = [];
			entry.watching = false;
			entry.cached = null;
		};
		// The worktree holds a primary checkout's .git; a linked worktree's git directories live in the main one.
		const roots = dirs.filter(
			(dir, index) => !dirs.some((other, at) => at < index && (other === dir || isInside(other, dir))),
		);
		try {
			for (const dir of roots) entry.watchers.push(this.#deps.watch(dir, changed, failed));
		} catch {
			failed();
			return;
		}
		entry.root = dirs[0];
		entry.watching = true;
	}

	#close(key: string, entry: Entry): void {
		clearTimeout(entry.idle);
		for (const watcher of entry.watchers) watcher.close();
		entry.watchers = [];
		entry.watching = false;
		if (this.#entries.get(key) === entry) this.#entries.delete(key);
	}
}

/** The worktree root, git directory and common git directory of `cwd`, absolute; null outside a repository. */
async function locateCheckout(cwd: string): Promise<string[] | null> {
	const result = await gitRaw(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
		"--absolute-git-dir",
		"--git-common-dir",
	]);
	if (result.code !== 0) return null;
	const dirs = result.stdout
		.toString("utf8")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(dir => path.resolve(dir));
	return dirs.length === 3 ? dirs : null;
}

function watchTree(dir: string, changed: () => void, failed: () => void): FSWatcher {
	const watcher = watch(dir, { recursive: true, persistent: false }, changed);
	watcher.on("error", failed);
	return watcher;
}

/** The app's one set of checkout watches, answering every tab's `get_git_fingerprint`. */
export const gitFingerprints = new GitFingerprints({
	read: getGitFingerprint,
	locate: locateCheckout,
	watch: watchTree,
});
