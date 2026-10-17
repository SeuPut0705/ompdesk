/**
 * Updating the page, by itself. A new build installs its service worker next to the running one and waits; the
 * page learns of it here and, at a safe moment (`SafeMoment`), tells the waiting worker to take over
 * (`skip-waiting`) and reloads once the new worker controls the page. A host that needs a newer page than the
 * cached one (`hello.minClient`, the transport's `outdated`) takes the other path under the same rule: drop
 * the worker and its caches and load from the network. There is no banner and no button: the page comes back
 * to the foreground, or launches, and either nothing is pending or the new build is already there.
 */

/** What the page is doing right now; every reading is live. */
export interface SafeMoment {
	/** The page is in the foreground (a reload of a hidden page is invisible, and the next one is the safe one). */
	visible(): boolean;
	/** Nothing typed or attached in the composer: a reload would lose nothing the user made. */
	draftEmpty(): boolean;
	/** An ask, an approval or a sign-in waits for an answer. */
	askOpen(): boolean;
	/** A file is still on its way to the computer. */
	uploading(): boolean;
}

/** Never mid-typing: only a foreground page with an empty draft, no open question and no upload in flight. */
export function safeToReload(moment: SafeMoment): boolean {
	return moment.visible() && moment.draftEmpty() && !moment.askOpen() && !moment.uploading();
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
	readonly #purge: () => void;
	readonly #listeners = new Set<() => void>();
	#available: boolean;
	#outdated = false;
	#applying = false;

	/** `purge`: unregister the worker and clear the caches, then load from the network (the `outdated` path). */
	constructor(
		registration: RegistrationLike,
		container: WorkerContainerLike,
		reload: () => void,
		purge: () => void = reload,
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
		if (this.#outdated) this.#purge();
		else this.apply();
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

/** Unregister the workers, delete every cache and load the page from the network. */
export async function purgeAndReload(
	container: Pick<WorkerContainerLike, "getRegistrations"> | undefined,
	cacheStorage: CacheStorageApi | undefined,
	reload: () => void,
): Promise<void> {
	try {
		const registrations = (await container?.getRegistrations?.()) ?? [];
		await Promise.all(registrations.map(registration => registration.unregister()));
		if (cacheStorage) await Promise.all((await cacheStorage.keys()).map(name => cacheStorage.delete(name)));
	} catch {
		// A blocked cleanup must not stop the reload the user asked for.
	}
	reload();
}
