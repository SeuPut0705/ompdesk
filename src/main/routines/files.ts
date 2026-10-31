/**
 * The files trigger of a routine: a file or folder (with everything under it) is watched, and a burst of changes
 * fires the routine once, two seconds after the last change (at most ten after the first, so a steady stream still
 * fires). `.git/` and `node_modules/` are never news. Changes made while the routine's own run goes, and for
 * `ROUTINE_QUIET_MS` after it ended, are its own writes and fire nothing (the loop guard: a routine that edits the
 * folder it watches would start itself again). A path that does not exist, or whose watcher failed, is watched
 * again every minute and fires nothing meanwhile.
 *
 * Across a relaunch: a listing of what is under the path (name, modified time and size of each file, at most
 * `FILES_LISTING_MAX` in name order) is the trigger's mark, taken when it starts and again two seconds after each
 * burst of changes (its own writes too). A start with the last launch's listing compares the two and fires once for
 * the files added, changed or removed while OMPdesk was closed, merged with any change seen while it compared. Past
 * the cap only files both listings hold are compared, and a different set of names fires as "Something under … changed".
 */
import { clip, failureReporter, type RoutineSource, type SourceContext } from "./source";

/** Starts watching `path` recursively; throws when it cannot (a missing path). `onError` ends the watch. */
export type WatchPath = (
	path: string,
	onChange: (filename: string | null) => void,
	onError: (error: Error) => void,
) => { close(): void };

/**
 * What is under a path: each file's name ("/"-separated, relative; "" for the path itself when it is a file) and
 * `<modified ms>:<size>`. `complete` is false when the listing stopped at `FILES_LISTING_MAX`.
 */
export interface FilesListing {
	entries: Record<string, string>;
	complete: boolean;
}

/** Lists `path` as `FilesListing` (skipping `IGNORED_DIRS`); null when nothing is there. Rejects when it cannot read it. */
export type ScanPath = (path: string) => Promise<FilesListing | null>;

export const FILES_DEBOUNCE_MS = 2_000;
export const FILES_MAX_WAIT_MS = 10_000;
export const FILES_RETRY_MS = 60_000;
/** Files a listing holds at most: it is written to disk after each burst. */
export const FILES_LISTING_MAX = 2_000;
const PATHS_LISTED = 10;
/** Distinct paths kept per burst; more only count towards "and N more" through this cap. */
const PATHS_KEPT = 1_000;
export const IGNORED_DIRS: readonly string[] = [".git", "node_modules"];

export interface FilesSourceOptions {
	path: string;
	watch: WatchPath;
	scan: ScanPath;
	context: SourceContext;
}

export function createFilesSource(options: FilesSourceOptions): RoutineSource {
	return new FilesSource(options);
}

class FilesSource implements RoutineSource {
	readonly #path: string;
	readonly #watch: WatchPath;
	readonly #scan: ScanPath;
	readonly #context: SourceContext;
	readonly #report: (key: string, error: unknown | null) => void;
	readonly #changed = new Set<string>();
	/** The last launch's listing until the first one of this launch is compared with it; undefined: none. */
	#before: FilesListing | null | undefined;
	#firstAt = 0;
	#watcher: { close(): void } | null = null;
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#listTimer: ReturnType<typeof setTimeout> | null = null;
	#listing = false;
	/** A change came while a listing was taken: take another after it. */
	#listAgain = false;
	#stopped = false;

	constructor(options: FilesSourceOptions) {
		this.#path = options.path;
		this.#watch = options.watch;
		this.#scan = options.scan;
		this.#context = options.context;
		this.#report = failureReporter(message => options.context.warn(`files ${options.path}: ${message}`));
		this.#before = parseMark(options.context.mark);
		this.#attach();
		void this.#list();
	}

