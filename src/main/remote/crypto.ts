/**
 * What the TypeScript stores of remote devices still need of the keys: the raw-key check. The keys themselves, the
 * handshake's key schedule, the device ids and the identity file are the core's
 * (`crates/core/src/remote/{crypto,identity}.rs`, which pin them against rows captured from this file); the check
 * goes with the stores (`hosts-store.ts`, `peers-store.ts`) when those move.
 */
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

/** A raw 32-byte X25519 public key as base64url. */
export function isRawKey(value: string): boolean {
	return RAW_KEY.test(value);
}
