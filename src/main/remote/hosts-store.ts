/**
 * The hosts this device paired with (A side): `<userData>/remote-hosts.json`,
 * mode 0600, rewritten atomically on every change. `addresses` is ordered
 * most-recently-working first; the client dials them in order.
 */
import { join } from "node:path";
import { z } from "zod";
import { isRawKey } from "./crypto";
import { readJson, writeSecureJson } from "./secure-file";

export interface PairedHost {
	deviceId: string;
	name: string;
	/** The host's long-term X25519 public key, base64url. */
	staticPub: string;
	/** `host:port` strings, most recently working first. */
	addresses: string[];
	pairedAt: number;
}

/** Addresses kept per host; older ones fall off the end. */
export const MAX_HOST_ADDRESSES = 8;

const StoredHost = z.object({
	deviceId: z.string().min(1),
	name: z.string(),
	staticPub: z.string().refine(isRawKey),
	addresses: z.array(z.string()),
	pairedAt: z.number(),
});
const StoredHosts = z.object({ v: z.literal(1), hosts: z.array(z.unknown()) });

function copy(host: PairedHost): PairedHost {
	return { ...host, addresses: [...host.addresses] };
}

export class HostStore {
	readonly #file: string;
	#hosts: Map<string, PairedHost> | null = null;

	constructor(userData: string) {
		this.#file = join(userData, "remote-hosts.json");
	}

	#load(): Map<string, PairedHost> {
		if (this.#hosts) return this.#hosts;
		this.#hosts = new Map();
		const stored = StoredHosts.safeParse(readJson(this.#file));
		if (stored.success) {
			for (const raw of stored.data.hosts) {
				const host = StoredHost.safeParse(raw);
				if (host.success) this.#hosts.set(host.data.deviceId, host.data);
			}
		}
		return this.#hosts;
	}

	#save(): void {
		writeSecureJson(this.#file, { v: 1, hosts: [...this.#load().values()] });
	}

	list(): PairedHost[] {
		return [...this.#load().values()].map(copy);
	}

	get(deviceId: string): PairedHost | undefined {
		const host = this.#load().get(deviceId);
		return host && copy(host);
	}

	/** Add or replace (re-pair) a host. */
	put(host: PairedHost): void {
		this.#load().set(host.deviceId, copy(host));
		this.#save();
	}

	update(deviceId: string, patch: { name?: string; addresses?: string[] }): PairedHost | undefined {
		const hosts = this.#load();
		const current = hosts.get(deviceId);
		if (!current) return undefined;
		const next = copy({ ...current, ...patch });
		next.addresses = next.addresses.slice(0, MAX_HOST_ADDRESSES);
		hosts.set(deviceId, next);
		this.#save();
		return copy(next);
	}

	/** Move (or add) a working address to the front; no write when it already leads. */
	rememberAddress(deviceId: string, address: string): PairedHost | undefined {
		const current = this.#load().get(deviceId);
		if (!current) return undefined;
		if (current.addresses[0] === address) return copy(current);
		return this.update(deviceId, { addresses: [address, ...current.addresses.filter(a => a !== address)] });
	}

	remove(deviceId: string): boolean {
		if (!this.#load().delete(deviceId)) return false;
		this.#save();
		return true;
	}
}
