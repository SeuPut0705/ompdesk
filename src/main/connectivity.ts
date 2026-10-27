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
/** A probe that has not answered by then counts as unreachable: a dead route can hold a lookup for tens of seconds. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Whether `lookup` succeeds within `ms`; a rejection or the deadline is "no". */
export function answersWithin(lookup: Promise<unknown>, ms: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	lookup.then(
		() => resolve(true),
		() => resolve(false),
	);
	return promise.finally(() => clearTimeout(timer));
}

export interface ConnectivityDeps {
	/** Chromium's own verdict (`net.isOnline()`). */
	isOnline(): boolean;
	/** A cheap reachability check: the default way out, or `host` (the one a failed turn could not resolve). */
	probe(host?: string): Promise<boolean>;
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
	#verifying = new Map<string, Promise<boolean>>();
	/** The host whose failed lookup took the state offline: the recovery probe asks it beside the default. */
	#probeHost: string | undefined;

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
		this.#probeHost = undefined;
		this.#stopProbe();
		this.#set(false);
	}

	/** `powerMonitor` `resume`: offline until the probe answers. */
	resume(): void {
		this.#resumedAt = this.#deps.now();
		this.#probeHost = undefined;
		this.#recovering = true;
		this.#set(false);
		void this.#attempt();
	}

	/**
	 * A turn failed to resolve `host` while the link says it is up: a dead DNS or route that `net.isOnline()` never
	 * sees. Unreachable only when neither the default way out nor `host` answers (a mistyped provider URL alone is not
	 * a lost connection); then the state goes offline and the probe loop (a wake's) brings it back as soon as either
	 * answers, so the turn waits for the connection and continues instead of failing. One probe per host answers
	 * every concurrent ask.
	 */
	verify(host?: string): Promise<boolean> {
		if (!this.#online) return Promise.resolve(false);
		const key = host ?? "";
		let pending = this.#verifying.get(key);
		if (!pending) {
			pending = this.#check(host).finally(() => this.#verifying.delete(key));
			this.#verifying.set(key, pending);
		}
		return pending;
	}

	async #check(host: string | undefined): Promise<boolean> {
		const reachable = await this.#reachable(host);
		if (!this.#online) return false;
		if (reachable) return true;
		if (!this.#recovering) {
			this.#recovering = true;
			this.#probeHost = host;
			this.#set(false);
			if (!this.#probing) this.#cancelProbe = this.#deps.schedule(() => void this.#attempt(), PROBE_INTERVAL_MS);
		}
		return false;
	}

	/** The link is up and the default way out or `host` answers; a throwing probe is no answer. */
	async #reachable(host: string | undefined): Promise<boolean> {
		if (!this.#deps.isOnline()) return false;
		const ask = (target?: string) => this.#deps.probe(target).catch(() => false);
		const answers = await Promise.all(host ? [ask(), ask(host)] : [ask()]);
		return answers.includes(true);
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
			reachable = await this.#reachable(this.#probeHost);
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
