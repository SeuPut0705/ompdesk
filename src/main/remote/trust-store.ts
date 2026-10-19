/**
 * A paired-device list under userData (HostStore on the A side, PeerStore on
 * the B side): mode 0600, rewritten atomically on every change, stored as
 * `{ v: 1, [key]: entry[] }`. Entries are validated one by one, so a corrupt
 * entry drops alone. Callers only ever get copies.
 */
import { z } from "zod";
import { readJson, writeSecureJson } from "./secure-file";

export class TrustStore<T extends { deviceId: string }> {
	readonly #file: string;
	readonly #key: string;
	readonly #entry: z.ZodType<T, z.ZodTypeDef, unknown>;
	readonly #copy: (entry: T) => T;
	#entries: Map<string, T> | null = null;

	constructor(file: string, key: string, entry: z.ZodType<T, z.ZodTypeDef, unknown>, copy: (entry: T) => T) {
		this.#file = file;
		this.#key = key;
		this.#entry = entry;
		this.#copy = copy;
	}

	#load(): Map<string, T> {
		if (this.#entries) return this.#entries;
		this.#entries = new Map();
		const stored = z
			.object({ v: z.literal(1) })
			.passthrough()
			.safeParse(readJson(this.#file));
		const raws = stored.success ? z.array(z.unknown()).safeParse(stored.data[this.#key]) : undefined;
		for (const raw of raws?.success ? raws.data : []) {
			const entry = this.#entry.safeParse(raw);
			if (entry.success) this.#entries.set(entry.data.deviceId, entry.data);
		}
		return this.#entries;
	}

	#save(): void {
		writeSecureJson(this.#file, { v: 1, [this.#key]: [...this.#load().values()] });
	}

	list(): T[] {
		return [...this.#load().values()].map(this.#copy);
	}

	get(deviceId: string): T | undefined {
		const entry = this.#load().get(deviceId);
		return entry && this.#copy(entry);
	}

	/** Add or replace (re-pair) an entry. */
	put(entry: T): void {
		this.#load().set(entry.deviceId, this.#copy(entry));
		this.#save();
	}

	update(deviceId: string, patch: Partial<Omit<T, "deviceId">>): T | undefined {
		const entries = this.#load();
		const current = entries.get(deviceId);
		if (!current) return undefined;
		const next = this.#copy({ ...current, ...patch });
		entries.set(deviceId, next);
		this.#save();
		return this.#copy(next);
	}

	remove(deviceId: string): boolean {
		if (!this.#load().delete(deviceId)) return false;
		this.#save();
		return true;
	}
}
