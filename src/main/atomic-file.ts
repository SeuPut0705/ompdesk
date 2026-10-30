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
 */
export function writeFileAtomicDeferred(
	file: string,
	data: string,
	options: AtomicWriteOptions = {},
	onFailure?: (error: unknown) => void,
): () => void {
	let timer: NodeJS.Timeout | undefined;
	let temp: string | undefined;
	const give = (error: unknown): void => {
		if (temp !== undefined) rmSync(temp, { force: true });
		onFailure?.(error);
	};
	const attempt = (n: number): void => {
		try {
			temp ??= stageSync(file, data, options);
			renameSync(temp, file);
		} catch (error) {
			const wait = temp !== undefined && isRenameBlocked(error) ? RETRY_MS[n] : undefined;
			if (wait === undefined) {
				give(error);
				return;
			}
			timer = setTimeout(() => attempt(n + 1), wait);
			timer.unref();
		}
	};
	attempt(0);
	return () => {
		if (timer === undefined) return;
		clearTimeout(timer);
		timer = undefined;
		if (temp !== undefined) rmSync(temp, { force: true });
	};
}
