/**
 * A download main runs itself for an install (PortableGit, a gh/Node archive),
 * so the setup screen can show real byte progress instead of a silent
 * installer. The file is streamed to `<file>.part`, hashed on the way, and moved
 * to `file` only when its SHA-256 matches the published one; any failure or an
 * abort leaves nothing behind.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import type { SetupDownloadProgress } from "../../shared/setup";

export type DownloadFetch = (url: string, init: RequestInit) => Promise<Response>;

/** `download`: the server could not be reached or refused; `checksum`: the bytes did not match. */
export class DownloadError extends Error {
	readonly reason: "download" | "checksum";

	constructor(reason: "download" | "checksum", message: string) {
		super(message);
		this.name = "DownloadError";
		this.reason = reason;
	}
}

export interface DownloadOptions {
	url: string;
	/** Published SHA-256, lowercase hex. */
	sha256: string;
	file: string;
	signal: AbortSignal;
	onProgress: (progress: SetupDownloadProgress) => void;
	fetch?: DownloadFetch;
}

/** Download `url` to `file` and check its SHA-256. Throws DownloadError, or the abort reason once `signal` fired. */
export async function downloadVerified(options: DownloadOptions): Promise<void> {
	const { url, sha256, file, signal, onProgress } = options;
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(url, {
			signal,
			redirect: "follow",
			headers: { "user-agent": "ompdesk-setup" },
		});
	} catch (error) {
		if (signal.aborted) throw error;
		const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
		throw new DownloadError("download", `${url}: ${cause}`);
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new DownloadError("download", `${url} answered ${response.status}`);
	}
	const length = Number(response.headers.get("content-length"));
	const total = Number.isSafeInteger(length) && length > 0 ? length : null;
	await mkdir(dirname(file), { recursive: true });
	const part = `${file}.part`;
	const out = createWriteStream(part);
	// A stream with no 'error' listener turns ENOSPC/EACCES (or a failed open) into an uncaught exception
	// in main, and a pending `reader.read()` would never notice it. This listener lives as long as the stream.
	const writeFailed = new Promise<never>((_, reject) => {
		out.on("error", error => reject(new DownloadError("download", `${part}: ${error.message}`)));
	});
	writeFailed.catch(() => undefined);
	const hash = createHash("sha256");
	const reader = response.body.getReader();
	let received = 0;
	onProgress({ received, total });
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), writeFailed]);
			if (done) break;
			hash.update(value);
			received += value.byteLength;
			if (!out.write(value)) await Promise.race([once(out, "drain"), writeFailed]);
			onProgress({ received, total });
		}
		out.end();
		await Promise.race([finished(out), writeFailed]);
		const actual = hash.digest("hex");
		if (actual !== sha256) throw new DownloadError("checksum", `SHA-256 mismatch: expected ${sha256}, got ${actual}`);
		await rename(part, file);
	} catch (error) {
		// Cancel before releasing the lock so the response body (a socket) is closed, not left open.
		await reader.cancel(error).catch(() => undefined);
		reader.releaseLock();
		out.destroy();
		// An early abort can land while `.part` is still opening; destroy() closes it only once
		// that open finished, so remove the file after the close or the open recreates it.
		await finished(out).catch(() => undefined);
		await rm(part, { force: true, recursive: true });
		throw error;
	}
}
