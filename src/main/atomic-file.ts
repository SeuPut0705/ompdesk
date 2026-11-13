/**
 * Every file the app replaces in one step goes through here: written to a sibling temp file, then renamed over the
 * target, so a crash never leaves half a file. Windows refuses that rename (EPERM, sometimes EACCES or EBUSY) while
 * any process has the target open: a virus scan, a backup, an indexer, a poll. A save that gives up then loses the
 * write for good when nothing writes the file again, so a refused rename is tried again on a backoff before it is
 * an error. Electron-free.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { diskFull, isDiskFull } from "./disk-full";

export interface AtomicWriteOptions {
	/** The file's mode, pinned after the write (the creation mode is masked by the umask). */
	mode?: number;
	/** The mode of the folder when it has to be made. */
	dirMode?: number;
}

/** Waits of the blocking variant: the caller needs the file now, so the whole wait stays under a second. */
const SYNC_RETRY_MS: readonly number[] = [10, 20, 40, 80, 160, 320];
/** Waits of the variants that do not block: 20 ms doubling, about 5 s in all. */
const RETRY_MS: readonly number[] = [20, 40, 80, 160, 320, 640, 1_280, 2_560];
/** Waits of a write that found the disk full: 5 s doubling up to a minute, for as long as the disk stays full. */
export const DISK_FULL_RETRY_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];

let counter = 0;
const tempFor = (file: string): string => `${file}.${process.pid}-${counter++}.tmp`;

/** The rename a held target makes fail: Windows only (elsewhere EPERM is a real refusal, and retrying cannot help). */
export function isRenameBlocked(error: unknown): boolean {
	if (process.platform !== "win32" || !(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function stageSync(file: string, data: string, options: AtomicWriteOptions): string {
	mkdirSync(dirname(file), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) });
	const temp = tempFor(file);
	try {
		writeFileSync(temp, data, options.mode === undefined ? undefined : { mode: options.mode });
		if (options.mode !== undefined) chmodSync(temp, options.mode);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return temp;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Replaces `file` with `data` and returns when it is there. A refused rename blocks the caller for at most ~0.6 s. */
export function writeFileAtomicSync(file: string, data: string, options: AtomicWriteOptions = {}): void {
	const temp = stageSync(file, data, options);
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(temp, file);
				return;
			} catch (error) {
				const wait = SYNC_RETRY_MS[attempt];
				if (wait === undefined || !isRenameBlocked(error)) throw error;
				Atomics.wait(sleepCell, 0, 0, wait);
			}
		}
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export interface AsyncAtomicWriteOptions extends AtomicWriteOptions {
	/**
	 * Asked right before every rename, which then runs in the same tick: false drops the write. A writer that a
	 * synchronous final save overtakes (a quit) must not land afterwards.
	 */
	commitIf?: () => boolean;
}

/** Replaces `file` with `data`; a refused rename is tried again for about 5 s without blocking. Resolves once it is there (or dropped by `commitIf`). */
export async function writeFileAtomic(
	file: string,
	data: string | Uint8Array,
	options: AsyncAtomicWriteOptions = {},
): Promise<void> {
	await mkdir(dirname(file), { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) });
	const temp = tempFor(file);
	try {
		await writeFile(temp, data, options.mode === undefined ? undefined : { mode: options.mode });
		if (options.mode !== undefined) await chmod(temp, options.mode);
		for (let attempt = 0; ; attempt++) {
			if (options.commitIf && !options.commitIf()) {
				await rm(temp, { force: true });
				return;
			}
			try {
				await rename(temp, file);
				return;
			} catch (error) {
				const wait = RETRY_MS[attempt];
				if (wait === undefined || !isRenameBlocked(error)) throw error;
				await sleep(wait);
			}
		}
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * For a writer that must not block and has nobody to throw to (it runs on every state change): one attempt now, and
 * a refused rename again on a timer for about 5 s. `onFailure` hears of a write that never went through. Returns
 * the call-off of a write a newer one replaces.
 *
 * A full disk (ENOSPC, EDQUOT) is no failure: the temp file goes, the target keeps its old bytes, `diskFull` names
 * the file (the person's one notice, `disk-full-notice.ts`) and the same content is tried again on a backoff for as
 * long as the disk stays full, until a newer write or the call-off replaces it. Nothing is thrown into the caller's
 * event loop on the way.
 */
export function writeFileAtomicDeferred(
	file: string,
	data: string,
	options: AtomicWriteOptions = {},
	onFailure?: (error: unknown) => void,
): () => void {
	let timer: NodeJS.Timeout | undefined;
	let temp: string | undefined;
	let fullTries = 0;
	const dropTemp = (): void => {
		if (temp !== undefined) rmSync(temp, { force: true });
		temp = undefined;
	};
	const wait = (ms: number, next: () => void): void => {
		timer = setTimeout(() => {
			timer = undefined;
			next();
		}, ms);
		timer.unref();
	};
	const attempt = (n: number): void => {
		try {
			temp ??= stageSync(file, data, options);
			renameSync(temp, file);
		} catch (error) {
			if (isDiskFull(error)) {
				dropTemp();
				diskFull.report(file);
				const delay = DISK_FULL_RETRY_MS[Math.min(fullTries++, DISK_FULL_RETRY_MS.length - 1)] ?? 60_000;
				wait(delay, () => attempt(n));
				return;
			}
			const retryIn = temp !== undefined && isRenameBlocked(error) ? RETRY_MS[n] : undefined;
			if (retryIn === undefined) {
				dropTemp();
				diskFull.clear(file);
				onFailure?.(error);
				return;
			}
			wait(retryIn, () => attempt(n + 1));
			return;
		}
		diskFull.clear(file);
	};
	attempt(0);
	return () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
		dropTemp();
		diskFull.clear(file);
	};
}

/**
 * One file's writer for state that lives in memory and is saved on every change: each `save` replaces the one before
 * it (a newer snapshot always wins, a retry of an older one never lands over it) and never throws, a full disk
 * included (`writeFileAtomicDeferred`). With no file (a store kept in memory) every call does nothing.
 */
export class AtomicSaver {
	readonly #file: string | null;
	readonly #options: AtomicWriteOptions;
	readonly #onFailure: ((error: unknown) => void) | undefined;
	#callOff: (() => void) | undefined;

	constructor(file: string | null, options: AtomicWriteOptions = {}, onFailure?: (error: unknown) => void) {
		this.#file = file;
		this.#options = options;
		this.#onFailure = onFailure;
	}

	save(data: string): void {
		if (this.#file === null) return;
		this.#callOff?.();
		this.#callOff = writeFileAtomicDeferred(this.#file, data, this.#options, this.#onFailure);
	}
}
