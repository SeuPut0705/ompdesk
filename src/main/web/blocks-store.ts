/**
 * Devices the user blocked: `<userData>/web-blocked.json` (mode 0600, written atomically). A device connects on
 * its own the first time it opens the page, so forgetting its record would let the next visit make a new one;
 * a block is what keeps it out. It keys on the device's Tailscale node (`tailscale whois`' stable ID), never on
 * the login, since one login has many devices. Serve may give no node identity (whois missing or failing): the
 * device is then blocked by its login, which blocks every device of that login, and Settings says so.
 */
import { join } from "node:path";
import { z } from "zod";
import type { WebBlockedInfo, WebBlockScope } from "../../shared/mobile-web";
import { readJson, writeSecureJson } from "../remote/secure-file";

const Entry = z.object({
	id: z.string().min(1),
	scope: z.enum(["node", "login"]),
	name: z.string(),
	tailscaleLogin: z.string().nullable(),
	blockedAt: z.number(),
});
const Stored = z.object({ v: z.literal(1), blocked: z.array(Entry) });

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
	readonly #file: string;
	readonly #now: () => number;
	readonly #onChanged = new Set<() => void>();
	#entries: WebBlockedInfo[] | null = null;

	constructor(userData: string, now: () => number = Date.now) {
		this.#file = join(userData, "web-blocked.json");
		this.#now = now;
	}

	onChanged(listener: () => void): () => void {
		this.#onChanged.add(listener);
		return () => this.#onChanged.delete(listener);
	}

	list(): WebBlockedInfo[] {
		return this.#load().map(entry => ({ ...entry }));
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
		this.#save([...this.#load().filter(other => other.id !== id), entry]);
		return { ...entry };
	}

	remove(id: string): boolean {
		const entries = this.#load();
		if (!entries.some(entry => entry.id === id)) return false;
		this.#save(entries.filter(entry => entry.id !== id));
		return true;
	}

	check(visitor: Visitor): BlockVerdict {
		const entries = this.#load();
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
		return this.#load().length > 0;
	}

	#load(): WebBlockedInfo[] {
		if (this.#entries) return this.#entries;
		const stored = Stored.safeParse(readJson(this.#file));
		this.#entries = stored.success ? stored.data.blocked : [];
		return this.#entries;
	}

	#save(entries: WebBlockedInfo[]): void {
		writeSecureJson(this.#file, { v: 1, blocked: entries });
		this.#entries = entries;
		for (const listener of this.#onChanged) listener();
	}
}
