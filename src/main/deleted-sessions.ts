/**
 * Sessions the user deleted (a tombstone per session file). A deleted session is gone for good: every path that
 * could bring it back as a tab or a row (a saved desktop or web layout, a turn-resume marker, a paired device's
 * `tab.open`, the session index, a reopen from a window's closed-tab history) asks here first.
 *
 * Distinct from a session that was never written: a new session's first turn cut off before stock wrote its file
 * has no file either, but it was never deleted, so its marker still continues it (`TurnResume`'s
 * `#unwrittenSessionTab`). Only a file someone deleted lands here.
 *
 * Kept in `<userData>/deleted-sessions.json`; session paths are never reused (each holds its own id), so a tombstone
 * can never hide a different session. Bounded by count; the oldest go first.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomicSync } from "./atomic-file";

export const MAX_TOMBSTONES = 2000;

interface Tombstone {
	path: string;
	/** Paired host deviceId the session lived on; absent = this computer. */
	device?: string;
	at: number;
}

function keyOf(path: string, device?: string): string {
	return `${device ?? ""}\u0000${device ? path : resolve(path)}`;
}

export class DeletedSessions {
	readonly #file: string | null;
	readonly #entries = new Map<string, Tombstone>();

	constructor(file: string | null) {
		this.#file = file;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(value)) return;
			for (const item of value) {
				if (typeof item !== "object" || item === null) continue;
				const { path, device, at } = item as Record<string, unknown>;
				if (typeof path !== "string" || !path) continue;
				const entry: Tombstone = { path, at: typeof at === "number" ? at : 0 };
				if (typeof device === "string" && device) entry.device = device;
				this.#entries.set(keyOf(entry.path, entry.device), entry);
			}
		} catch {
			// No record yet, or a damaged one: nothing was deleted as far as this launch knows.
		}
	}

	has(path: string | undefined, device?: string): boolean {
		return path !== undefined && this.#entries.has(keyOf(path, device));
	}

	add(path: string, device?: string, now = Date.now()): void {
		const key = keyOf(path, device);
		this.#entries.delete(key);
		this.#entries.set(key, device ? { path, device, at: now } : { path: resolve(path), at: now });
		while (this.#entries.size > MAX_TOMBSTONES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
		this.#save();
	}

	#save(): void {
		if (!this.#file) return;
		try {
			writeFileAtomicSync(this.#file, JSON.stringify([...this.#entries.values()]), { mode: 0o600 });
		} catch (error) {
			console.warn(`[deleted-sessions] not saved: ${error}`);
		}
	}
}

let current = new DeletedSessions(null);

/** The record every restore path consults; `initDeletedSessions` points it at the profile's file at startup. */
export function deletedSessions(): DeletedSessions {
	return current;
}

export function initDeletedSessions(file: string | null): DeletedSessions {
	current = new DeletedSessions(file);
	return current;
}
