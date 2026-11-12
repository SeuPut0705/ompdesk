/**
 * A download main runs itself for an install (PortableGit, a gh/Node archive), so the setup screen can show real
 * byte progress instead of a silent installer. The core (`crates/core/src/setup/download.rs`) streams the file to
 * `<file>.part`, hashes it on the way and moves it to `file` only when its SHA-256 matches the published one; any
 * failure or an abort leaves nothing behind. This is the typed client: the request, its progress events and the
 * abort.
 */
import type { SetupDownloadProgress } from "../../shared/setup";
import { CoreError, core } from "../core/process";

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
	/** An `accept` header (the GitHub API's asset URL answers the file only to `application/octet-stream`). */
	accept?: string;
	/**
	 * A test's server on 127.0.0.1 standing in for every host: `https://host/path` is fetched from
	 * `<mirror>/host/path`. Only a test passes it.
	 */
	mirror?: string;
}

/** The longest `setTimeout` takes: a download has no bound of its own, only its signal. */
export const NO_TIMEOUT_MS = 2 ** 31 - 1;

const listeners = new Map<number, (progress: SetupDownloadProgress) => void>();
let subscribed = false;
let sequence = 0;

function subscribe(): void {
	if (subscribed) return;
	subscribed = true;
	core().on("setup.downloadProgress", data => {
		const { id, received, total } = data as { id: number; received: number; total: number | null };
		listeners.get(id)?.({ received, total });
	});
}

/** Download `url` to `file` and check its SHA-256. Throws DownloadError, or the abort reason once `signal` fired. */
export async function downloadVerified(options: DownloadOptions): Promise<void> {
	const { url, sha256, file, signal, onProgress, accept, mirror } = options;
	signal.throwIfAborted();
	subscribe();
	const id = ++sequence;
	listeners.set(id, onProgress);
	try {
		await core().call(
			"setup.download",
			{ id, url, sha256, file, ...(accept ? { accept } : {}), ...(mirror ? { mirror } : {}) },
			{ signal, timeoutMs: NO_TIMEOUT_MS },
		);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (error instanceof CoreError && (error.code === "download" || error.code === "checksum"))
			throw new DownloadError(error.code, error.message);
		throw error;
	} finally {
		listeners.delete(id);
	}
}
