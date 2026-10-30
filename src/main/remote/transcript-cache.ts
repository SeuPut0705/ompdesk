/**
 * What a paired device read of its hosts' transcripts, kept on its disk so each read crosses the link once per change.
 *
 * A device's renderer holds a tab's subagent transcripts and tail page in memory only, so every relaunch, window reload
 * and session switch (the tab's subagent store starts over) read every replayed agent's journal whole again, and every
 * relaunch the tail page of every open session: on 30 Oct 2026 the subagent journals of a day were 42 MB deflated read
 * once, and a relaunch read them again. `RemoteSidecar` now answers those reads from here and asks the host only for
 * what follows:
 *
 * - A subagent journal (`get_subagent_messages`, `get_subagent_transcript`) is kept as the segments the host answered,
 *   each from the byte offset the last ended at, with the journal's `tail` there (a hash of the bytes before the
 *   offset, `journalTail` in local/extensions.ts). A read from the start, or from where this device stopped, asks the
 *   host from the kept offset with that tail; a host whose journal no longer has it reads it from the start again
 *   (`reset`), and the kept copy is replaced. An unchanged journal costs one small request.
 * - A tail page (`get_transcript_page` from the end) is kept with its `version`; a fresh reader's read asks the host
 *   `ifVersion` and an unchanged transcript costs one small request.
 *
 * Keyed by the caller (`RemoteSidecar`: host, the tab's session file, the agent or the page's limit). One read of a
 * key at a time, so two windows on one tab never append the same segment twice. The folder is bounded
 * (`TRANSCRIPT_CACHE_BYTES`): past it the least recently read go first. A file that cannot be read whole (a crash
 * mid-append) is dropped and read from the host again; nothing here is ever authoritative.
 */
