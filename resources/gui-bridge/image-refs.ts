/**
 * A transcript page's pictures as `blob:sha256:` references instead of their bytes. Stock keeps every image of a
 * session in its blob store and swaps the bytes back when it loads the session (session-loader.ts), so the pages
 * `sessions.transcript` slices carry them inline: a session with five generated pictures and eleven read captures
 * was an 18.4 MB tail page (4 Nov 2026), over the 16 MiB a paired device's link carries in one frame, so the device
 * showed "Couldn't load earlier messages" for good. A device asks `imageRefs` and reads each blob once
 * (`read_image_blob`, remote/image-blob-cache.ts), as it does for a subagent's journal; this host's own window keeps
 * reading the bytes.
 *
 * The positions are stock's own (session-persistence.ts `isExternalizableImagePosition`): a `content` image block or
 * an `images[]` entry, wherever it sits (a tool result's `details` too). A picture under the threshold stock keeps
 * inline stays inline. The reference is the content address stock minted at persistence; computing it again stats
 * the blob and writes nothing while it is there. Nothing is changed in place: the replay snapshot's objects are
 * shared with every other reader.
 */
import { type BlobStore, externalizeImageDataSync, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { isExternalizableImagePosition } from "@oh-my-pi/pi-coding-agent/session/session-persistence";

/** Stock's `BLOB_EXTERNALIZE_THRESHOLD` (session-persistence.ts): shorter base64 is never in the store. */
const INLINE_BELOW = 1024;

/** The reference minted for a picture's object: a page is read again at every version, the objects stay. */
const minted = new WeakMap<object, string>();

export function withImageRefs<T>(value: T, store: BlobStore, key?: string): T {
	if (Array.isArray(value)) {
		let copy: unknown[] | null = null;
		value.forEach((item, index) => {
			const replaced = withImageRefs(item, store, key);
			if (replaced === item) return;
			copy ??= [...value];
			copy[index] = replaced;
		});
		return (copy ?? value) as T;
	}
	if (typeof value !== "object" || value === null) return value;
	if (isExternalizableImagePosition(value, key)) {
		const { data } = value;
		if (isBlobRef(data) || data.length < INLINE_BELOW) return value;
		let ref = minted.get(value);
		if (ref === undefined) {
			ref = externalizeImageDataSync(store, data, value.mimeType);
			minted.set(value, ref);
		}
		return { ...value, data: ref };
	}
	let copy: Record<string, unknown> | null = null;
	for (const [childKey, child] of Object.entries(value)) {
		const replaced = withImageRefs(child, store, childKey);
		if (replaced === child) continue;
		copy ??= { ...(value as Record<string, unknown>) };
		copy[childKey] = replaced;
	}
	return (copy ?? value) as T;
}
