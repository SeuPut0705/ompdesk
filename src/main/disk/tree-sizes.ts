/**
 * Disk use of folders measured again every run without reading every file again. The walk runs in the core process
 * (`native/ompdesk/crates/core/src/disk/sizes.rs`): what each directory held directly is kept with the directory's
 * mtime and inode in `file`, and reused while both are unchanged and the mtime is more than 2 s older than the
 * reading that saw it (git's racy rule). A directory's mtime moves whenever an entry is added, removed or renamed in
 * it; only a file rewritten in place keeps its folder's mtime, so a full walk runs at least every
 * `FULL_WALK_EVERY_MS` and bounds that drift. Bytes are allocated blocks where the platform reports them (as `du`),
 * else sizes; a hard-linked file counts once per target; no link is followed.
 *
 * Measured on this Mac's ~/.omp/wt (924,219 files, 77,538 directories): a full walk (du) 17.7 s, a reused one 0.35 s
 * when nothing moved (one lstat per directory, no readdir).
 */

import * as path from "node:path";
import { coreHeld } from "../local/git/exec";

/** A full walk at least this often: bounds what files rewritten in place (no directory change) can leave out. */
export const FULL_WALK_EVERY_MS = 7 * 24 * 60 * 60_000;
/** Reading or writing the kept measurement. */
const READING_TIMEOUT_MS = 60_000;
/** One walk; past it the call fails and the core stops the walk. */
const WALK_TIMEOUT_MS = 60 * 60_000;

/** What one measurement read: how many lstat and readdir calls it made. */
export interface TreeSizesWork {
	lstat: number;
	readdir: number;
}

/**
 * Measures folders and files, reusing what `file` holds from earlier runs. `load()` once, `bytes()` per target,
 * `save()` once: only the targets measured since `load()` are kept. Without `file` (or before `load()`), every
 * `bytes()` is a full walk that keeps nothing.
 */
export class TreeSizes {
	readonly work: TreeSizesWork = { lstat: 0, readdir: 0 };
	readonly #file: string | null;
	readonly #now: () => number;
	/** The core's reading of `file`, from `load()` to `save()`. */
	#reading: number | null = null;
	#reused = false;

	constructor(file: string | null, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
	}

	/**
	 * Opens a reading of the earlier measurement; a missing, unreadable or overdue one, or a core that cannot open it,
	 * makes this run a full walk that keeps nothing.
	 */
	async load(): Promise<void> {
		if (!this.#file) return;
		const opened = await coreHeld<{ reading: number; reused: boolean }>(
			"disk.sizesOpen",
			{ file: this.#file, now: this.#now(), fullWalkEveryMs: FULL_WALK_EVERY_MS },
			READING_TIMEOUT_MS,
		).catch(() => null);
		this.#reading = opened?.reading ?? null;
		this.#reused = opened?.reused ?? false;
	}

	/** Whether `load()` found an earlier measurement to reuse (false: this run reads everything). */
	get reused(): boolean {
		return this.#reused;
	}

	/**
	 * Bytes `target` takes now (0 when it is missing). `reuse: false` reads it in full and keeps nothing: for a folder
	 * whose files grow in place (session journals and logs are appended to), where a directory's mtime says nothing.
	 */
	async bytes(target: string, options: { reuse?: boolean } = {}): Promise<number> {
		const measured = await coreHeld<{ bytes: number; lstat: number; readdir: number }>(
			"disk.sizesBytes",
			{ reading: this.#reading, path: path.resolve(target), reuse: options.reuse !== false },
			WALK_TIMEOUT_MS,
		);
		this.work.lstat += measured.lstat;
		this.work.readdir += measured.readdir;
		return measured.bytes;
	}

	/** Keeps what was measured since `load()` for the next run, and ends the reading. */
	async save(): Promise<void> {
		if (this.#reading === null) return;
		await coreHeld("disk.sizesSave", { reading: this.#reading, now: this.#now() }, READING_TIMEOUT_MS);
		this.#reading = null;
	}
}
