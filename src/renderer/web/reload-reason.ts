/**
 * Every reload the web page makes of itself says why, in the host's runtime log (`gui-runtime.jsonl`, source
 * `web-reload`, the page's negative windowId). The reason is written to `localStorage` just before the reload and
 * sent once the next page load has connected (`flushReloadReasons`), so the record survives the very navigation it
 * explains, and a reload that never reached the host (the link was down) is sent on the next connect instead.
 */
import type { RuntimeErrorReport } from "../../shared/ipc-types";

export type ReloadReason =
	/** A new build's service worker took over (sw-update.ts `UpdateWatcher`). */
	| "update"
	/** The host needs a newer page (`hello.minClient`): the worker and its caches were dropped first. */
	| "outdated"
	/** The in-place resync after a reconnect kept failing: the last resort (sw-update.ts `reloadWhenUnused`). */
	| "resync-failed"
	/** The user tapped the "new version" chip after a chunk of this build could not be loaded. */
	| "chunk-load-failed"
	/** The user tapped Reload on the crash screen (`RootErrorBoundary`). */
	| "error-boundary";

export interface ReloadRecord {
	reason: ReloadReason;
	/** When the page reloaded (ms since the epoch). */
	at: number;
	details?: Record<string, string | number | boolean | null>;
}

export interface ReloadStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

const PENDING_KEY = "omp.web.reload-reasons";
/** A page caught in a reload loop keeps the newest reasons only. */
const MAX_PENDING = 20;

function readPending(storage: ReloadStorage): ReloadRecord[] {
	try {
		const parsed: unknown = JSON.parse(storage.getItem(PENDING_KEY) ?? "[]");
		return Array.isArray(parsed)
			? parsed.filter(
					(item): item is ReloadRecord =>
						typeof item === "object" &&
						item !== null &&
						typeof item.reason === "string" &&
						typeof item.at === "number",
				)
			: [];
	} catch {
		return [];
	}
}

/** Keep the reason of the reload about to happen. Never throws: a full or blocked storage loses only the record. */
export function noteReload(storage: ReloadStorage, record: ReloadRecord): void {
	try {
		storage.setItem(PENDING_KEY, JSON.stringify([...readPending(storage), record].slice(-MAX_PENDING)));
	} catch {
		// The reload goes ahead regardless.
	}
}

/** The runtime-log line of one reload. */
export function reloadReport(record: ReloadRecord): RuntimeErrorReport {
	return {
		source: "web-reload",
		message: record.reason,
		details: { reloadedAt: new Date(record.at).toISOString(), ...record.details },
	};
}

/** Send every kept reason (the page is connected) and forget them. */
export function flushReloadReasons(storage: ReloadStorage, send: (report: RuntimeErrorReport) => void): number {
	const pending = readPending(storage);
	if (pending.length === 0) return 0;
	try {
		storage.removeItem(PENDING_KEY);
	} catch {
		return 0;
	}
	for (const record of pending) send(reloadReport(record));
	return pending.length;
}
