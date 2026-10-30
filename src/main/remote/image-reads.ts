/**
 * The pictures a paired host's replies show by path (`fs.readImage`: a markdown `![…](shot.png)`, a tool's file card),
 * kept on this device while they stay the same file.
 *
 * Every mount of such a picture read it whole again (a row scrolled back into view, a transcript re-rendered after a
 * hydration), and on 30 Oct 2026 this Mac as host sent one device 37 MB of `fs.readImage` answers in an hour, the same
 * 1.8 MB pictures two to four times a minute. A read now names the copy this device holds (`known`: its mtime and size)
 * and a host whose file still matches answers `unchanged` with no bytes, so a picture crosses once per change of its
 * file. An older host ignores `known` and sends no `mtimeMs`: its answers are passed on and nothing is kept.
 *
 * One cache for every window and host (`ipc.ts`), keyed by host, workspace and path; reads of one picture at the same
 * time share one request. Bounded by `IMAGE_READS_CHARS` of data URLs, the least recently shown leaving first.
 */
import type { IpcFsReadImageResult } from "../../shared/ipc-types";

/** About 48 MB of pictures: a long session's reply pictures, never a reason to keep a host's whole disk. */
export const IMAGE_READS_CHARS = 64 * 1024 * 1024;

interface Kept {
	result: IpcFsReadImageResult & { dataUrl: string; mtimeMs: number };
	chars: number;
}

export type ImageRead = (known: { mtimeMs: number; size: number } | undefined) => Promise<IpcFsReadImageResult>;

export class RemoteImageReads {
	readonly #limit: number;
	/** In least recently shown order: a hit moves its entry to the end. */
	readonly #kept = new Map<string, Kept>();
	readonly #reading = new Map<string, Promise<IpcFsReadImageResult>>();
	#chars = 0;

	constructor(limitChars = IMAGE_READS_CHARS) {
		this.#limit = limitChars;
	}

	/** The picture at `key` (host, workspace, path) through `read`, sending this device's copy as `known`. */
	read(key: string, read: ImageRead): Promise<IpcFsReadImageResult> {
		const reading = this.#reading.get(key);
		if (reading) return reading;
		const result = this.#read(key, read).finally(() => this.#reading.delete(key));
		this.#reading.set(key, result);
		return result;
	}

	async #read(key: string, read: ImageRead): Promise<IpcFsReadImageResult> {
		const held = this.#kept.get(key);
		const result = await read(held ? { mtimeMs: held.result.mtimeMs, size: held.result.size } : undefined);
		if (held && result.ok && result.unchanged === true) {
			this.#forget(key);
			this.#keep(key, held);
			return held.result;
		}
		this.#forget(key);
		const { dataUrl, mtimeMs } = result;
		if (result.ok && typeof dataUrl === "string" && typeof mtimeMs === "number")
			this.#keep(key, { result: { ...result, dataUrl, mtimeMs }, chars: dataUrl.length });
		return result;
	}

	#keep(key: string, kept: Kept): void {
		if (kept.chars > this.#limit) return;
		this.#kept.set(key, kept);
		this.#chars += kept.chars;
		for (const [oldest] of this.#kept) {
			if (this.#chars <= this.#limit) break;
			this.#forget(oldest);
		}
	}

	#forget(key: string): void {
		const kept = this.#kept.get(key);
		if (!kept) return;
		this.#kept.delete(key);
		this.#chars -= kept.chars;
	}
}
