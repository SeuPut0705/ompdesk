/**
 * Updating the page, by itself. A new build installs its service worker next to the running one and waits; the
 * page learns of it here and, at a moment the page is not in use (`ResumeGate`: the launch, or a return after
 * being hidden at least `RESUME_AFTER_HIDDEN_MS`, until the first touch or key) that is also safe (`SafeMoment`),
 * tells the waiting worker to take over (`skip-waiting`) and reloads once the new worker controls the page. A host
 * that needs a newer page than the cached one (`hello.minClient`, the transport's `outdated`) takes the other path
 * under the safe-moment rule only (that page can no longer talk to the host): drop the worker and its caches and
 * load from the network. There is no banner and no button: the page comes back to the foreground, or launches,
 * and either nothing is pending or the new build is already there.
 */

/** A page hidden this long and shown again is a new visit: the moment an update may land on it. */
export const RESUME_AFTER_HIDDEN_MS = 30_000;
/** How long such a moment (or the launch) lasts: a worker that finishes installing within it still applies. */
export const RESUME_WINDOW_MS = 15_000;

/**
 * Whether the page is in use. It is not right after it launched or came back after being hidden at least
 * {@link RESUME_AFTER_HIDDEN_MS}, until the user touches, types or wheels (`used`) or {@link RESUME_WINDOW_MS}
 * pass: the person is reading, scrolling or typing from then on, and nothing reloads under them.
 */
export class ResumeGate {
	#openedAt: number | null = null;
	#hiddenAt: number | null = null;

	/** The app has loaded: the first moment. */
	launched(now: number): void {
		this.#openedAt = now;
	}

	hidden(now: number): void {
		this.#hiddenAt ??= now;
		this.#openedAt = null;
	}

	/** The page is visible again; true when it was away long enough to open a new moment. */
	shown(now: number): boolean {
		const away = this.#hiddenAt === null ? 0 : now - this.#hiddenAt;
		this.#hiddenAt = null;
		if (away < RESUME_AFTER_HIDDEN_MS) return false;
		this.#openedAt = now;
		return true;
	}

	/** A touch, a key or a wheel: the page is in use until the next moment. */
	used(): void {
		this.#openedAt = null;
	}

	/** Within a launch or return moment, before any use. */
	open(now: number): boolean {
		return this.#openedAt !== null && now - this.#openedAt < RESUME_WINDOW_MS;
	}
}

/** What the page is doing right now; every reading is live. */
export interface SafeMoment {
	/** The page is in the foreground (a reload of a hidden page is invisible, and the next one is the safe one). */
	visible(): boolean;
	/** Nothing typed or attached in the composer: a reload would lose nothing the user made. */
	draftEmpty(): boolean;
	/** The composer holds pictures: only its text outlives a reload (composer/draft-persistence.ts). */
	attached(): boolean;
	/** A file chooser is open, or the files it handed over are still landing in the page (lib/file-pick.ts). */
	picking(): boolean;
	/** An ask, an approval or a sign-in waits for an answer. */
	askOpen(): boolean;
	/** A file is still on its way to the computer. */
	uploading(): boolean;
	/** Unsaved edits (the Files editor, a host editor or models sheet) or a host dialog is open. */
	editing(): boolean;
}

/**
 * Never mid-typing: only a foreground page with an empty draft, no file pick in progress, no open question, no
 * upload in flight and no unsaved edit or open host dialog.
 */
export function safeToReload(moment: SafeMoment): boolean {
	return (
		moment.visible() &&
		moment.draftEmpty() &&
		!moment.picking() &&
		!moment.askOpen() &&
		!moment.uploading() &&
		!moment.editing()
	);
}

/**
 * Whether a reload now would lose nothing only this page holds: no file pick in progress (a phone hides the page
 * behind its picker, and the page's return is when the files arrive), no picture in the composer, no upload on its
 * way, no unsaved edit or open host dialog. Typed text outlives a reload (draft-persistence.ts) and the host hands
 * open questions back after it.
 */
export function reloadLosesNothing(moment: SafeMoment): boolean {
	return !moment.picking() && !moment.attached() && !moment.uploading() && !moment.editing();
}

/**
 * The last resort after missed events (web-boot.ts: the in-place resync kept failing): reload once nobody uses the
 * page and it would lose nothing — while it is hidden, or at a launch or return moment ({@link ResumeGate}) that is
 * also {@link safeToReload}; never mid-scroll, mid-read, mid-typing or mid-pick. Looks again every `everyMs` and
 * on `recheck` (the page's visibility changes). Returns a cancel.
 */
export function reloadWhenUnused(
	moment: SafeMoment,
	gate: Pick<ResumeGate, "open">,
	reload: () => void,
	options: { now?: () => number; everyMs?: number } = {},
): { recheck: () => void; cancel: () => void } {
	const now = options.now ?? Date.now;
	let done = false;
	const quiet = () => reloadLosesNothing(moment) && (!moment.visible() || (gate.open(now()) && safeToReload(moment)));
	const recheck = () => {
		if (done || !quiet()) return;
		done = true;
		clearInterval(timer);
		reload();
	};
	const timer = setInterval(recheck, options.everyMs ?? 500);
	recheck();
	return {
		recheck,
		cancel: () => {
			done = true;
			clearInterval(timer);
		},
	};
}

