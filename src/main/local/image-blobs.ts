/**
 * Image bytes for subagent transcripts. Stock persists every image payload of a
 * session journal as a `blob:sha256:<hex>` reference into its blob store
 * (session-persistence.ts) and swaps the bytes back only when it loads a
 * session itself (session-loader.ts `resolveBlobRefsInEntries`). A subagent
 * transcript is parsed straight from its JSONL — stock `get_subagent_messages`
 * and the bridge's `get_subagent_transcript` alike — so its read screenshots,
 * browser captures and generated pictures arrive as references a renderer
 * cannot draw. The tab's bridge reads each blob where the store lives (a remote
 * tab's host); a reference whose blob is gone stays as it is, and the renderer
 * shows that image as unavailable. A paired device asks for the references
 * instead (`imageRefs`) and reads each blob once (remote/image-blob-cache.ts).
 */
import type { BridgeClient } from "./types";

export const BLOB_REF_PREFIX = "blob:sha256:";
const BLOB_REF = /^blob:sha256:[a-f0-9]{64}$/;

/** One place in a transcript whose `data` holds stock's blob reference for an image's bytes. */
export interface ImagePayload {
	data: string;
}

/** Stock's externalized positions: a `content` image block or an `images[]` entry. */
function isImagePosition(record: Record<string, unknown>, key: string | undefined): boolean {
	if (key === "content") return record.type === "image";
	return (
		key === "images" &&
		(record.type === "image" || (typeof record.mimeType === "string" && record.mimeType.startsWith("image/")))
	);
}

function collectBlobRefs(value: unknown, sites: ImagePayload[], key?: string): void {
	if (Array.isArray(value)) {
		for (const item of value) collectBlobRefs(item, sites, key);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	if (typeof record.data === "string" && BLOB_REF.test(record.data) && isImagePosition(record, key)) {
		sites.push(record as unknown as ImagePayload);
		return;
	}
	for (const [childKey, child] of Object.entries(record)) collectBlobRefs(child, sites, childKey);
}

/** Every image whose bytes stock left as a blob reference inside `messages`, in order (a reference may repeat). */
export function imageBlobSites(messages: unknown): ImagePayload[] {
	const sites: ImagePayload[] = [];
	collectBlobRefs(messages, sites);
	return sites;
}

/** Replace, in place, every image blob reference inside `messages` with its base64 bytes. */
export async function resolveImageBlobs(messages: unknown, bridge: BridgeClient): Promise<void> {
	const sites = imageBlobSites(messages);
	const bytes = new Map<string, string | null>();
	// One blob per bridge reply, in turn: the bridge socket answers in order, so a
	// single multi-image reply would hold every other bridge request behind it.
	for (const site of sites) {
		const ref = site.data;
		let data = bytes.get(ref);
		if (data === undefined) {
			try {
				data = (await bridge.request<{ data: string | null }>("read_image_blob", { ref })).data;
			} catch {
				// The transcript itself is intact; this one picture shows as unavailable.
				data = null;
			}
			bytes.set(ref, data);
		}
		if (data !== null) site.data = data;
	}
}
