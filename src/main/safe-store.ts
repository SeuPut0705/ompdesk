/**
 * `electron-store` for the files main writes from events (the prefs; the shell keeps the window geometry by the same
 * rule, `shell_core::atomic::KeptFile`): a `set` on a full disk never throws into the caller. conf keeps nothing in
 * memory (every read parses the file), so the value that could not be written is kept here, per file and shared by
 * every store on it (the prefs file has three), and answers reads until it is saved. The save is tried again on the
 * backoff of `atomic-file.ts` and the file joins the one disk-full notice (`disk-full.ts`); a newer `set` replaces
 * what waits. Any other write failure still throws, as it did.
 *
 * Only the public `store` accessor is wrapped, which every `get`, `set`, `delete` and `has` of conf goes through.
 */
import ElectronStore from "electron-store";
import { DISK_FULL_RETRY_MS } from "./atomic-file";
import { diskFull, isDiskFull } from "./disk-full";

interface Waiting {
	/** What the file should hold: the newest whole store that could not be written. */
	value: unknown;
	timer: NodeJS.Timeout | undefined;
	tries: number;
}

/** File path to what waits for room in it. */
const waiting = new Map<string, Waiting>();

function settle(path: string): void {
	const entry = waiting.get(path);
	if (!entry) return;
	clearTimeout(entry.timer);
	waiting.delete(path);
	diskFull.clear(path);
}

function schedule(store: { path: string; store: unknown }, entry: Waiting): void {
	const delay = DISK_FULL_RETRY_MS[Math.min(entry.tries++, DISK_FULL_RETRY_MS.length - 1)] ?? 60_000;
	entry.timer = setTimeout(() => {
		entry.timer = undefined;
		try {
			// The store's own setter: a save that lands settles the file, a full disk keeps waiting.
			store.store = entry.value;
		} catch (error) {
			console.warn(`[prefs] ${store.path} could not be saved: ${error instanceof Error ? error.message : error}`);
			settle(store.path);
			return;
		}
		if (waiting.get(store.path) === entry) schedule(store, entry);
	}, delay);
	entry.timer.unref();
}

function keep(store: { path: string; store: unknown }, value: unknown): void {
	const entry = waiting.get(store.path);
	if (entry) {
		entry.value = value;
		return;
	}
	const created: Waiting = { value, timer: undefined, tries: 0 };
	waiting.set(store.path, created);
	diskFull.report(store.path);
	schedule(store, created);
}

// biome-ignore lint/suspicious/noExplicitAny: electron-store's own constraint on the shape it stores.
export class SafeStore<T extends Record<string, any> = Record<string, unknown>> extends ElectronStore<T> {
	override get store(): T {
		const entry = waiting.get(this.path);
		return entry ? structuredClone(entry.value as T) : super.store;
	}

	override set store(value: T) {
		try {
			super.store = value;
		} catch (error) {
			if (!isDiskFull(error)) throw error;
			keep(this, structuredClone(value));
			this.events.dispatchEvent(new Event("change"));
			return;
		}
		settle(this.path);
	}
}
