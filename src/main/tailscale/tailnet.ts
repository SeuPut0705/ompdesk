/**
 * Read-only Tailscale facts for sharing this computer with other OMPdesk computers (src/main/remote/): the tailnet
 * (`status --json`: this machine's addresses, the other nodes) and who an address belongs to (`whois`). Works
 * whether or not Mobile web is on; never changes Tailscale. Answers are cached briefly: a status for 3 s (a
 * connection and a list refresh share one), a successful whois for 60 s (one per connection would cost a CLI
 * call each).
 */
import { isIP } from "node:net";
import { TailscaleCli, type TailscaleExecutor } from "./cli";
import type { LocatedTailscale } from "./locate";
import { parseStatus, type TailscaleStatus } from "./status";
import { parseWhois, type TailnetPeer } from "./whois";

export const STATUS_CACHE_MS = 3_000;
export const WHOIS_CACHE_MS = 60_000;
export const WHOIS_CACHE_MAX = 256;

/** Where sharing stands on this computer's Tailscale side. */
export type TailnetPhase = "not-installed" | "not-running" | "needs-login" | "ready";

/** A tailnet address: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip: string): boolean {
	const address = ip.replace(/^::ffff:/i, "");
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return a === 100 && b !== undefined && b >= 64 && b <= 127;
	}
	return isIP(address) === 6 && /^fd7a:115c:a1e0:/i.test(address);
}

export interface TailnetDeps {
	locate: () => Promise<LocatedTailscale | null>;
	exec: TailscaleExecutor;
	now?: () => number;
}

export class Tailnet {
	readonly #deps: TailnetDeps;
	readonly #now: () => number;
	readonly #whois = new Map<string, { peer: TailnetPeer; at: number }>();
	#cli: Promise<TailscaleCli | null> | null = null;
	#status: { value: TailscaleStatus | null; installed: boolean; at: number } | null = null;
	#pending: Promise<TailscaleStatus | null> | null = null;

	constructor(deps: TailnetDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
	}

	/** The status document, or null when Tailscale is missing or does not answer. */
	async status(): Promise<TailscaleStatus | null> {
		const cached = this.#status;
		if (cached && this.#now() - cached.at < STATUS_CACHE_MS) return cached.value;
		this.#pending ??= this.#readStatus().finally(() => {
			this.#pending = null;
		});
		return this.#pending;
	}

	async #readStatus(): Promise<TailscaleStatus | null> {
		const cli = await this.#cliOrNull();
		const result = cli ? await cli.status() : null;
		const value = result && result.code === 0 ? parseStatus(result.stdout) : null;
		this.#status = { value, installed: cli !== null, at: this.#now() };
		return value;
	}

	/** Where sharing stands: Tailscale missing, not answering, signed out, or up. */
	async phase(): Promise<TailnetPhase> {
		const status = await this.status();
		if (status?.backend === "running") return "ready";
		if (this.#status?.installed === false) return "not-installed";
		if (status?.backend === "needs-login") return "needs-login";
		return "not-running";
	}

	/** Which node and user `ip` belongs to; null when it is no address, or Tailscale cannot say. */
	async whois(ip: string): Promise<TailnetPeer | null> {
		const address = ip.replace(/^::ffff:/i, "");
		if (isIP(address) === 0) return null;
		const cached = this.#whois.get(address);
		if (cached && this.#now() - cached.at < WHOIS_CACHE_MS) return cached.peer;
		const cli = await this.#cliOrNull();
		if (!cli) return null;
		const result = await cli.whois(address);
		const peer = result.code === 0 ? parseWhois(result.stdout) : null;
		if (!peer) return null;
		if (this.#whois.size >= WHOIS_CACHE_MAX) this.#whois.clear();
		this.#whois.set(address, { peer, at: this.#now() });
		return peer;
	}

	/** Located once; a missing CLI is looked for again next time (it may have been installed meanwhile). */
	#cliOrNull(): Promise<TailscaleCli | null> {
		this.#cli ??= this.#deps
			.locate()
			.then(located => (located ? new TailscaleCli(located, this.#deps.exec) : null))
			.catch(() => null);
		const cli = this.#cli;
		void cli.then(found => {
			if (!found && this.#cli === cli) this.#cli = null;
		});
		return cli;
	}
}
