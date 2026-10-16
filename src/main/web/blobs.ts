/**
 * `/blob/<token>`: what a page fetches instead of receiving it in a WebSocket frame (a file the viewer shows,
 * a recording a player streams, a download). Each token is random, belongs to one device (its cookie must
 * match) and dies after 30 minutes without a request. The three sources: a file on disk, bytes main already
 * holds, or a stream `MediaStreams` serves. Answers honour `Range`. A blob is never rendered as a page: HTML,
 * SVG and scripts are served as attachments, everything carries `nosniff` and a sandboxing CSP.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

export const BLOB_URL_PREFIX = "/blob/";
export const BLOB_IDLE_TTL_MS = 30 * 60_000;
const MAX_BLOBS_PER_DEVICE = 64;

/** Types a browser would run or render as a document: only ever downloaded. */
const ACTIVE_CONTENT =
	/^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|(text|application)\/(x-)?javascript)\b/i;

type BlobSource =
	| { kind: "file"; abs: string }
	| { kind: "bytes"; bytes: Uint8Array }
	| { kind: "media"; url: string; size: number; open: (range: string | undefined) => Promise<Response> };

interface BlobEntry {
	deviceId: string;
	source: BlobSource;
	mime: string;
	name: string;
	download: boolean;
	touchedAt: number;
}

export interface ByteRange {
	start: number;
	end: number;
}

