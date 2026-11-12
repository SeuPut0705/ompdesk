import { connect } from "node:net";
import { type HubItem, hub } from "./core/hub";
import { CoreError } from "./core/process";

/**
 * Whether this computer can reach the internet right now, as far as a waiting
 * turn is concerned (turn-resume.ts). Electron-free so the state machine is
 * unit-tested: main wires `net.isOnline()`, the renderer's `online`/`offline`
 * events and `powerMonitor` `suspend`/`resume` into it.
 *
 * Three things make a turn wait instead of failing: the network is down, the
 * computer just woke from sleep, or a turn failed to connect while the link
 * looked up and a probe found nothing reachable (a dead DNS or route). Right after
 * a wake `net.isOnline()` can say yes while the Wi-Fi has not rejoined, so a
 * `resume` holds the state at offline until a probe confirms the way out, and a
 * network-class error in the minutes after it is still treated as the wake's doing.
 *
 * A probe resolves the name and opens a connection ({@link reaches}): after a hang on 2 Nov 2026 the resolver
 * answered while every connection was refused, and a lookup-only probe read that as online.
 *
 * A held continuation has no timer of its own: it waits while this says offline. So the
 * offline state must never outlive the outage: besides the events and the wake's probe
 * loop, an offline state that nothing is recovering (a missed `online` event, a `resume`
 * that never arrived) asks again every {@link REPROBE_INTERVAL_MS} and goes
 * online the moment it answers, whatever the link flag says.
 *
 * The state machine lives in the core (`native/ompdesk/crates/core/src/resume/connectivity.rs`, hub kind
 * `connectivity`); this class is its client. What stays here is what main owns: `net.isOnline()` and the clock (read
 * and sent with each call that needs them), the probe (a promise of main's, asked), the timers (main's, they call back)
 * and the `changed` hook. The transport helpers below (`reaches`, `tcpConnects`, `probeTarget`, `answersWithin`) are the
 * probe's own: node's sockets and the proxy setting, wired in `index.ts`.
 *
 * When the core is lost the state is gone with it: a new instance starts from `net.isOnline()` (not recovering, no wake
 * window), the timers it had are cancelled and the probes asked of it answer `false`.
 */

/** A network-class error within this long of a wake still counts as caused by it. */
export const RESUME_WINDOW_MS = 60_000;
/** How often the post-wake probe retries until the network answers. */
export const PROBE_INTERVAL_MS = 2_000;
/** How often an offline state no probe loop is recovering asks again: a held continuation is released within this plus {@link PROBE_TIMEOUT_MS} of the network answering. */
export const REPROBE_INTERVAL_MS = 15_000;
/** A probe that has not answered by then counts as unreachable: a dead route can hold a lookup for tens of seconds. */
export const PROBE_TIMEOUT_MS = 2_500;

/** The probe's answer, or no when it fails or has not answered within `ms`. */
export function answersWithin(answer: Promise<boolean>, ms: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	answer.then(resolve, () => resolve(false));
	return promise.finally(() => clearTimeout(timer));
}

export interface ProbeTarget {
	host: string;
	port: number;
}

/** Where a probe for `host` connects: the proxy the agent's requests go through when one is set, else `host` on HTTPS's port. */
export function probeTarget(host: string, proxyUrl: string | undefined): ProbeTarget {
	if (proxyUrl) {
		try {
			const proxy = new URL(proxyUrl);
			const fallback = proxy.protocol === "https:" ? 443 : proxy.protocol === "http:" ? 80 : 1080;
			if (proxy.hostname) return { host: proxy.hostname, port: Number(proxy.port) || fallback };
		} catch {}
	}
	return { host, port: 443 };
}

export interface TransportDeps {
	/** The addresses `host` resolves to, asking the resolver itself (never its cache). */
	resolve(host: string): Promise<readonly string[]>;
	/** Whether a TCP connection to `address:port` opens. */
	connect(address: string, port: number): Promise<boolean>;
}

/** The name resolves and one of its addresses takes a connection; a failing step is "no". */
export async function reaches(target: ProbeTarget, deps: TransportDeps): Promise<boolean> {
	let addresses: readonly string[];
	try {
		addresses = await deps.resolve(target.host);
	} catch {
		return false;
	}
	const answers = await Promise.all(addresses.slice(0, 2).map(address => deps.connect(address, target.port)));
	return answers.includes(true);
}

