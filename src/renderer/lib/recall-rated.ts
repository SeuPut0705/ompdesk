/**
 * Which recalled notes (`MemoryRecallNote` rows) the person already rated "Not helpful", by `recall:<message time>:<workspace/project>:<path>`.
 * The row unmounts when its line folds or scrolls out of the virtualized transcript, so the state lives here: in
 * memory for remounts and in `sessionStorage` so a reload keeps it (like `lib/mail-open.ts`), newest
 * `RECALL_RATED_LIMIT` keys. A request in flight also lives here, so a row that remounts mid-request or a second
 * click never sends the feedback twice. A failed send is not kept: the button offers it again.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "omp.recallRated";
export const RECALL_RATED_LIMIT = 300;

export type RecallRate = "idle" | "saving" | "done" | "failed";

let cache: Set<string> | null = null;
const live = new Map<string, "saving" | "failed">();
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
	try {
		return globalThis.sessionStorage;
	} catch {
		return undefined;
	}
}

function load(): Set<string> {
	if (cache) return cache;
	cache = new Set();
	try {
		const raw = storage()?.getItem(STORAGE_KEY);
		const entries: unknown = raw ? JSON.parse(raw) : [];
		if (Array.isArray(entries)) for (const entry of entries) if (typeof entry === "string") cache.add(entry);
	} catch {
		// A damaged entry only costs the remembered ratings.
	}
	return cache;
}

function keep(key: string): void {
	const done = load();
	done.delete(key);
	done.add(key);
	while (done.size > RECALL_RATED_LIMIT) {
		const oldest = done.values().next().value;
		if (oldest === undefined) break;
		done.delete(oldest);
	}
	try {
		storage()?.setItem(STORAGE_KEY, JSON.stringify([...done]));
	} catch {
		// Full or unavailable storage: memory still holds it for this page.
	}
}

function changed(): void {
	for (const listener of [...listeners]) listener();
}

function rateOf(key: string): RecallRate {
	return load().has(key) ? "done" : (live.get(key) ?? "idle");
}

export function recallRatedKey(
	timestamp: unknown,
	scope: { workspace: string; project: string },
	path: string,
): string {
	return `recall:${typeof timestamp === "number" || typeof timestamp === "string" ? timestamp : ""}:${scope.workspace}/${scope.project}:${path}`;
}

export function useRecallRate(key: string): RecallRate {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => rateOf(key),
		() => "idle",
	);
}

/** Sends once: a key that is saving or done is left alone. */
export function rateRecall(key: string, send: () => Promise<unknown>): void {
	const state = rateOf(key);
	if (state === "saving" || state === "done") return;
	live.set(key, "saving");
	changed();
	send().then(
		() => {
			live.delete(key);
			keep(key);
			changed();
		},
		() => {
			live.set(key, "failed");
			changed();
		},
	);
}

export function resetRecallRatedForTest(): void {
	cache = null;
	live.clear();
}
