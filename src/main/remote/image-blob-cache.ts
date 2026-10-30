/**
 * The pictures of a paired host's subagent transcripts, kept on this device by their content address.
 *
 * Stock keeps every image of a subagent journal in its blob store as `blob:sha256:<hex>`, and a host used to swap the
 * bytes back into every transcript read (`resolveImageBlobs`), so each replay of a lane or work card, each open of the
 * Subagent view and each read after a store reset or a relaunch carried every picture of the journal again: on 30 Oct
 * 2026 this Mac as host sent one device 92 MB of `get_subagent_transcript` answers in an hour, and the subagent
 * journals of that day were 143 MB deflated read whole, 42 MB without their pictures. A device's `RemoteSidecar` now
 * asks with `imageRefs` and resolves the references here: a blob on disk is read from disk, one it lacks is read
 * from the host once (`read_image_blob`) and kept, so each picture crosses the link once for this device, across
 * tabs, hosts, store resets and relaunches. The bytes are checked against their address before they are kept or
 * shown, so a host can never put another picture under a reference.
 *
 * One cache serves every tab of every host (`RemoteDevices`); concurrent reads of one blob share one request, and
 * nothing else waits on another read. The folder is bounded (`IMAGE_BLOB_CACHE_BYTES`): past it the least recently
 * read blobs go first.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file";
import { BLOB_REF_PREFIX, imageBlobSites } from "../local/image-blobs";

/** The cache folder's bound: a few hundred captures, a day of heavy browser work. */
export const IMAGE_BLOB_CACHE_BYTES = 256 * 1024 * 1024;
/** A trim takes the folder down to this share of the bound, so it does not run again at the next write. */
const TRIM_TO = 0.75;
const HASH = /^[a-f0-9]{64}$/;

/** Reads one blob's base64 bytes from the host; null when the host no longer has it. */
export type BlobFetch = (ref: string) => Promise<string | null>;

export class ImageBlobCache {
	readonly #dir: string;
	readonly #limit: number;
	readonly #loading = new Map<string, Promise<string | null>>();
	/** Bytes in the folder, read once at the first write; null until then. */
	#size: number | null = null;
	#trimming = false;

	constructor(dir: string, limitBytes = IMAGE_BLOB_CACHE_BYTES) {
		this.#dir = dir;
		this.#limit = limitBytes;
	}

	/**
	 * Replaces, in place, every blob reference in `messages` with its base64 bytes: from this device's folder, else
	 * from `fetch` (each blob once, however many reads ask at the same time). A reference whose bytes the host does
	 * not have, or sends wrong, stays as it is: the renderer shows that picture as unavailable.
	 */
	async resolve(messages: unknown, fetch: BlobFetch): Promise<void> {
		const sites = imageBlobSites(messages);
		if (sites.length === 0) return;
		const refs = [...new Set(sites.map(site => site.data))];
		const bytes = new Map(await Promise.all(refs.map(async ref => [ref, await this.#get(ref, fetch)] as const)));
		for (const site of sites) {
			const data = bytes.get(site.data);
			if (data) site.data = data;
		}
	}

	#get(ref: string, fetch: BlobFetch): Promise<string | null> {
		const loading = this.#loading.get(ref);
		if (loading) return loading;
		const load = this.#load(ref.slice(BLOB_REF_PREFIX.length), ref, fetch).finally(() => {
			this.#loading.delete(ref);
		});
		this.#loading.set(ref, load);
		return load;
	}

	async #load(hash: string, ref: string, fetch: BlobFetch): Promise<string | null> {
		if (!HASH.test(hash)) return null;
		const file = path.join(this.#dir, hash);
		try {
			const kept = await readFile(file);
			// Read again: the oldest-read blobs leave first when the folder is full.
			const now = new Date();
			void utimes(file, now, now).catch(() => {});
			return kept.toString("base64");
		} catch {
			// Not kept yet (or unreadable): the host has it.
		}
		let data: string | null;
		try {
			data = await fetch(ref);
		} catch {
			return null;
		}
		if (typeof data !== "string" || data.length === 0) return null;
		const bytes = Buffer.from(data, "base64");
		if (createHash("sha256").update(bytes).digest("hex") !== hash) return null;
		await this.#keep(file, bytes).catch(() => {
			// A full or read-only disk: the picture still shows, and is read from the host again next time.
		});
		return data;
	}

	/** Through the shared atomic writer (Windows retries a held rename): a reader never sees part of a blob. */
	async #keep(file: string, bytes: Buffer): Promise<void> {
		await writeFileAtomic(file, bytes);
		// The first write measures the folder (this blob included); later ones add theirs. A trim measures it again.
		if (this.#size === null) this.#size = await this.#measure();
		else this.#size += bytes.length;
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
	 * Removes the least recently read blobs (and any temporary file left by a crash) until the folder fits again. A
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