	stop(): void {
		this.#stopped = true;
		this.#detach();
		for (const timer of [this.#flushTimer, this.#retryTimer, this.#listTimer]) clearTimeout(timer ?? undefined);
		this.#flushTimer = null;
		this.#retryTimer = null;
		this.#listTimer = null;
		this.#changed.clear();
	}

	#attach(): void {
		this.#retryTimer = null;
		if (this.#stopped) return;
		try {
			this.#watcher = this.#watch(
				this.#path,
				name => this.#onChange(name),
				error => this.#lost(error),
			);
			this.#report("watch", null);
		} catch (error) {
			this.#lost(error);
		}
	}

	/** The watcher failed or never started: try again in a minute. */
	#lost(error: unknown): void {
		if (this.#stopped) return;
		this.#detach();
		this.#report("watch", error);
		clearTimeout(this.#retryTimer ?? undefined);
		this.#retryTimer = setTimeout(() => this.#attach(), FILES_RETRY_MS);
		this.#retryTimer.unref?.();
	}

	#detach(): void {
		const watcher = this.#watcher;
		this.#watcher = null;
		try {
			watcher?.close();
		} catch {
			// A watcher that is gone already has nothing to close.
		}
	}

	#onChange(filename: string | null): void {
		if (this.#stopped) return;
		const name = (filename ?? "").replaceAll("\\", "/");
		if (name.split("/").some(part => IGNORED_DIRS.includes(part))) return;
		this.#listSoon();
		if (!this.#context.quiet()) this.#note(name);
	}

	/** One more changed name for the burst being gathered. */
	#note(name: string): void {
		if (this.#changed.size >= PATHS_KEPT) return;
		const now = Date.now();
		if (this.#changed.size === 0) this.#firstAt = now;
		this.#changed.add(name);
		clearTimeout(this.#flushTimer ?? undefined);
		const wait = Math.max(0, Math.min(FILES_DEBOUNCE_MS, this.#firstAt + FILES_MAX_WAIT_MS - now));
		this.#flushTimer = setTimeout(() => this.#flush(), wait);
		this.#flushTimer.unref?.();
	}

	#flush(): void {
		this.#flushTimer = null;
		const names = [...this.#changed];
		this.#changed.clear();
		if (this.#stopped || names.length === 0 || this.#context.quiet()) return;
		const listed = names.filter(name => name !== "");
		if (listed.length === 0) {
			this.#context.fire(`Something under ${this.#path} changed`);
			return;
		}
		const more = listed.length - PATHS_LISTED;
		const shown = listed.slice(0, PATHS_LISTED).map(name => clip(name, 200));
		this.#context.fire(`${shown.join(", ")} changed${more > 0 ? `, and ${more} more` : ""}`);
	}

	/** A listing two seconds after the last change, as a burst settles. */
	#listSoon(): void {
		clearTimeout(this.#listTimer ?? undefined);
		this.#listTimer = setTimeout(() => {
			this.#listTimer = null;
			void this.#list();
		}, FILES_DEBOUNCE_MS);
		this.#listTimer.unref?.();
	}

	/** Takes the listing and keeps it as the mark; the first one is compared with the last launch's. */
	async #list(): Promise<void> {
		if (this.#listing) {
			this.#listAgain = true;
			return;
		}
		this.#listing = true;
		try {
			const now = await this.#scan(this.#path);
			if (this.#stopped) return;
			this.#report("list", null);
			const before = this.#before;
			this.#before = undefined;
			this.#context.saveMark({ listing: now });
			if (before !== undefined && !this.#context.quiet())
				for (const name of changedNames(before, now)) this.#note(name);
		} catch (error) {
			if (!this.#stopped) this.#report("list", error);
		} finally {
			this.#listing = false;
			if (this.#listAgain && !this.#stopped) {
				this.#listAgain = false;
				void this.#list();
			}
		}
	}
}

/** The last launch's listing from its mark (JSON from disk): undefined when there is none it can read. */
function parseMark(mark: unknown): FilesListing | null | undefined {
	if (typeof mark !== "object" || mark === null || !("listing" in mark)) return undefined;
	const listing = (mark as { listing: unknown }).listing;
	if (listing === null) return null;
	const { entries, complete } = (listing ?? {}) as { entries?: unknown; complete?: unknown };
	if (typeof entries !== "object" || entries === null || typeof complete !== "boolean") return undefined;
	const kept: Record<string, string> = {};
	for (const [name, stamp] of Object.entries(entries)) if (typeof stamp === "string") kept[name] = stamp;
	return { entries: kept, complete };
}

/** Names added, changed or removed between two listings; "" alone when only "something" can be said. */
export function changedNames(before: FilesListing | null, after: FilesListing | null): string[] {
	if (before === null && after === null) return [];
	if (before === null || after === null) {
		const names = Object.keys((before ?? after)?.entries ?? {});
		return names.length > 0 ? names.toSorted() : [""];
	}
	if (before.complete && after.complete) {
		const names = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
		return [...names].filter(name => before.entries[name] !== after.entries[name]).toSorted();
	}
	const changed = Object.keys(before.entries).filter(
		name => name in after.entries && before.entries[name] !== after.entries[name],
	);
	if (changed.length > 0) return changed.toSorted();
	const beforeNames = Object.keys(before.entries);
	const sameNames =
		beforeNames.length === Object.keys(after.entries).length && beforeNames.every(name => name in after.entries);
	return sameNames ? [] : [""];
}
