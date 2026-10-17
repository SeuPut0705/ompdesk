/**
 * `window.omp.fs.pathForFile` for a phone: the browser has no local path for a picked or dropped file, so the
 * file goes to the host (`POST /upload`, multipart field `file`, 25 MB each) and the answer is the path it has
 * there, which the composer mentions like any local file. A file the host would refuse or the network loses
 * answers "" — the composer's own fallbacks (inline text, a reason) take over — and `onFailure` says why.
 */
import type { FetchLike } from "./session";

/** The host's per-file limit (design §5.4). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export type UploadFailure = "too-large" | "refused" | "network";

export interface UploadDeps {
	fetch: FetchLike;
	base?: string;
	onFailure?: (file: File, failure: UploadFailure, status?: number) => void;
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

/**
 * A `pathForFile` that uploads each distinct `File` once and keeps the answer: the composer asks again for the
 * same file (paste then send), and a second upload would leave a second copy on the host.
 */
export function createPathForFile(deps: UploadDeps): (file: File) => Promise<string> {
	const known = new WeakMap<File, Promise<string>>();
	return file => {
		const cached = known.get(file);
		if (cached) return cached;
		const result = (async () => {
			if (file.size > UPLOAD_MAX_BYTES) {
				deps.onFailure?.(file, "too-large");
				return "";
			}
			inFlight++;
			try {
				return await uploadFile(file, deps);
			} catch (error) {
				if (error instanceof UploadRefused) deps.onFailure?.(file, "refused", error.status);
				else deps.onFailure?.(file, "network");
				// A failed upload is tried again next time.
				known.delete(file);
				return "";
			} finally {
				inFlight--;
			}
		})();
		known.set(file, result);
		return result;
	};
}

/** Pick files on the phone with a file input; empty when the picker was cancelled. */
export function pickFiles(
	accept: string | undefined,
	doc: Pick<Document, "createElement"> = document,
): Promise<File[]> {
	return new Promise(resolve => {
		const input = doc.createElement("input");
		input.type = "file";
		input.multiple = true;
		if (accept) input.accept = accept;
		input.addEventListener("change", () => resolve(Array.from(input.files ?? [])));
		input.addEventListener("cancel", () => resolve([]));
		input.click();
	});
}

/** An `accept` attribute for an Electron-style filter list (`[{name, extensions: ["png"]}]`); `*` means anything. */
export function acceptFromFilters(filters: { extensions: string[] }[] | undefined): string | undefined {
	const extensions = (filters ?? []).flatMap(filter => filter.extensions);
	if (extensions.length === 0 || extensions.includes("*")) return undefined;
	return extensions.map(extension => `.${extension.replace(/^\./, "")}`).join(",");
}
