/**
 * The host's paired devices (B side): `<userData>/remote-peers.json`, mode
 * 0600, rewritten atomically on every change. Removing a peer is revoking it:
 * its next auth attempt is refused as unpaired.
 */
import { join } from "node:path";
import { z } from "zod";
import { isRawKey } from "./crypto";
import { TrustStore } from "./trust-store";

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

export class PeerStore extends TrustStore<PeerInfo> {
	constructor(userData: string) {
		super(join(userData, "remote-peers.json"), "peers", StoredPeer, peer => ({ ...peer }));
	}
}