/** A single `bytes=` range of a `size`-byte body: a range, `null` for none given, `"invalid"` when it cannot be met. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
	if (header === undefined || header === "") return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return "invalid";
	const [, from = "", to = ""] = match;
	if (from === "" && to === "") return "invalid";
	if (from === "") {
		const suffix = Number(to);
		if (suffix === 0) return "invalid";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(from);
	const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
	if (start >= size || start > end) return "invalid";
	return { start, end };
}

function contentDisposition(name: string, attachment: boolean): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export class BlobStore {
	readonly #entries = new Map<string, BlobEntry>();
	readonly #now: () => number;
	readonly #ttlMs: number;

	constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
		this.#now = opts.now ?? Date.now;
		this.#ttlMs = opts.ttlMs ?? BLOB_IDLE_TTL_MS;
	}

	get size(): number {
		return this.#entries.size;
	}

	addFile(deviceId: string, file: { abs: string; mime: string; name: string; download?: boolean }): string {
		return this.#add(deviceId, { kind: "file", abs: file.abs }, file.mime, file.name, file.download === true);
	}

	addBytes(deviceId: string, bytes: Uint8Array, mime: string, name = "file"): string {
		return this.#add(deviceId, { kind: "bytes", bytes }, mime, name, false);
	}

	/** A stream main's `MediaStreams` serves (`url` is its `omp-media://` address); `open` answers a range request. */
	addMedia(
		deviceId: string,
		media: { url: string; mime: string; size: number; open: (range: string | undefined) => Promise<Response> },
	): string {
		return this.#add(deviceId, { kind: "media", ...media }, media.mime, "media", false);
	}

	/** The `omp-media://` address behind a blob URL of this device, or null. */
	mediaUrl(deviceId: string, blobUrl: string): string | null {
		const entry = this.#lookup(deviceId, tokenOf(blobUrl));
		return entry?.source.kind === "media" ? entry.source.url : null;
	}

	release(deviceId: string, blobUrl: string): boolean {
		const token = tokenOf(blobUrl);
		return token !== null && this.#entries.get(token)?.deviceId === deviceId && this.#entries.delete(token);
	}

	releaseDevice(deviceId: string): void {
		for (const [token, entry] of this.#entries) {
			if (entry.deviceId === deviceId) this.#entries.delete(token);
		}
	}

	/** Answer `GET /blob/<token>` for the authenticated `deviceId`. */
	async serve(deviceId: string, blobUrl: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const entry = this.#lookup(deviceId, tokenOf(blobUrl));
		if (!entry) {
			this.#fail(res, 404);
			return;
		}
		const attachment =
			entry.download ||
			new URL(blobUrl, "http://x").searchParams.get("dl") === "1" ||
			ACTIVE_CONTENT.test(entry.mime);
		const base: Record<string, string> = {
			"content-type": entry.mime,
			"accept-ranges": "bytes",
			"content-disposition": contentDisposition(entry.name, attachment),
			"x-content-type-options": "nosniff",
			"cache-control": "private, no-store",
			"content-security-policy": "sandbox; default-src 'none'",
			"cross-origin-resource-policy": "same-origin",
		};
		try {
			const { source } = entry;
			if (source.kind === "media") await this.#serveMedia(source, base, req, res);
			else if (source.kind === "bytes") await this.#serveBytes(source.bytes, base, req, res);
			else await this.#serveFile(source.abs, base, req, res);
		} catch (error) {
			if (!res.headersSent) this.#fail(res, 404);
			else res.destroy(error instanceof Error ? error : undefined);
		}
	}

	#add(deviceId: string, source: BlobSource, mime: string, name: string, download: boolean): string {
		this.#sweep();
		const mine = [...this.#entries].filter(([, entry]) => entry.deviceId === deviceId);
		if (mine.length >= MAX_BLOBS_PER_DEVICE) {
			const oldest = mine.reduce((a, b) => (a[1].touchedAt <= b[1].touchedAt ? a : b));
			this.#entries.delete(oldest[0]);
		}
		const token = randomBytes(24).toString("base64url");
		this.#entries.set(token, { deviceId, source, mime, name, download, touchedAt: this.#now() });
		return `${BLOB_URL_PREFIX}${token}`;
	}

	#lookup(deviceId: string, token: string | null): BlobEntry | undefined {
		if (token === null) return undefined;
		const entry = this.#entries.get(token);
		if (!entry || entry.deviceId !== deviceId) return undefined;
		if (this.#now() - entry.touchedAt > this.#ttlMs) {
			this.#entries.delete(token);
			return undefined;
		}
		entry.touchedAt = this.#now();
		return entry;
	}

	#sweep(): void {
		const now = this.#now();
		for (const [token, entry] of this.#entries) {
			if (now - entry.touchedAt > this.#ttlMs) this.#entries.delete(token);
		}
	}

	#fail(res: ServerResponse, status: number): void {
		res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
		res.end();
	}

	#head(res: ServerResponse, base: Record<string, string>, size: number, range: ByteRange | null): void {
		if (range) {
			res.writeHead(206, {
				...base,
				"content-length": String(range.end - range.start + 1),
				"content-range": `bytes ${range.start}-${range.end}/${size}`,
			});
		} else {
			res.writeHead(200, { ...base, "content-length": String(size) });
		}
	}

	async #serveFile(
		abs: string,
		base: Record<string, string>,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const info = await stat(abs);
		if (!info.isFile()) throw new Error("not a file");
		const range = parseRange(req.headers.range, info.size);
		if (range === "invalid") {
			res.writeHead(416, { ...base, "content-range": `bytes */${info.size}` });
			res.end();
			return;
		}
		this.#head(res, base, info.size, range);
		if (req.method === "HEAD" || info.size === 0) {
			res.end();
			return;
		}
		await pipeline(createReadStream(abs, range ? { start: range.start, end: range.end } : {}), res);
	}

	async #serveBytes(
		bytes: Uint8Array,
		base: Record<string, string>,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const range = parseRange(req.headers.range, bytes.length);
		if (range === "invalid") {
			res.writeHead(416, { ...base, "content-range": `bytes */${bytes.length}` });
			res.end();
			return;
		}
		this.#head(res, base, bytes.length, range);
		res.end(req.method === "HEAD" ? undefined : range ? bytes.subarray(range.start, range.end + 1) : bytes);
	}

	async #serveMedia(
		source: Extract<BlobSource, { kind: "media" }>,
		base: Record<string, string>,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const answer = await source.open(req.headers.range);
		const headers: Record<string, string> = { ...base };
		for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
			const value = answer.headers.get(name);
			if (value) headers[name] = value;
		}
		res.writeHead(answer.status, headers);
		if (req.method === "HEAD" || !answer.body) {
			res.end();
			return;
		}
		const body = answer.body.getReader();
		try {
			for (;;) {
				const { done, value } = await body.read();
				if (done) break;
				if (!res.write(value)) await new Promise<void>(resolve => res.once("drain", resolve));
				if (res.destroyed) break;
			}
		} finally {
			void body.cancel().catch(() => {});
			res.end();
		}
	}
}

/** The token of `/blob/<token>[?query]`, or null. */
function tokenOf(blobUrl: string): string | null {
	if (!blobUrl.startsWith(BLOB_URL_PREFIX)) return null;
	const token = blobUrl.slice(BLOB_URL_PREFIX.length).split(/[?#]/, 1)[0];
	return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}
