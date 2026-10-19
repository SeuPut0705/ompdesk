/**
 * The devices that use this computer (B side): `<userData>/remote-peers.json`, mode 0600, rewritten atomically on
 * every change. A device is recorded the first time Tailscale vouches for it, pinned to its Tailscale node and its
 * static key. Removing it forgets that pin: the node may connect again (with any key) while its login is allowed;
 * a block is what keeps it out.
 */
import { join } from "node:path";
import { z } from "zod";
import type { PeerLimits } from "../../shared/ipc-types";
import { isRawKey } from "./crypto";
import { TrustStore } from "./trust-store";

export interface PeerInfo {
	deviceId: string;
	name: string;
	/** The peer's long-term X25519 public key, base64url. */
	staticPub: string;
	/**
	 * The Tailscale node (`whois` stable ID) the device connects from. Null only for a device paired with a code
	 * by an older release: its first connection binds it, if the key still matches.
	 */
	nodeId: string | null;
	/** The node's Tailscale login when it was bound. */
	login: string | null;
	pairedAt: number;
	/** Last authenticated connect or disconnect. */
	lastSeenAt?: number;
	/** Daily model-use limits this computer sets for the device (peer-quota.ts); none = unlimited. */
	limits?: PeerLimits;
	/** What the device used on `day` (local date). */
	usage?: { day: string; requests: number; tokens: number };
}

const Count = z.number().int().nonnegative();

const StoredPeer = z.object({
	deviceId: z.string().min(1),
	name: z.string(),
	staticPub: z.string().refine(isRawKey),
	// Absent in a record an older release wrote.
	nodeId: z.string().min(1).nullable().default(null),
	login: z.string().nullable().default(null),
	pairedAt: z.number(),
	lastSeenAt: z.number().optional(),
	limits: z.object({ requestsPerDay: Count.optional(), tokensPerDay: Count.optional() }).optional(),
	usage: z.object({ day: z.string(), requests: Count, tokens: Count }).optional(),
});

export class PeerStore extends TrustStore<PeerInfo> {
	constructor(userData: string) {
		super(join(userData, "remote-peers.json"), "peers", StoredPeer, peer => ({ ...peer }));
	}

	/** The device pinned to a Tailscale node; a node holds at most one. */
	byNode(nodeId: string): PeerInfo | undefined {
		return this.list().find(peer => peer.nodeId === nodeId);
	}
}
