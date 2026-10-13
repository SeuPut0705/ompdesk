/**
 * The hosts this device paired with (A side): `<userData>/remote-hosts.json`,
 * mode 0600, rewritten atomically on every change. `addresses` is ordered
 * most-recently-working first; the client dials them in order.
 */
import { join } from "node:path";
import { z } from "zod";
import { isRawKey } from "./crypto";
import { TrustStore } from "./trust-store";

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

function copy(host: PairedHost): PairedHost {
	return { ...host, addresses: [...host.addresses] };
}

export class HostStore extends TrustStore<PairedHost> {
	constructor(userData: string) {
		super(join(userData, "remote-hosts.json"), "hosts", StoredHost, copy);
	}

	override update(deviceId: string, patch: Partial<Omit<PairedHost, "deviceId">>): PairedHost | undefined {
		const current = this.get(deviceId);
		if (!current) return undefined;
		const addresses = (patch.addresses ?? current.addresses).slice(0, MAX_HOST_ADDRESSES);
		return super.update(deviceId, { ...patch, addresses });
	}

	/** Move (or add) a working address to the front; no write when it already leads. */
	rememberAddress(deviceId: string, address: string): PairedHost | undefined {
		const current = this.get(deviceId);
		if (!current || current.addresses[0] === address) return current;
		return this.update(deviceId, { addresses: [address, ...current.addresses.filter(a => a !== address)] });
	}
}
