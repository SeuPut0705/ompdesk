/**
 * The pictures of a paired host's subagent transcripts, kept on this device by their content address.
 *
 * Stock keeps every image of a subagent journal in its blob store as `blob:sha256:<hex>`, and a host used to swap the
 * bytes back into every transcript read, so each replay of a lane or work card, each open of the Subagent view and each
 * read after a store reset or a relaunch carried every picture of the journal again: on 30 Oct 2026 this Mac as host
 * sent one device 92 MB of `get_subagent_transcript` answers in an hour. A device's `RemoteSidecar` now asks with
 * `imageRefs` and resolves the references here, so each picture crosses the link once for this device, across tabs,
 * hosts, store resets and relaunches. The folder, the check of the bytes against their address, the shared reads of
 * one blob and the bound `IMAGE_BLOB_CACHE_BYTES` are the core's (`remotebytes/blobs.rs`); the host is asked here.
 */
import { imageBlobSites } from "../local/image-blobs";
import { askingCall } from "./bytes-asks";

/** The cache folder's bound: a few hundred captures, a day of heavy browser work. */
export const IMAGE_BLOB_CACHE_BYTES = 256 * 1024 * 1024;

/** Reads one blob's base64 bytes from the host; null when the host no longer has it. */
export type BlobFetch = (ref: string) => Promise<string | null>;

export class ImageBlobCache {
	readonly #dir: string;
	readonly #limit: number;

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
		let found: Array<string | null>;
		try {
			found = await askingCall<Array<string | null>>(
				"remotebytes.resolveBlobs",
				{ dir: this.#dir, limit: this.#limit, refs },
				ask => fetch(String(ask.ref)).catch(() => null),
			);
		} catch {
			return;
		}
		const bytes = new Map(refs.map((ref, index) => [ref, found[index]]));
		for (const site of sites) {
			const data = bytes.get(site.data);
			if (data) site.data = data;
		}
	}
}
