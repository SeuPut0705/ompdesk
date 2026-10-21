/**
 * Disk use of folders measured again every run without reading every file again: what each directory held directly
 * (its files' bytes and its child directories) is kept with the directory's mtime and inode, and reused while both are
 * unchanged. A directory's mtime moves whenever an entry is added, removed or renamed in it, which is how installs,
 * builds, git and editors (write to a temp name, rename over) change a tree; only a file rewritten in place keeps its
 * folder's mtime, so a full walk runs at least every `FULL_WALK_EVERY_MS` and bounds that drift.
 *
 * Measured on this Mac's ~/.omp/wt (924,219 files, 77,538 directories): a full walk (du) 17.7 s, this one 0.35 s when
 * nothing moved (one lstat per directory, no readdir).
 */

import * as path from "node:path";
import { existsSync, promises as fs } from "original-fs";
import { writeFileAtomic } from "../atomic-file";

/**
 * One directory as last read: its mtime and inode, the bytes of its direct entries that have one link, those with
 * several (`[device:inode, bytes]`, counted once per measured target, as `du` counts them), and its child dirs.
 */
interface DirNode {
	m: number;
	i: number;
	f: number;
	h?: [string, number][];
	d: Record<string, DirNode>;
}

/** What one directory read holds directly. */
interface DirRead {
	f: number;
	h: [string, number][];
	names: string[];
}

interface SizesFile {
	v: 1;
	/** When the last walk that reused nothing ran (the caller's clock, epoch ms). */
	fullAt: number;
	/** When this reading started (the wall clock, which directory mtimes follow). */
	readAt: number;
	roots: Record<string, DirNode | number>;
}

/** A full walk at least this often: bounds what files rewritten in place (no directory change) can leave out. */
export const FULL_WALK_EVERY_MS = 7 * 24 * 60 * 60_000;
/**
 * A directory is reused only when its mtime is this much older than the reading that saw it: a file system with
 * coarse timestamps (HFS+, FAT, exFAT: 1 to 2 s) can change a directory in the same tick that reading saw (git's
 * "racy" index entries, the same rule).
 */
export const RACY_MS = 2_000;
/** File system calls in flight at once. */
const CONCURRENCY = 16;

/** Bytes an entry takes: allocated blocks where the platform reports them (as `du` does), else its size. */
function entryBytes(stat: { size: number; blocks?: number }): number {
	return typeof stat.blocks === "number" && process.platform !== "win32" ? stat.blocks * 512 : stat.size;
}

class Limiter {
	#active = 0;
	readonly #queue: (() => void)[] = [];

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.#active >= CONCURRENCY) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#queue.push(resolve);
			await promise;
		}
		this.#active++;
		try {
			return await work();
		} finally {
			this.#active--;
			this.#queue.shift()?.();
		}
	}
}

/** What one measurement read: how many lstat and readdir calls it made. */
export interface TreeSizesWork {
	lstat: number;
	readdir: number;
}

/**
 * Measures folders and files, reusing what `file` holds from earlier runs. `load()` once, `bytes()` per target,
 * `save()` once: only the targets measured since `load()` are kept.
 */
export class TreeSizes {
	readonly work: TreeSizesWork = { lstat: 0, readdir: 0 };
	/** Where the measurement is kept between runs; null keeps nothing (every `bytes()` is a full walk). */
	readonly #file: string | null;
	readonly #now: () => number;
	#old: Record<string, DirNode | number> = {};
	#next: Record<string, DirNode | number> = {};
	#fullAt = 0;
	#reusing = false;
	/** When the reading being reused started; when this one did. */
	#readBefore = 0;
	readonly #readAt = Date.now();
	readonly #limit = new Limiter();

	constructor(file: string | null, now: () => number = Date.now) {
		this.#file = file;
		this.#now = now;
	}

