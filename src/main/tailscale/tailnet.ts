/**
 * Read-only Tailscale facts for sharing this computer with other OMPdesk computers (src/main/remote/): the tailnet
 * (`status --json`: this machine's addresses, the other nodes) and who an address belongs to (`whois`). Works
 * whether or not Mobile web is on; never changes Tailscale. The caches (a status for 3 s, a successful whois for a
 * minute, one read shared by callers that ask together), the address test and the CLI runs are the core process's
 * (`native/ompdesk/crates/core/src/remote/tailnet.rs`); this file is its typed client. What stays here is the one
 * thing only main knows: where the Tailscale CLI is. The core asks (`remote.ask` `locate`) the first time it needs
 * it, and again while it finds none; main answers how to run it, as `cli.ts` hands it over with every request.
 */
import { CORE_EXITED, CoreError, core } from "../core/process";
import { onCoreAsk } from "../remote/core-asks";
import { runRules } from "./cli";
import type { LocatedTailscale } from "./locate";
import type { TailscaleStatus } from "./status";
import type { TailnetPeer } from "./whois";

export const STATUS_CACHE_MS = 3_000;
export const WHOIS_CACHE_MS = 60_000;
export const WHOIS_CACHE_MAX = 256;

/**
 * How long a call to the core may take: a lookup of the CLI (main asked, which may run `plutil` and read the login
 * shell's PATH), then the CLI's own ceiling of 10 s, past the default of 30 s only when both are slow.
 */
const CORE_WAIT_MS = 45_000;

/** Where sharing stands on this computer's Tailscale side. */
export type TailnetPhase = "not-installed" | "not-running" | "needs-login" | "ready";

export interface TailnetDeps {
	locate: () => Promise<LocatedTailscale | null>;
	/** This client's clock for the caches (a test moves it); the core's own when none is given. */
	now?: () => number;
}

/** How the core runs the CLI: what `cli.ts` hands every `tailscale.*` request. */
interface CliRunner {
	bin: string;
	args: string[];
	env: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
}

export class Tailnet {
	/** Each instance the core holds, by its number: the core's `locate` asks name one. */
	static readonly #live = new Map<number, Tailnet>();
	static #routed = false;

	readonly #deps: TailnetDeps;
	#id: Promise<number> | null = null;

	constructor(deps: TailnetDeps) {
		this.#deps = deps;
	}

	/** Answers the core's `locate` asks for whichever instance asked; null (no Tailscale) when none can. */
	static #route(): void {
		if (Tailnet.#routed) return;
		Tailnet.#routed = true;
		onCoreAsk(
			"locate",
			ask => {
				const tailnet = Tailnet.#live.get(Number(ask.tailnet));
				return tailnet ? tailnet.#locate() : null;
			},
			null,
		);
		core().on(CORE_EXITED, () => {
			// The numbers died with the core: each instance opens a new one when next used.
			for (const tailnet of Tailnet.#live.values()) tailnet.#id = null;
			Tailnet.#live.clear();
		});
	}

	/** This instance's number in the core, opened on first use. */
	coreId(): Promise<number> {
		if (!this.#id) {
			Tailnet.#route();
			const opened = core()
				.call<{ tailnet: number }>("remote.tailnet.open", {})
				.then(answer => {
					Tailnet.#live.set(answer.result.tailnet, this);
					return answer.result.tailnet;
				});
			this.#id = opened;
			opened.catch(() => {
				if (this.#id === opened) this.#id = null;
			});
		}
		return this.#id;
	}

	/** How the core runs the CLI, or null when none is installed. */
	async #locate(): Promise<CliRunner | null> {
		let located: LocatedTailscale | null;
		try {
			located = await this.#deps.locate();
		} catch {
			return null;
		}
		if (!located) return null;
		const rules = runRules();
		return {
			bin: located.path,
			args: [],
			env: { ...rules.env, ...located.env },
			timeoutMs: rules.timeoutMs,
			maxBytes: rules.maxBytes,
		};
	}

	/** One request to the core about this instance; `fallback` when the core cannot answer. */
	async #ask<T>(method: string, params: object, fallback: T): Promise<T> {
		const now = this.#deps.now;
		const nowMs = now ? { nowMs: Math.floor(now()) } : {};
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					const tailnet = await this.coreId();
					return (await core().call<T>(method, { tailnet, ...params, ...nowMs }, { timeoutMs: CORE_WAIT_MS }))
						.result;
				} catch (error) {
					// A core that restarted since the number was given knows no such instance: open again, once.
					if (attempt === 0 && error instanceof CoreError && error.code === "no_tailnet") {
						this.#id = null;
						continue;
					}
					throw error;
				}
			}
		} catch (error) {
			// A core that cannot answer reads as a CLI that did not.
			if (error instanceof CoreError) return fallback;
			throw error;
		}
	}

	/** The status document, or null when Tailscale is missing or does not answer. */
	status(): Promise<TailscaleStatus | null> {
		return this.#ask<TailscaleStatus | null>("remote.tailnet.status", {}, null);
	}

	/** Where sharing stands: Tailscale missing, not answering, signed out, or up. */
	phase(): Promise<TailnetPhase> {
		return this.#ask<TailnetPhase>("remote.tailnet.phase", {}, "not-running");
	}

	/** Which node and user `ip` belongs to; null when it is no address, or Tailscale cannot say. */
	whois(ip: string): Promise<TailnetPeer | null> {
		return this.#ask<TailnetPeer | null>("remote.tailnet.whois", { ip }, null);
	}
}
