/**
 * The host's paired devices (B side): `<userData>/remote-peers.json`, mode
 * 0600, rewritten atomically on every change. Removing a peer is revoking it:
 * its next auth attempt is refused as unpaired.
 */
import { join } from "node:path";
import { z } from "zod";
import { isRawKey } from "./crypto";
import { readJson, writeSecureJson } from "./secure-file";

export interface PeerInfo {
	deviceId: string;
	name: string;
	/** The peer's long-term X25519 public key, base64url. */
	staticPub: string;
	pairedAt: number;
	/** Last authenticated connect or disconnect. */
	lastSeenAt?: number;
}

const StoredPeer = z.object({
	deviceId: z.string().min(1),
	name: z.string(),
	staticPub: z.string().refine(isRawKey),
	pairedAt: z.number(),
	lastSeenAt: z.number().optional(),
});
const StoredPeers = z.object({ v: z.literal(1), peers: z.array(z.unknown()) });

export class PeerStore {
	readonly #file: string;
	#peers: Map<string, PeerInfo> | null = null;

	constructor(userData: string) {
		this.#file = join(userData, "remote-peers.json");
	}

	#load(): Map<string, PeerInfo> {
		if (this.#peers) return this.#peers;
		this.#peers = new Map();
		const stored = StoredPeers.safeParse(readJson(this.#file));
		if (stored.success) {
			for (const raw of stored.data.peers) {
				const peer = StoredPeer.safeParse(raw);
				if (peer.success) this.#peers.set(peer.data.deviceId, peer.data);
			}
		}
		return this.#peers;
	}

	#save(): void {
		writeSecureJson(this.#file, { v: 1, peers: [...this.#load().values()] });
	}

	list(): PeerInfo[] {
		return [...this.#load().values()].map(peer => ({ ...peer }));
	}

	get(deviceId: string): PeerInfo | undefined {
		const peer = this.#load().get(deviceId);
		return peer && { ...peer };
	}

	/** Add or replace (re-pair) a peer. */
	put(peer: PeerInfo): void {
		this.#load().set(peer.deviceId, { ...peer });
		this.#save();
	}

	update(deviceId: string, patch: { name?: string; lastSeenAt?: number }): PeerInfo | undefined {
		const peers = this.#load();
		const current = peers.get(deviceId);
		if (!current) return undefined;
		const next = { ...current, ...patch };
		peers.set(deviceId, next);
		this.#save();
		return { ...next };
	}

	remove(deviceId: string): boolean {
		if (!this.#load().delete(deviceId)) return false;
		this.#save();
		return true;
	}
}