	/** Reads the earlier measurement; a missing, unreadable or overdue one makes this run a full walk. */
	async load(): Promise<void> {
		const file = this.#file;
		const text = file && existsSync(file) ? await fs.readFile(file, "utf8").catch(() => null) : null;
		let kept: SizesFile | null = null;
		try {
			kept = text ? (JSON.parse(text) as SizesFile) : null;
		} catch {
			kept = null;
		}
		this.#reusing =
			kept?.v === 1 && typeof kept.readAt === "number" && this.#now() - kept.fullAt < FULL_WALK_EVERY_MS;
		this.#old = this.#reusing && kept ? kept.roots : {};
		this.#fullAt = this.#reusing && kept ? kept.fullAt : 0;
		this.#readBefore = this.#reusing && kept ? kept.readAt : 0;
	}

	/** Whether `load()` found an earlier measurement to reuse (false: this run reads everything). */
	get reused(): boolean {
		return this.#reusing;
	}

	/**
	 * Bytes `target` takes now (0 when it is missing). `reuse: false` reads it in full and keeps nothing: for a folder
	 * whose files grow in place (session journals and logs are appended to), where a directory's mtime says nothing.
	 */
	async bytes(target: string, options: { reuse?: boolean } = {}): Promise<number> {
		const key = path.resolve(target);
		const old = options.reuse === false ? undefined : this.#old[key];
		const { node, bytes } = await this.#measure(key, typeof old === "object" ? old : undefined, new Set());
		if (options.reuse !== false) this.#next[key] = node ?? bytes;
		return bytes;
	}

	/** Keeps what was measured since `load()` for the next run. */
	async save(): Promise<void> {
		if (!this.#file) return;
		const data: SizesFile = {
			v: 1,
			fullAt: this.#reusing ? this.#fullAt : this.#now(),
			readAt: this.#readAt,
			roots: this.#next,
		};
		await writeFileAtomic(this.#file, JSON.stringify(data), { mode: 0o600, dirMode: 0o700 });
	}

	async #measure(
		target: string,
		old: DirNode | undefined,
		linked: Set<string>,
	): Promise<{ node: DirNode | null; bytes: number }> {
		this.work.lstat++;
		const stat = await this.#limit.run(() => fs.lstat(target)).catch(() => null);
		if (!stat) return { node: null, bytes: 0 };
		if (!stat.isDirectory()) return { node: null, bytes: entryBytes(stat) };
		// Unchanged since the last run: no entry was added, removed or renamed here, so its files and children stand.
		// Only when that run read it safely after its last change (`RACY_MS`).
		const same =
			old !== undefined && old.m === stat.mtimeMs && old.i === stat.ino && stat.mtimeMs < this.#readBefore - RACY_MS;
		const read: DirRead = same ? { f: old.f, h: old.h ?? [], names: Object.keys(old.d) } : await this.#read(target);
		const children = await Promise.all(
			read.names.map(name => this.#measure(path.join(target, name), old?.d[name], linked)),
		);
		const node: DirNode = { m: stat.mtimeMs, i: stat.ino, f: read.f, d: {} };
		if (read.h.length > 0) node.h = read.h;
		let bytes = read.f;
		for (const [key, size] of read.h) {
			if (linked.has(key)) continue;
			linked.add(key);
			bytes += size;
		}
		read.names.forEach((name, index) => {
			const child = children[index];
			if (!child) return;
			bytes += child.bytes;
			if (child.node) node.d[name] = child.node;
		});
		return { node, bytes };
	}

	/**
	 * Reads a directory's entries: its files' bytes and its child directories' names (measured by the caller). A file
	 * with several links (Bun installs node_modules as hard links) is kept apart, so it counts once per target.
	 */
	async #read(target: string): Promise<DirRead> {
		this.work.readdir++;
		const items = await this.#limit.run(() => fs.readdir(target, { withFileTypes: true })).catch(() => []);
		const names: string[] = [];
		const h: [string, number][] = [];
		const sizes = await Promise.all(
			items.map(async item => {
				if (item.isDirectory()) {
					names.push(item.name);
					return 0;
				}
				this.work.lstat++;
				const stat = await this.#limit.run(() => fs.lstat(path.join(target, item.name))).catch(() => null);
				if (!stat) return 0;
				if (stat.nlink < 2) return entryBytes(stat);
				h.push([`${stat.dev}:${stat.ino}`, entryBytes(stat)]);
				return 0;
			}),
		);
		return { f: sizes.reduce((sum, size) => sum + size, 0), h, names };
	}
}