import { createHash } from "node:crypto";
import { appendFile, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { RpcResponse } from "../../shared/rpc-types";
import { writeFileAtomic } from "../atomic-file";

/** The folder's bound: a few weeks of a heavy user's subagents without their pictures (those are `ImageBlobCache`'s). */
export const TRANSCRIPT_CACHE_BYTES = 128 * 1024 * 1024;
/** A trim takes the folder down to this share of the bound, so it does not run again at the next write. */
const TRIM_TO = 0.75;

/** A journal read's answer, as stock and the gui-bridge send it (`readRpcSubagentTranscript`), with the host's tail. */
interface JournalRead {
	sessionFile?: string;
	fromByte: number;
	nextByte: number;
	reset?: boolean;
	messages: unknown[];
	tail?: string;
}

/** One answer the host gave, as kept: where it started and ended, the tail there, its messages. */
interface Segment {
	from: number;
	next: number;
	tail: string;
	messages: unknown[];
}

/** Asks the host for the journal from `fromByte`; `knownTail` is the tail this device kept there. */
export type JournalFetch = (fromByte: number, knownTail?: string) => Promise<RpcResponse>;

function journalRead(data: unknown): JournalRead | null {
	if (typeof data !== "object" || data === null) return null;
	const read = data as Partial<JournalRead>;
	return typeof read.fromByte === "number" && typeof read.nextByte === "number" && Array.isArray(read.messages)
		? (read as JournalRead)
		: null;
}

function isSegment(value: unknown): value is Segment {
	if (typeof value !== "object" || value === null) return false;
	const segment = value as Partial<Segment>;
	return (
		typeof segment.from === "number" &&
		typeof segment.next === "number" &&
		typeof segment.tail === "string" &&
		Array.isArray(segment.messages)
	);
}

export class TranscriptCache {
	readonly #dir: string;
	readonly #limit: number;
	/** The read of each key in progress: the next waits for it. */
	readonly #busy = new Map<string, Promise<unknown>>();
	/** Bytes in the folder, measured at the first write; null until then. */
	#size: number | null = null;
	#trimming = false;

	constructor(dir: string, limitBytes = TRANSCRIPT_CACHE_BYTES) {
		this.#dir = dir;
		this.#limit = limitBytes;
	}

	/**
	 * A journal read from `fromByte` as the renderer asked it: from the start, the messages this device kept and what
	 * the host added since; from where this device stopped, what the host added. Any other offset (a renderer ahead of
	 * a trimmed copy) goes to the host as asked. The answer is the host's own when it started over or failed.
	 */
	readJournal(key: string, fromByte: number, fetch: JournalFetch): Promise<RpcResponse> {
		return this.#serialized(key, async () => {
			const file = this.#file("j", key);
			const held = await this.#loadJournal(file);
			if (!held || (fromByte !== 0 && fromByte !== held.next)) {
				const response = await fetch(fromByte);
				const read = response.success ? journalRead(response.data) : null;
				// Only a whole journal read from its start, with a tail to check it by, is kept.
				if (read && read.fromByte === 0 && read.tail !== undefined)
					await this.#rewrite(file, [{ from: 0, next: read.nextByte, tail: read.tail, messages: read.messages }]);
				return response;
			}
			const response = await fetch(held.next, held.tail);
			const read = response.success ? journalRead(response.data) : null;
			if (!read) return response;
			if (read.reset === true || read.fromByte !== held.next || read.tail === undefined) {
				// The host's journal is not the one kept (rewritten, or a host that does not check): kept anew from it.
				if (read.fromByte === 0 && read.tail !== undefined)
					await this.#rewrite(file, [{ from: 0, next: read.nextByte, tail: read.tail, messages: read.messages }]);
				else await this.#drop(file);
				return response;
			}
			if (read.nextByte !== held.next)
				await this.#append(file, {
					from: held.next,
					next: read.nextByte,
					tail: read.tail,
					messages: read.messages,
				});
			else void this.#touch(file);
			if (fromByte !== 0) return response;
			return {
				...response,
				data: { ...read, fromByte: 0, reset: false, messages: [...held.messages, ...read.messages] },
			};
		});
	}

	/** The tail page kept for `key`, with the version it was read at. */
	async page(key: string): Promise<{ version: string; page: object } | null> {
		const file = this.#file("p", key);
		try {
			const kept = JSON.parse(await readFile(file, "utf8")) as { version?: unknown; page?: unknown };
			if (typeof kept.version !== "string" || typeof kept.page !== "object" || kept.page === null) return null;
			void this.#touch(file);
			return { version: kept.version, page: kept.page };
		} catch {
			return null;
		}
	}

	/** Keeps the tail page read at `version` for `key`, replacing the last. */
	keepPage(key: string, version: string, page: object): Promise<void> {
		return this.#serialized(`p\0${key}`, () => this.#write(this.#file("p", key), JSON.stringify({ version, page })));
	}

	#serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
		const before = this.#busy.get(key) ?? Promise.resolve();
		const result = before.then(run, run);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#busy.set(key, settled);
		void settled.then(() => {
			if (this.#busy.get(key) === settled) this.#busy.delete(key);
		});
		return result;
	}

	#file(kind: "j" | "p", key: string): string {
		return path.join(this.#dir, `${kind}-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`);
	}

	/** The journal kept in `file`: its segments in order from byte 0, each starting where the last ended. */
	async #loadJournal(file: string): Promise<{ next: number; tail: string; messages: unknown[] } | null> {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			return null;
		}
		const messages: unknown[] = [];
		let next = 0;
		let tail: string | null = null;
		for (const line of text.split("\n")) {
			if (!line) continue;
			let segment: unknown;
			try {
				segment = JSON.parse(line);
			} catch {
				segment = null;
			}
			if (!isSegment(segment) || segment.from !== next) {
				await this.#drop(file);
				return null;
			}
			for (const message of segment.messages) messages.push(message);
			next = segment.next;
			tail = segment.tail;
		}
		if (tail === null) return null;
		void this.#touch(file);
		return { next, tail, messages };
	}

	async #rewrite(file: string, segments: Segment[]): Promise<void> {
		await this.#write(file, segments.map(segment => `${JSON.stringify(segment)}\n`).join(""));
	}

	/** Through the shared atomic writer (Windows retries a held rename): a reader never sees part of a file. */
	async #write(file: string, text: string): Promise<void> {
		try {
			await writeFileAtomic(file, text);
			await this.#grew(Buffer.byteLength(text));
		} catch {
			// A full or read-only disk: the transcript still shows, and is read from the host again next time.
		}
	}

	/** One more segment at the end: a crash mid-append leaves a line the next load refuses, dropping the file. */
	async #append(file: string, segment: Segment): Promise<void> {
		const line = `${JSON.stringify(segment)}\n`;
		try {
			await appendFile(file, line);
			await this.#grew(Buffer.byteLength(line));
		} catch {
			await this.#drop(file);
		}
	}

	async #drop(file: string): Promise<void> {
		await rm(file, { force: true }).catch(() => {});
	}

	/** Read again: the least recently read go first when the folder is full. */
	async #touch(file: string): Promise<void> {
		const now = new Date();
		await utimes(file, now, now).catch(() => {});
	}

	async #grew(bytes: number): Promise<void> {
		// The first write measures the folder (this one included); later ones add theirs. A trim measures it again.
		if (this.#size === null) this.#size = await this.#measure();
		else this.#size += bytes;
		if (this.#size > this.#limit) void this.#trim();
	}

	async #measure(): Promise<number> {
		let total = 0;
		for (const entry of await this.#entries()) total += entry.size;
		return total;
	}

	async #entries(): Promise<Array<{ file: string; size: number; read: number }>> {
		const names = await readdir(this.#dir).catch(() => [] as string[]);
		const entries = await Promise.all(
			names.map(async name => {
				const file = path.join(this.#dir, name);
				const info = await stat(file).catch(() => null);
				return info?.isFile() ? [{ file, size: info.size, read: info.mtimeMs }] : [];
			}),
		);
		return entries.flat();
	}

	/**
	 * Removes the least recently read files (and any temporary file left by a crash) until the folder fits again. A
	 * file it cannot remove (Windows: one being read) stays and counts; nothing here ever rejects.
	 */
	async #trim(): Promise<void> {
		if (this.#trimming) return;
		this.#trimming = true;
		try {
			const entries = (await this.#entries()).sort((a, b) => a.read - b.read);
			let total = entries.reduce((sum, entry) => sum + entry.size, 0);
			for (const entry of entries) {
				if (total <= this.#limit * TRIM_TO) break;
				const removed = await rm(entry.file, { force: true }).then(
					() => true,
					() => false,
				);
				if (removed) total -= entry.size;
			}
			this.#size = total;
		} finally {
			this.#trimming = false;
		}
	}
}
