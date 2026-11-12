/**
 * A device that uses this computer (B side), as `<userData>/remote-peers.json` holds it. The file is the core's
 * (`crates/core/src/remote/store.rs`, the devices instance's records); main reads its records from the devices
 * state (`sharing.ts`).
 */
import type { PeerLimits } from "../../shared/ipc-types";

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
