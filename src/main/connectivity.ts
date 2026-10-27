/**
 * Whether this computer can reach the internet right now, as far as a waiting
 * turn is concerned (turn-resume.ts). Electron-free so the state machine is
 * unit-tested: main wires `net.isOnline()`, the renderer's `online`/`offline`
 * events and `powerMonitor` `suspend`/`resume` into it.
 *
 * Three things make a turn wait instead of failing: the network is down, the
 * computer just woke from sleep, or a turn failed on the network while the link
 * looked up and a probe found nothing reachable (a dead DNS or route). Right after
 * a wake `net.isOnline()` can say yes while the Wi-Fi has not rejoined, so a
 * `resume` holds the state at offline until a probe confirms the way out, and a
 * network-class error in the minutes after it is still treated as the wake's doing.
 */

/** A network-class error within this long of a wake still counts as caused by it. */
export const RESUME_WINDOW_MS = 60_000;
/** How often the post-wake probe retries until the network answers. */
export const PROBE_INTERVAL_MS = 2_000;

export interface ConnectivityDeps {
	/** Chromium's own verdict (`net.isOnline()`). */
	isOnline(): boolean;
	/** A cheap reachability check, run only while recovering from sleep. */
	probe(): Promise<boolean>;
	now(): number;
	/** Run `run` after `ms`; returns the cancel. */
	schedule(run: () => void, ms: number): () => void;
	/** The online state changed. */
	changed(online: boolean): void;
}

export class ConnectivityMonitor {
	readonly #deps: ConnectivityDeps;
	#online: boolean;
	#polled: boolean;
	#resumedAt: number | null = null;
	#recovering = false;
	#cancelProbe: (() => void) | null = null;
	#probing = false;
	#verifying: Promise<boolean> | null = null;

	constructor(deps: ConnectivityDeps) {
		this.#deps = deps;
		this.#online = deps.isOnline();
		this.#polled = this.#online;
	}

	get online(): boolean {
		return this.#online;
	}

	/** Offline, or inside the window after a wake: a network-class turn error means "wait", not "failed". */
	shouldWait(): boolean {
		if (!this.#online) return true;
		return this.#resumedAt !== null && this.#deps.now() - this.#resumedAt < RESUME_WINDOW_MS;
	}

	/** An `online`/`offline` event from a window. */
	report(online: boolean): void {
		if (!online) {
			this.#set(false);
			return;
		}
		// While recovering from sleep the probe decides, not the first optimistic event.
		if (this.#recovering) void this.#attempt();
		else this.#set(true);
	}

	/** Edge-triggered `net.isOnline()` sampling: only a real change reports, so a window's event is not overruled. */
	poll(): void {
		const now = this.#deps.isOnline();
		if (now === this.#polled) return;
		this.#polled = now;
		this.report(now);
	}

	/** `powerMonitor` `suspend`: nothing is reachable until the wake is confirmed. */
	suspend(): void {
		this.#recovering = false;
		this.#stopProbe();
		this.#set(false);
	}

	/** `powerMonitor` `resume`: offline until the probe answers. */
	resume(): void {
		this.#resumedAt = this.#deps.now();
		this.#recovering = true;
		this.#set(false);
		void this.#attempt();
	}

	/**
	 * A turn failed on the network while the link says it is up: a dead DNS or route that `net.isOnline()` never
	 * sees. One probe answers every concurrent ask; unreachable takes the state offline and the probe loop (a wake's)
	 * brings it back, so the turn waits for the connection and continues instead of failing.
	 */
	verify(): Promise<boolean> {
		if (!this.#online) return Promise.resolve(false);
		this.#verifying ??= this.#check().finally(() => {
			this.#verifying = null;
		});
		return this.#verifying;
	}

	async #check(): Promise<boolean> {
		let reachable = false;
		try {
			reachable = this.#deps.isOnline() && (await this.#deps.probe());
		} catch {
			reachable = false;
		}
		if (!this.#online) return false;
		if (reachable) return true;
		if (!this.#recovering) {
			this.#recovering = true;
			this.#set(false);
			if (!this.#probing) this.#cancelProbe = this.#deps.schedule(() => void this.#attempt(), PROBE_INTERVAL_MS);
		}
		return false;
	}

	#set(online: boolean): void {
		if (online === this.#online) return;
		this.#online = online;
		this.#deps.changed(online);
	}

	#stopProbe(): void {
		this.#cancelProbe?.();
		this.#cancelProbe = null;
	}

	async #attempt(): Promise<void> {
		if (this.#probing) return;
		this.#probing = true;
		this.#stopProbe();
		let reachable = false;
		try {
			reachable = this.#deps.isOnline() && (await this.#deps.probe());
		} catch {
			reachable = false;
		} finally {
			this.#probing = false;
		}
		if (!this.#recovering) return;
		if (reachable) {
			this.#recovering = false;
			this.#set(true);
			return;
		}
		this.#cancelProbe = this.#deps.schedule(() => void this.#attempt(), PROBE_INTERVAL_MS);
	}
}
