/**
 * Devices the user blocked: `<userData>/web-blocked.json` (mode 0600), kept by the core
 * (`native/ompdesk/crates/core/src/web/store.rs`) where the web edge checks every visitor against it. A device
 * connects on its own the first time it opens the page, so forgetting its record would let the next visit make a
 * new one; a block is what keeps it out. It keys on the device's Tailscale node (`tailscale whois`' stable ID),
 * never on the login, since one login has many devices. Serve may give no node identity (whois missing or failing):
 * the device is then blocked by its login, which blocks every device of that login, and Settings says so.
 *
 * `WebBlocks` keeps a copy for the computer-sharing gate, which asks in the same tick (`check`); a change updates
 * the copy at once and goes to the core as an ordered push (`web-stores-client.ts`). Call `ready()` before reading:
 * until the core's list is in, nothing is blocked.
 */
import type { WebBlockedInfo, WebBlockScope } from "../../shared/mobile-web";
import { acquireChannel, releaseChannel, type StoresChannel } from "./web-stores-client";

export function nodeBlockId(nodeId: string): string {
	return `node:${nodeId}`;
}

export function loginBlockId(login: string): string {
	return `login:${login.trim().toLowerCase()}`;
}

/** Who a visitor is, as far as serve and whois say. */
export interface Visitor {
	nodeId: string | null;
	login: string | null;
}

/**
 * - an entry: the visitor's node, or its whole login, is blocked;
 * - `unidentified`: the node could not be told, and this login has a blocked node, so it cannot be ruled out;
 * - null: not blocked.
 */
export type BlockVerdict = WebBlockedInfo | "unidentified" | null;

export class WebBlocks {
	readonly #channel: StoresChannel;
	readonly #now: () => number;

	constructor(userData: string, now: () => number = Date.now) {
		this.#channel = acquireChannel(userData);
		this.#now = now;
	}

	/** Resolves once the core's list is in. */
	ready(): Promise<void> {
		return this.#channel.ready();
	}

	/** Resolves once every change made so far is on disk. */
	flush(): Promise<void> {
		return this.#channel.flush();
	}

	/** Lets go of the core's list; the copy goes with the last holder. */
	close(): void {
		releaseChannel(this.#channel);
	}

	onChanged(listener: () => void): () => void {
		this.#channel.blocksListeners.add(listener);
		return () => this.#channel.blocksListeners.delete(listener);
	}

	list(): WebBlockedInfo[] {
		return this.#channel.blocks.list.map(entry => ({ ...entry }));
	}

	/** Block a node (`nodeId`) or, with none, every device of `login`; a block of the same key is replaced. */
	add(input: { scope: WebBlockScope; key: string; name: string; tailscaleLogin: string | null }): WebBlockedInfo {
		const id = input.scope === "node" ? nodeBlockId(input.key) : loginBlockId(input.key);
		const entry: WebBlockedInfo = {
			id,
			scope: input.scope,
			name: input.name,
			tailscaleLogin: input.tailscaleLogin,
			blockedAt: this.#now(),
		};
		this.#channel.blocks.list = [...this.#channel.blocks.list.filter(other => other.id !== id), entry];
		this.#channel.pushBlocks("add", {
			scope: input.scope,
			key: input.key,
			name: input.name,
			tailscaleLogin: input.tailscaleLogin,
			now: entry.blockedAt,
		});
		this.#changed();
		return { ...entry };
	}

	remove(id: string): boolean {
		const entries = this.#channel.blocks.list;
		if (!entries.some(entry => entry.id === id)) return false;
		this.#channel.blocks.list = entries.filter(entry => entry.id !== id);
		this.#channel.pushBlocks("remove", { id });
		this.#changed();
		return true;
	}

	check(visitor: Visitor): BlockVerdict {
		const entries = this.#channel.blocks.list;
		const login = visitor.login?.trim().toLowerCase() ?? null;
		for (const entry of entries) {
			if (entry.scope === "login" && login !== null && entry.id === loginBlockId(login)) return { ...entry };
			if (entry.scope === "node" && visitor.nodeId !== null && entry.id === nodeBlockId(visitor.nodeId)) {
				return { ...entry };
			}
		}
		if (visitor.nodeId === null && login !== null) {
			if (entries.some(entry => entry.scope === "node" && entry.tailscaleLogin?.trim().toLowerCase() === login)) {
				return "unidentified";
			}
		}
		return null;
	}

	/** Whether any block exists: a page load then asks who the visitor is. */
	get active(): boolean {
		return this.#channel.blocks.list.length > 0;
	}

	#changed(): void {
		for (const listener of [...this.#channel.blocksListeners]) listener();
	}
}
