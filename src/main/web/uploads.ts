/**
 * `POST /upload`: a file from the phone (a photo, an attachment) lands on the host so an agent can read it.
 * Stored at `<userData>/web-uploads/<deviceId>/<uuid>/<name>` (dirs 0700, files 0600), at most 25 MiB each and
 * 200 MiB per device in any 24 hours, and deleted 24 hours after arriving. The caller learns the host path.
 * Revoking a device deletes its folder. The upload counts as the day's use while the file still exists, so the
 * cap needs no ledger and survives a restart.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, join, resolve, sep } from "node:path";

export const UPLOAD_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_DEVICE_DAILY_MAX_BYTES = 200 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Multipart framing around the file: a request may be a little over the file limit. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

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

/** One path segment safe to create: no separators or control characters, no leading dots, not too long. */
export function safeUploadName(raw: string): string {
	const cleaned = basename(raw.replace(/\\/g, "/"))
		.replace(/\p{Cc}/gu, "")
		.replace(/^\.+/, "")
		.trim();
	const name = cleaned.length > 200 ? cleaned.slice(-200) : cleaned;
	return name === "" ? "upload" : name;
}

export class UploadStore {
	readonly #root: string;
	readonly #now: () => number;
	readonly #fileMax: number;
	readonly #dailyMax: number;
	readonly #ttlMs: number;
	/** Bytes of uploads in flight, so parallel requests cannot together pass the daily cap. */
	readonly #pending = new Map<string, number>();

	constructor(opts: {
		root: string;
		now?: () => number;
		fileMaxBytes?: number;
		dailyMaxBytes?: number;
		ttlMs?: number;
	}) {
		this.#root = resolve(opts.root);
		this.#now = opts.now ?? Date.now;
		this.#fileMax = opts.fileMaxBytes ?? UPLOAD_FILE_MAX_BYTES;
		this.#dailyMax = opts.dailyMaxBytes ?? UPLOAD_DEVICE_DAILY_MAX_BYTES;
		this.#ttlMs = opts.ttlMs ?? UPLOAD_TTL_MS;
	}

	/** Whether `file` is inside this device's upload folder. */
	owns(deviceId: string, file: string): boolean {
		const folder = join(this.#root, deviceId) + sep;
		return resolve(file).startsWith(folder);
	}

	/** Read the multipart body (field `file`) of `req` and store it. */
	async receive(deviceId: string, req: IncomingMessage): Promise<StoredUpload> {
		const type = req.headers["content-type"] ?? "";
		if (!/^multipart\/form-data;/i.test(type)) throw new UploadError(415, "expected multipart/form-data");
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > this.#fileMax + MULTIPART_OVERHEAD_BYTES) {
			throw new UploadError(413, "file too large");
		}
		const used = (await this.#liveBytes(deviceId)) + (this.#pending.get(deviceId) ?? 0);
		const room = this.#dailyMax - used;
		if (room <= 0) throw new UploadError(429, "daily upload limit reached");
		const reserve = Number.isFinite(declared)
			? Math.min(declared, this.#fileMax + MULTIPART_OVERHEAD_BYTES)
			: this.#fileMax;
		this.#pending.set(deviceId, (this.#pending.get(deviceId) ?? 0) + reserve);
		try {
			const body = await this.#readBody(req);
			const form = await new Response(new Blob([new Uint8Array(body)]), { headers: { "content-type": type } })
				.formData()
				.catch(() => {
					throw new UploadError(400, "malformed upload");
				});
			const file = form.get("file");
			if (!(file instanceof File)) throw new UploadError(400, "missing file field");
			if (file.size > this.#fileMax) throw new UploadError(413, "file too large");
			if (file.size > room) throw new UploadError(429, "daily upload limit reached");
			const name = safeUploadName(file.name);
			const folder = join(this.#root, deviceId, randomUUID());
			await mkdir(folder, { recursive: true, mode: 0o700 });
			const target = join(folder, name);
			await writeFile(target, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });
			return { path: target, name, size: file.size };
		} finally {
			const left = (this.#pending.get(deviceId) ?? 0) - reserve;
			if (left > 0) this.#pending.set(deviceId, left);
			else this.#pending.delete(deviceId);
		}
	}

	/** Delete uploads older than the TTL; returns how many files went. */
	async sweep(): Promise<number> {
		let removed = 0;
		for (const deviceId of await this.#entries(this.#root)) {
			for (const folder of await this.#entries(join(this.#root, deviceId))) {
				const dir = join(this.#root, deviceId, folder);
				const info = await stat(dir).catch(() => null);
				if (info && this.#now() - info.mtimeMs > this.#ttlMs) {
					await rm(dir, { recursive: true, force: true });
					removed += 1;
				}
			}
		}
		return removed;
	}

	/** Delete everything a device uploaded (it was revoked). */
	async removeDevice(deviceId: string): Promise<void> {
		await rm(join(this.#root, deviceId), { recursive: true, force: true });
	}

	/** Bytes of this device's uploads that still exist and arrived within the TTL. */
	async #liveBytes(deviceId: string): Promise<number> {
		let total = 0;
		const base = join(this.#root, deviceId);
		for (const folder of await this.#entries(base)) {
			const dir = join(base, folder);
			const info = await stat(dir).catch(() => null);
			if (!info || this.#now() - info.mtimeMs > this.#ttlMs) continue;
			for (const file of await this.#entries(dir))
				total += (await stat(join(dir, file)).catch(() => null))?.size ?? 0;
		}
		return total;
	}

	async #entries(dir: string): Promise<string[]> {
		return readdir(dir).catch(() => []);
	}

	async #readBody(req: IncomingMessage): Promise<Buffer> {
		const limit = this.#fileMax + MULTIPART_OVERHEAD_BYTES;
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = chunk as Buffer;
			size += buffer.length;
			if (size > limit) {
				req.destroy();
				throw new UploadError(413, "file too large");
			}
			chunks.push(buffer);
		}
		return Buffer.concat(chunks);
	}
}
