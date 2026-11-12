/**
 * `POST /upload`: a file from the phone (a photo, an attachment) lands on the host so an agent can read it.
 * The store lives in the core (`crates/core/src/web/uploads.rs`), shared with the web server there: it keeps the
 * file at `<userData>/web-uploads/<deviceId>/<uuid>/<name>` (dirs 0700, files 0600), at most 25 MiB each and
 * 200 MiB per device in any 24 hours, and deletes it 24 hours after arriving. This is the typed client the rest of
 * main calls: a paired computer's attachment (`store`), a picture a call names (`take`, read and deleted at
 * once), a revoked device's folder (`removeDevice`), the daily sweep.
 */
import { join, resolve, sep } from "node:path";
import { CoreError, core } from "../core/process";

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** The folder of files attached to this computer's own tabs with no path here (ipc.ts FS_UPLOAD_TO_HOST). */
export const LOCAL_UPLOAD_DEVICE = "this-computer";

const UPLOAD_FOLDER = "web-uploads";

/**
 * A file attached to a prompt of this computer's own tab that has no path here (pasted, dragged out of another app):
 * kept like a phone's upload, so the agent reads it by its path. Too large and over the day's limit come back as the
 * codes the composer words.
 */
export async function attachHere(
	uploads: Pick<UploadStore, "store">,
	name: string,
	bytes: Uint8Array,
): Promise<{ ok: true; path: string } | { ok: false; error: string; code?: "file_too_large" | "upload_refused" }> {
	try {
		return { ok: true, path: (await uploads.store(LOCAL_UPLOAD_DEVICE, name, bytes)).path };
	} catch (error) {
		if (error instanceof UploadError && error.status === 413)
			return { ok: false, error: error.message, code: "file_too_large" };
		if (error instanceof UploadError && error.status === 429)
			return { ok: false, error: error.message, code: "upload_refused" };
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export class UploadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "UploadError";
		this.status = status;
	}
}

export interface StoredUpload {
	path: string;
	name: string;
	size: number;
}

export class UploadStore {
	readonly #userData: string;
	readonly #root: string;
	readonly #now: () => number;
	readonly #limits: { fileMaxBytes?: number; dailyMaxBytes?: number; ttlMs?: number };

	constructor(opts: {
		userData: string;
		now?: () => number;
		fileMaxBytes?: number;
		dailyMaxBytes?: number;
		ttlMs?: number;
	}) {
		this.#userData = opts.userData;
		this.#root = resolve(opts.userData, UPLOAD_FOLDER);
		this.#now = opts.now ?? Date.now;
		this.#limits = { fileMaxBytes: opts.fileMaxBytes, dailyMaxBytes: opts.dailyMaxBytes, ttlMs: opts.ttlMs };
	}

	/** Whether `file` is inside this device's upload folder. */
	owns(deviceId: string, file: string): boolean {
		const folder = join(this.#root, deviceId) + sep;
		return resolve(file).startsWith(folder);
	}

	/**
	 * A file a paired computer attached to a prompt of a tab it runs here (`host.files.upload`): the same folder,
	 * limits and lifetime as a phone's upload, so the agent reads it by its path here.
	 */
	async store(deviceId: string, name: string, bytes: Uint8Array): Promise<StoredUpload> {
		return (
			await this.#call<StoredUpload>(
				"web.uploads.store",
				{ deviceId, name, now: this.#now(), limits: this.#limits },
				bytes,
			)
		).result;
	}

	/**
	 * The bytes of `file`, an upload of this device that a call names (a prompt's photo: web-protocol.ts
	 * `WebUploadedImage`), and the upload is gone, its bytes now ride the call. 404 when it is not this device's or
	 * no longer there.
	 */
	async take(deviceId: string, file: string): Promise<Buffer> {
		const { bin } = await this.#call("web.uploads.take", { deviceId, file });
		return bin ? Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength) : Buffer.alloc(0);
	}

	/** Delete uploads older than the TTL; returns how many went. */
	async sweep(): Promise<number> {
		return (await this.#call<{ removed: number }>("web.uploads.sweep", { now: this.#now(), limits: this.#limits }))
			.result.removed;
	}

	/** Delete everything a device uploaded (it was revoked). */
	async removeDevice(deviceId: string): Promise<void> {
		await this.#call("web.uploads.removeDevice", { deviceId });
	}

	/** A refusal of the core's store (`upload_<status>`) is an `UploadError`, as the page and the composer read it. */
	async #call<T>(method: string, params: object, bin?: Uint8Array) {
		try {
			return await core().call<T>(method, { userData: this.#userData, ...params }, bin ? { bin } : {});
		} catch (error) {
			if (error instanceof CoreError) {
				const status = /^upload_(\d+)$/.exec(error.code)?.[1];
				if (status !== undefined) throw new UploadError(Number(status), error.message);
			}
			throw error;
		}
	}
}
