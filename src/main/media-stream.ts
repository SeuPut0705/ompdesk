/**
 * `omp-media://` — audio and video for the renderer's players, streamed from
 * disk with HTTP range requests so a long recording seeks and plays without
 * its bytes ever crossing IPC or sitting in a blob.
 *
 * A URL is a capability, never a path: the renderer asks `fs:media-stream`
 * for a file, main resolves it exactly like `fs:read-binary` (the tab's
 * workspace for relative paths, `resolveWorkspaceMedia`), checks it sniffs as
 * audio or video, and hands back `omp-media://stream/<random token>`. The
 * handler serves registered tokens only, so model text can never name a file
 * here. Tokens die when the renderer releases them or its window goes away.
 * A paired host's tab has no stream (its bytes cross the link in one frame);
 * the renderer falls back to `fs:read-binary` under the host's cap.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";

export const MEDIA_SCHEME = "omp-media";
const URL_PREFIX = `${MEDIA_SCHEME}://stream/`;

interface MediaEntry {
	abs: string;
	mime: string;
	owner: number;
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against `size`; null without a header, "invalid" when unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || (match[1] === "" && match[2] === "")) return "invalid";
	let start: number;
	let end: number;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (suffix === 0) return "invalid";
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	if (start >= size || end < start) return "invalid";
	return { start, end };
}

export class MediaStreams {
	#entries = new Map<string, MediaEntry>();

	/** A fresh URL serving `abs` for the renderer `owner` (its webContents id). */
	open(abs: string, mime: string, owner: number): string {
		const token = randomBytes(24).toString("base64url");
		this.#entries.set(token, { abs, mime, owner });
		return `${URL_PREFIX}${token}`;
	}

	/** Forget one URL; only its owner may. */
	release(url: unknown, owner: number): void {
		if (typeof url !== "string" || !url.startsWith(URL_PREFIX)) return;
		const token = url.slice(URL_PREFIX.length);
		if (this.#entries.get(token)?.owner === owner) this.#entries.delete(token);
	}

	/** Forget every URL a renderer held (its window closed or reloaded). */
	releaseOwner(owner: number): void {
		for (const [token, entry] of this.#entries) if (entry.owner === owner) this.#entries.delete(token);
	}

	get size(): number {
		return this.#entries.size;
	}

	async handle(request: Request): Promise<Response> {
		const token = request.url.startsWith(URL_PREFIX)
			? request.url.slice(URL_PREFIX.length).replace(/[?#].*$/, "")
			: "";
		const entry = this.#entries.get(token);
		if (!entry || (request.method !== "GET" && request.method !== "HEAD")) return new Response(null, { status: 404 });
		let size: number;
		try {
			const stat = await fsp.stat(entry.abs);
			if (!stat.isFile()) return new Response(null, { status: 404 });
			size = stat.size;
		} catch {
			return new Response(null, { status: 404 });
		}
		const range = parseRange(request.headers.get("range"), size);
		const headers = new Headers({
			"Accept-Ranges": "bytes",
			"Content-Type": entry.mime,
			"Cache-Control": "no-store",
		});
		if (range === "invalid") {
			headers.set("Content-Range", `bytes */${size}`);
			return new Response(null, { status: 416, headers });
		}
		const start = range?.start ?? 0;
		const end = range?.end ?? size - 1;
		headers.set("Content-Length", String(Math.max(0, end - start + 1)));
		if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
		const status = range ? 206 : 200;
		if (request.method === "HEAD" || size === 0) return new Response(null, { status, headers });
		// Pulled chunk by chunk, so a paused player stops the disk read (backpressure).
		const file = createReadStream(entry.abs, { start, end });
		const chunks = file[Symbol.asyncIterator]();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const next = await chunks.next();
				if (next.done) controller.close();
				else controller.enqueue(new Uint8Array(next.value as Buffer));
			},
			cancel() {
				file.destroy();
			},
		});
		return new Response(body, { status, headers });
	}
}
