/**
 * The files trigger of a routine: a file or folder (with everything under it) is watched, and a burst of changes
 * fires the routine once, two seconds after the last change (at most ten after the first, so a steady stream still
 * fires). `.git/` and `node_modules/` are never news. Changes made while the routine's own run goes, and for
 * `ROUTINE_QUIET_MS` after it ended, are its own writes and fire nothing (the loop guard: a routine that edits the
 * folder it watches would start itself again). A path that does not exist, or whose watcher failed, is watched
 * again every minute and fires nothing meanwhile.
 */
import { clip, failureReporter, type RoutineSource, type SourceContext } from "./source";

/** Starts watching `path` recursively; throws when it cannot (a missing path). `onError` ends the watch. */
export type WatchPath = (
	path: string,
	onChange: (filename: string | null) => void,
	onError: (error: Error) => void,
) => { close(): void };

export const FILES_DEBOUNCE_MS = 2_000;
export const FILES_MAX_WAIT_MS = 10_000;
export const FILES_RETRY_MS = 60_000;
const PATHS_LISTED = 10;
/** Distinct paths kept per burst; more only count towards "and N more" through this cap. */
const PATHS_KEPT = 1_000;
const IGNORED_DIRS = [".git", "node_modules"];

export interface FilesSourceOptions {
	path: string;
	watch: WatchPath;
	context: SourceContext;
}

export function createFilesSource(options: FilesSourceOptions): RoutineSource {
	return new FilesSource(options);
}

class FilesSource implements RoutineSource {
	readonly #path: string;
	readonly #watch: WatchPath;
	readonly #context: SourceContext;
	readonly #report: (key: string, error: unknown | null) => void;
	readonly #changed = new Set<string>();
	#firstAt = 0;
	#watcher: { close(): void } | null = null;
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;

	constructor(options: FilesSourceOptions) {
		this.#path = options.path;
		this.#watch = options.watch;
		this.#context = options.context;
		this.#report = failureReporter(message => options.context.warn(`files ${options.path}: ${message}`));
		this.#attach();
	}

	stop(): void {
		this.#stopped = true;
		this.#detach();
		clearTimeout(this.#flushTimer ?? undefined);
		clearTimeout(this.#retryTimer ?? undefined);
		this.#flushTimer = null;
		this.#retryTimer = null;
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
		if (this.#stopped || this.#context.quiet()) return;
		const name = (filename ?? "").replaceAll("\\", "/");
		if (name.split("/").some(part => IGNORED_DIRS.includes(part))) return;
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
}