/**
 * The page's moment once a chunk error took the whole app down (the root error boundary, lib/chunk-load.ts `appGone`):
 * the composer's typed text no longer holds the page, since the composer saved it when it unmounted
 * (composer/draft-persistence.ts). Everything else still does: pictures are never saved, nor an unsaved edit, a pick
 * or an upload, so a page holding one stays as it is rather than lose it.
 */
export function appGoneMoment(moment: SafeMoment): SafeMoment {
	return { ...moment, draftEmpty: () => true };
}

export interface WorkerLike {
	state: string;
	postMessage(message: unknown): void;
	addEventListener(type: "statechange", listener: () => void): void;
}

export interface RegistrationLike {
	waiting: WorkerLike | null;
	installing: WorkerLike | null;
	addEventListener(type: "updatefound", listener: () => void): void;
	update(): Promise<unknown>;
	unregister(): Promise<boolean>;
}

export interface WorkerContainerLike {
	/** The worker controlling this page; null before the first one claims it. */
	controller: unknown;
	addEventListener(type: "controllerchange", listener: () => void): void;
	getRegistrations?(): Promise<readonly Pick<RegistrationLike, "unregister">[]>;
}

export interface CacheStorageApi {
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
}

export class UpdateWatcher {
	readonly #registration: RegistrationLike;
	readonly #reload: () => void;
	readonly #purge: () => void | Promise<boolean>;
	readonly #listeners = new Set<() => void>();
	#available: boolean;
	#outdated = false;
	#applying = false;

	/**
	 * `purge`: unregister the worker and clear the caches, then load from the network (the `outdated` path). It
	 * resolves false when it left the reload for a later safe moment.
	 */
	constructor(
		registration: RegistrationLike,
		container: WorkerContainerLike,
		reload: () => void,
		purge: () => void | Promise<boolean> = reload,
	) {
		this.#registration = registration;
		this.#reload = reload;
		this.#purge = purge;
		// A worker already waiting, with an older one in control: the page runs the old build.
		this.#available = registration.waiting !== null && container.controller !== null;
		registration.addEventListener("updatefound", () => {
			const worker = registration.installing;
			worker?.addEventListener("statechange", () => {
				if (worker.state === "installed" && container.controller !== null) this.#setAvailable();
			});
		});
		container.addEventListener("controllerchange", () => {
			if (this.#applying) reload();
		});
	}

	get available(): boolean {
		return this.#available;
	}

	/** A build is waiting, or the host asked for a newer page than this one. */
	get pending(): boolean {
		return this.#available || this.#outdated;
	}

	/** The host needs a newer page than the cached one (`outdated`): the next safe moment purges and reloads. */
	markOutdated(): void {
		this.#outdated = true;
	}

	/**
	 * A launch, or the page coming back to the foreground: when something is pending and the moment is safe,
	 * apply it (the purge for an outdated page, else `skip-waiting`). True when it started a reload.
	 */
	resume(moment: SafeMoment): boolean {
		if (this.#applying || !this.pending || !safeToReload(moment)) return false;
		this.#applying = true;
		if (this.#outdated) {
			// The cleanup is async and the page may stop being safe meanwhile: a purge that did not reload leaves the
			// navigation for the next safe moment (its repeat finds the workers and caches gone and only reloads).
			void Promise.resolve(this.#purge()).then(reloaded => {
				if (reloaded === false) this.#applying = false;
			});
		} else this.apply();
		return true;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#setAvailable(): void {
		this.#available = true;
		for (const listener of [...this.#listeners]) listener();
	}

	/** Ask the browser whether `/sw.js` changed (a page coming back to the foreground). Never throws. */
	async check(): Promise<void> {
		try {
			await this.#registration.update();
		} catch {
			// Offline: the next check will do.
		}
	}

	/** Let the waiting worker take over; the page reloads when it does (or at once when none waits). */
	apply(): void {
		const waiting = this.#registration.waiting;
		if (!waiting) {
			this.#reload();
			return;
		}
		this.#applying = true;
		waiting.postMessage({ type: "skip-waiting" });
	}
}

/** How long the purge's cleanup may take before the page reloads anyway (WebKit has left a cache delete unsettled). */
export const PURGE_CLEANUP_MS = 3000;

/**
 * Unregister the workers, delete every cache and load the page from the network. The cleanup is bounded by
 * `cleanupMs`: a cleanup that fails or never settles must not keep the page on a build that no longer works (the
 * worker is unregistered first, so the reload reaches the network even when a cache is left behind).
 */
export async function purgeAndReload(
	container: Pick<WorkerContainerLike, "getRegistrations"> | undefined,
	cacheStorage: CacheStorageApi | undefined,
	reload: () => void,
	safe: () => boolean = () => true,
	cleanupMs = PURGE_CLEANUP_MS,
): Promise<boolean> {
	const cleanup = (async () => {
		const registrations = (await container?.getRegistrations?.()) ?? [];
		await Promise.all(registrations.map(registration => registration.unregister()));
		if (cacheStorage) await Promise.all((await cacheStorage.keys()).map(name => cacheStorage.delete(name)));
	})().catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([cleanup, new Promise<void>(resolve => (timer = setTimeout(resolve, cleanupMs)))]);
	clearTimeout(timer);
	if (!safe()) return false;
	reload();
	return true;
}
