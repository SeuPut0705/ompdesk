/**
 * One persisted picture's bytes from stock's blob store (`blob:sha256:<hex>`), as `read_image_blob` reads it. Its own
 * module because it imports omp: agent-control.ts loads it only when a conversation's picture is such a reference, so
 * the GUI's tests, which run agent-control.ts on a fake `pi`, never need omp.
 */
import { BlobStore, parseBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { getBlobsDir } from "@oh-my-pi/pi-utils";

/** The bytes, or null when the reference is none or the blob is gone. */
export async function readBlob(ref: string): Promise<Buffer | null> {
	const hash = parseBlobRef(ref);
	return hash ? ((await new BlobStore(getBlobsDir()).get(hash)) ?? null) : null;
}