/** Whether a TCP connection to `address:port` opens within `ms`; the socket is closed either way. */
export function tcpConnects(address: string, port: number, ms: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host: address, port });
	const finish = (answer: boolean) => {
		socket.destroy();
		resolve(answer);
	};
	socket.setTimeout(ms, () => finish(false));
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	return promise;
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
	#id: number | null = null;
	readonly #timers = new Map<number, () => void>();
	/** The promises `verify` handed out, by the core's token. */
	readonly #tokens = new Map<number, (reachable: boolean) => void>();
	/** A token settled before its caller had it (an item that came inside the call). */
	readonly #settled = new Map<number, boolean>();

	constructor(deps: ConnectivityDeps) {
		this.#deps = deps;
		// The state starts as the link says; a core lost later opens its next instance the same way.
		this.#instance();
	}

	#instance(): number {
		if (this.#id !== null) return this.#id;
		const id = hub().nextId();
		hub().open(
			id,
			"connectivity",
			{ online: this.#deps.isOnline() },
			{
				item: item => this.#item(item),
				ask: (q, item) => this.#ask(q, item),
				lost: () => this.#lost(),
			},
		);
		this.#id = id;
		return id;
	}

	/** One call; a core lost under it opens again and the call is made once more. */
	#call<T>(method: string, params: Record<string, unknown> = {}): T {
		for (let attempt = 0; ; attempt++) {
			try {
				return hub().call<T>(this.#instance(), method, params);
			} catch (error) {
				if (!(error instanceof CoreError) || this.#id !== null || attempt > 0) throw error;
			}
		}
	}

	#lost(): void {
		this.#id = null;
		for (const cancel of this.#timers.values()) cancel();
		this.#timers.clear();
		const tokens = [...this.#tokens.values()];
		this.#tokens.clear();
		for (const settle of tokens) settle(false);
	}

	#item(item: HubItem): void {
		switch (item.k) {
			case "changed":
				this.#deps.changed(item.online as boolean);
				break;
			case "schedule": {
				const timer = item.timer as number;
				const cancel = this.#deps.schedule(() => {
					if (this.#id !== null) this.#call("timer", { timer, isOnline: this.#deps.isOnline() });
				}, item.ms as number);
				this.#timers.set(timer, cancel);
				break;
			}
			// The core let go of a handle without cancelling it (it overwrote it): the cancel function is not kept.
			case "forgetTimer":
				this.#timers.delete(item.timer as number);
				break;
			case "cancelTimer": {
				const timer = item.timer as number;
				this.#timers.get(timer)?.();
				this.#timers.delete(timer);
				break;
			}
			case "done": {
				const token = item.token as number;
				const settle = this.#tokens.get(token);
				if (settle) {
					this.#tokens.delete(token);
					settle(item.value === true);
				} else this.#settled.set(token, item.value === true);
				break;
			}
		}
	}

	#ask(q: string, item: HubItem): unknown {
		if (q !== "probe") throw new Error(`the connectivity monitor has no question ${q}`);
		return this.#deps.probe((item.host ?? undefined) as string | undefined).catch(() => false);
	}

	get online(): boolean {
		return this.#call<boolean>("online");
	}

	/** Offline, or inside the window after a wake: a network-class turn error means "wait", not "failed". */
	shouldWait(): boolean {
		return this.#call<boolean>("shouldWait", { now: this.#deps.now() });
	}

	/** An `online`/`offline` event from a window. */
	report(online: boolean): void {
		this.#call("report", { online, isOnline: this.#deps.isOnline() });
	}

	/** Edge-triggered `net.isOnline()` sampling: only a real change reports, so a window's event is not overruled. */
	poll(): void {
		this.#call("poll", { isOnline: this.#deps.isOnline() });
	}

	/** `powerMonitor` `suspend`: nothing is reachable until the wake is confirmed. */
	suspend(): void {
		this.#call("suspend");
	}

	/** `powerMonitor` `resume`: offline until the probe answers. */
	resume(): void {
		this.#call("resume", { now: this.#deps.now(), isOnline: this.#deps.isOnline() });
	}

	/**
	 * A turn failed to resolve `host` while the link says it is up: a dead DNS or route that `net.isOnline()` never
	 * sees. Unreachable only when neither the default way out nor `host` answers (a mistyped provider URL alone is not
	 * a lost connection); then the state goes offline and the probe loop (a wake's) brings it back as soon as either
	 * answers, so the turn waits for the connection and continues instead of failing. One probe per host answers
	 * every concurrent ask.
	 */
	verify(host?: string): Promise<boolean> {
		const token = this.#call<number>("verify", { host: host ?? null, isOnline: this.#deps.isOnline() });
		const early = this.#settled.get(token);
		if (early !== undefined) {
			this.#settled.delete(token);
			return Promise.resolve(early);
		}
		const { promise, resolve } = Promise.withResolvers<boolean>();
		this.#tokens.set(token, resolve);
		return promise;
	}
}
