/**
 * `/blob/<token>`: what a page fetches instead of receiving it in a WebSocket frame (a file the viewer shows,
 * a recording a player streams, a download). The store lives in the core (`crates/core/src/web/blobs.rs`, which
 * has the rules: one device per token, 30 minutes idle, 64 a device, `Range`, attachments for active content) and
 * is served by the web server there. This is its client. A URL is handed back at once: main mints the token (24 random
 * bytes, base64url) and registers it with an ordered push, before the page can learn the URL from a frame that is
 * written after it.
 *
 * A file and bytes the core holds itself. A media stream only main can open (`MediaStreams.handle`, a fetch
 * `Response`): the core asks (`web.media.open`), `pump` answers with the status, the headers and the body's chunks, as
 * fast as the core consumed them (`web.media.ack`), and stops when the HTTP client went (`web.media.cancel`).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { CORE_EXITED, type CoreProcess, core } from "../core/process";

export const BLOB_URL_PREFIX = "/blob/";
export const BLOB_IDLE_TTL_MS = 30 * 60_000;

/** Bytes pushed to the core that it has not reported taking yet, at most. */
const MEDIA_WINDOW_BYTES = 1024 * 1024;
/** The headers of a media answer the page needs; the core copies these and no others. */
const MEDIA_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

type MediaOpen = (range: string | undefined) => Promise<Response>;

/** The media blobs this process registered, by token: `open` answers the core's asks. */
const media = new Map<string, { userData: string; open: MediaOpen }>();

interface Pumping {
	sent: number;
	acked: number;
	cancelled: boolean;
	wake: (() => void) | null;
}
const pumping = new Map<number, Pumping>();
let listeningTo: CoreProcess | null = null;

function listen(): void {
	const process = core();
	if (listeningTo === process) return;
	listeningTo = process;
	process.on("web.media.open", data => {
		// The core's own event: its shape is the one `blobs.rs` writes.
		const ask = data as { userData: string; stream: number; token: string; url: string; range: string | null };
		const entry = media.get(ask.token);
		if (entry?.userData === ask.userData) void pump(ask.stream, entry.open, ask.range ?? undefined);
	});
	process.on("web.media.ack", data => {
		const { stream, bytes } = data as { stream: number; bytes: number };
		const state = pumping.get(stream);
		if (!state) return;
		state.acked += bytes;
		state.wake?.();
	});
	process.on("web.media.cancel", data => {
		const state = pumping.get((data as { stream: number }).stream);
		if (!state) return;
		state.cancelled = true;
		state.wake?.();
	});
	process.on("web.media.drop", data => {
		const { userData, token } = data as { userData: string; token: string };
		if (media.get(token)?.userData === userData) media.delete(token);
	});
	process.on(CORE_EXITED, () => {
		media.clear();
		for (const state of pumping.values()) {
			state.cancelled = true;
			state.wake?.();
		}
	});
}

/** Answers one `web.media.open`: the stream's head, its chunks within the window, its end. */
async function pump(stream: number, open: MediaOpen, range: string | undefined): Promise<void> {
	const state: Pumping = { sent: 0, acked: 0, cancelled: false, wake: null };
	pumping.set(stream, state);
	const push = (method: string, params: object, bin?: Uint8Array): void => {
		try {
			core().push(method, { stream, ...params }, bin);
		} catch {
			// The core is gone; the stream went with it.
		}
	};
	try {
		const response = await open(range);
		const headers: Record<string, string> = {};
		for (const name of MEDIA_HEADERS) {
			const value = response.headers.get(name);
			if (value) headers[name] = value;
		}
		push("web.media.head", { status: response.status, headers });
		const reader = response.body?.getReader();
		try {
			while (reader && !state.cancelled) {
				while (state.sent - state.acked >= MEDIA_WINDOW_BYTES && !state.cancelled) {
					const { promise, resolve } = Promise.withResolvers<void>();
					state.wake = resolve;
					await promise;
				}
				if (state.cancelled) break;
				const { done, value } = await reader.read();
				if (done) break;
				push("web.media.chunk", {}, value);
				state.sent += value.byteLength;
			}
		} finally {
			void reader?.cancel().catch(() => {});
		}
		push("web.media.end", {});
	} catch (error) {
		push("web.media.end", { error: error instanceof Error ? error.message : String(error) });
	} finally {
		pumping.delete(stream);
	}
}

export class BlobStore {
	readonly #userData: string;
	readonly #now: () => number;

	/** `userData` names the store in the core: the web server there serves the one of the same `userData`. */
	constructor(opts: { userData?: string; now?: () => number } = {}) {
		this.#userData = opts.userData ?? `private:${randomUUID()}`;
		this.#now = opts.now ?? Date.now;
	}

	/** How many blobs the store holds. */
	async count(): Promise<number> {
		return (await core().call<{ size: number }>("web.blobs.count", { userData: this.#userData })).result.size;
	}

	addFile(deviceId: string, file: { abs: string; mime: string; name: string; download?: boolean }): string {
		return this.#add(deviceId, {
			kind: "file",
			abs: file.abs,
			mime: file.mime,
			name: file.name,
			download: file.download === true,
		});
	}

	addBytes(deviceId: string, bytes: Uint8Array, mime: string, name = "file"): string {
		return this.#add(deviceId, { kind: "bytes", mime, name }, bytes);
	}

	/** A stream main's `MediaStreams` serves (`url` is its `omp-media://` address); `open` answers a range request. */
	addMedia(deviceId: string, stream: { url: string; mime: string; open: MediaOpen }): string {
		listen();
		return this.#add(
			deviceId,
			{ kind: "media", url: stream.url, mime: stream.mime, name: "media" },
			undefined,
			stream.open,
		);
	}

	/** The `omp-media://` address behind a blob URL of this device, or null. */
	async mediaUrl(deviceId: string, blobUrl: string): Promise<string | null> {
		const { result } = await core().call<{ url: string | null }>("web.blobs.mediaUrl", {
			userData: this.#userData,
			deviceId,
			url: blobUrl,
			now: this.#now(),
		});
		return result.url;
	}

	async release(deviceId: string, blobUrl: string): Promise<boolean> {
		const { result } = await core().call<{ released: boolean }>("web.blobs.release", {
			userData: this.#userData,
			deviceId,
			url: blobUrl,
		});
		return result.released;
	}

	releaseDevice(deviceId: string): void {
		core().push("web.blobs.releaseDevice", { userData: this.#userData, deviceId });
	}

	#add(
		deviceId: string,
		blob: {
			kind: "file" | "bytes" | "media";
			mime: string;
			name: string;
			download?: boolean;
			abs?: string;
			url?: string;
		},
		bytes?: Uint8Array,
		open?: MediaOpen,
	): string {
		const token = randomBytes(24).toString("base64url");
		if (open) media.set(token, { userData: this.#userData, open });
		core().push("web.blobs.add", { userData: this.#userData, deviceId, token, now: this.#now(), ...blob }, bytes);
		return `${BLOB_URL_PREFIX}${token}`;
	}
}
