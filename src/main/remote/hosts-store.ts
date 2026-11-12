/**
 * A host this device connected to (A side), as `<userData>/remote-hosts.json` holds it: pinned to its Tailscale node
 * and its static key from the first connection. The file is the core's (`crates/core/src/remote/store.rs`, which keeps
 * at most 8 addresses, most recently working first).
 */

export interface PairedHost {
	deviceId: string;
	name: string;
	/** The host's long-term X25519 public key, base64url. */
	staticPub: string;
	/** The host's Tailscale node (stable ID). Null only in a record an older release wrote (see devices.ts). */
	nodeId: string | null;
	/** `host:port` strings, most recently working first. */
	addresses: string[];
	pairedAt: number;
}
