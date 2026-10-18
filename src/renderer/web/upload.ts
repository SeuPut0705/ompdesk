/**
 * `window.omp.fs.pathForFile` for a phone: the browser has no local path for a picked or dropped file, so the
 * file goes to the host (`POST /upload`, multipart field `file`, 25 MB each) and the answer is the path it has
 * there, which the composer mentions like any local file. A file the host refuses or the network loses rejects
 * with `UploadFailed` (the shim words it), and the composer says the file was not sent.
 *
 * The pictures a call carries (a prompt's attached photos) take the same road: `liftInlineImages` uploads each
 * image block's bytes and leaves a `WebUploadedImage` in its place, since a frame on the socket may hold 1 MB and
 * one phone photo is often more; the host reads them back before the call runs.
 */
import { holdsBlock, replaceBlocks, type WebUploadedImage } from "../../shared/web-protocol";
import { trackFilePick } from "../lib/file-pick";
import { base64ToBytes } from "./download";
import type { FetchLike } from "./session";

/** The host's per-file limit (design §5.4). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type UploadFailure = "too-large" | "refused" | "network";

export interface UploadDeps {
	fetch: FetchLike;
	base?: string;
}

let inFlight = 0;

/** Uploads on their way to the computer right now: a page reload would cut them (see `SafeMoment`). */
export function uploadsInFlight(): number {
	return inFlight;
}

/** POST `file` to the host; its host path. Throws on any failure. */
export async function uploadFile(file: File, deps: UploadDeps): Promise<string> {
	const body = new FormData();
	body.append("file", file, file.name);
	const response = await deps.fetch(`${deps.base ?? ""}/upload`, { method: "POST", body, credentials: "same-origin" });
	if (!response.ok) throw new UploadRefused(response.status);
	const reply: unknown = await response.json();
	if (typeof reply === "object" && reply !== null && "path" in reply && typeof reply.path === "string" && reply.path) {
		return reply.path;
	}
	throw new UploadRefused(response.status);
}

class UploadRefused extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`The computer refused the upload (${status})`);
		this.status = status;
	}
}

/** An upload that did not land: why, and the host's status for a refusal. */
export class UploadFailed extends Error {
	readonly failure: UploadFailure;
	readonly status: number | undefined;
	constructor(failure: UploadFailure, status?: number) {
		super(`Upload failed (${failure}${status === undefined ? "" : ` ${status}`})`);
		this.failure = failure;
		this.status = status;
	}
}

/** `uploadFile` within the size limit, counted in {@link uploadsInFlight}; throws `UploadFailed`. */
async function sendUpload(file: File, deps: UploadDeps): Promise<string> {
	if (file.size > UPLOAD_MAX_BYTES) throw new UploadFailed("too-large");
	inFlight++;
	try {
		return await uploadFile(file, deps);
	} catch (error) {
		throw error instanceof UploadRefused ? new UploadFailed("refused", error.status) : new UploadFailed("network");
	} finally {
		inFlight--;
	}
}

/**
 * A `pathForFile` that uploads each distinct `File` once and keeps the answer: the composer asks again for the
 * same file (paste then send), and a second upload would leave a second copy on the host. A failed upload rejects
 * with `UploadFailed` and is tried again next time.
 */
export function createPathForFile(deps: UploadDeps): (file: File) => Promise<string> {
	const known = new WeakMap<File, Promise<string>>();
	return file => {
		const cached = known.get(file);
		if (cached) return cached;
		const result = sendUpload(file, deps);
		known.set(file, result);
		result.catch(() => known.delete(file));
		return result;
	};
}

/** An image block with its bytes inline (`ImageContent`: base64 `data` and its `mimeType`). */
interface InlineImage {
	type: "image";
	data: string;
	mimeType: string;
}

function isInlineImage(value: unknown): value is InlineImage {
	if (typeof value !== "object" || value === null) return false;
	const block = value as Record<string, unknown>;
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

/** Whether a call's arguments carry an image block with inline bytes anywhere. */
export function holdsInlineImage(args: readonly unknown[]): boolean {
	return holdsBlock(args, isInlineImage);
}

/** A file name for an upload of `mimeType` bytes (`image/jpeg` → `image.jpeg`). */
function imageFileName(mimeType: string): string {
	const subtype = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType)?.[1]?.replace(/\+.*$/, "");
	return subtype ? `image.${subtype.toLowerCase()}` : "image";
}

/**
 * `args` with every inline image block's bytes uploaded to the host and the block replaced by a
 * `WebUploadedImage` naming the host's copy; everything else is kept. Rejects with the first `UploadFailed`.
 */
export async function liftInlineImages(args: readonly unknown[], deps: UploadDeps): Promise<unknown[]> {
	const lifted = await replaceBlocks(args, isInlineImage, async ({ data, ...block }): Promise<WebUploadedImage> => {
		const file = new File([base64ToBytes(data) as Uint8Array<ArrayBuffer>], imageFileName(block.mimeType), {
			type: block.mimeType,
		});
		return { ...block, upload: await sendUpload(file, deps) };
	});
	return lifted as unknown[];
}

/**
 * Pick files on the phone with a file input; empty when the picker was cancelled. The pick is tracked
 * (lib/file-pick.ts) until it resolves, so the page is not reloaded under it.
 */
export function pickFiles(
	accept: string | undefined,
	doc: Pick<Document, "createElement"> = document,
): Promise<File[]> {
	const { promise, resolve } = Promise.withResolvers<File[]>();
	const input = doc.createElement("input");
	input.type = "file";
	input.multiple = true;
	if (accept) input.accept = accept;
	const done = trackFilePick(input);
	input.addEventListener("change", () => {
		done();
		resolve(Array.from(input.files ?? []));
	});
	input.addEventListener("cancel", () => resolve([]));
	input.click();
	return promise;
}

/** An `accept` attribute for an Electron-style filter list (`[{name, extensions: ["png"]}]`); `*` means anything. */
export function acceptFromFilters(filters: { extensions: string[] }[] | undefined): string | undefined {
	const extensions = (filters ?? []).flatMap(filter => filter.extensions);
	if (extensions.length === 0 || extensions.includes("*")) return undefined;
	return extensions.map(extension => `.${extension.replace(/^\./, "")}`).join(",");
}
