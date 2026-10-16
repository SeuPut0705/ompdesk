/**
 * Updating the page. A new build installs its service worker next to the running one and waits; the page
 * learns of it here, shows "Update available — Reload", and on the user's choice tells the waiting worker to
 * take over (`skip-waiting`) and reloads once the new worker controls the page. A host that needs a newer
 * page than the cached one (`hello.minClient`, the transport's `outdated`) takes the other path: drop the
 * worker and its caches and load from the network.
 */

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
	readonly #listeners = new Set<() => void>();
	#available: boolean;
	#applying = false;

	constructor(registration: RegistrationLike, container: WorkerContainerLike, reload: () => void) {
		this.#registration = registration;
		this.#reload = reload;
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
