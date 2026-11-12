/**
 * What the TypeScript stores of remote devices and web devices still need of the keys and ids: Crockford base32 ids
 * and the raw-key check. The keys themselves, the handshake's key schedule and the identity file are the core's
 * (`crates/core/src/remote/{crypto,identity}.rs`, which pin these two against rows captured from this file); these go
 * with the stores (`hosts-store.ts`, `peers-store.ts`, `web/devices-store.ts`) when those move.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 of `bytes`, lowercase, unpadded. */
export function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
	return out.toLowerCase();
}

const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

/** A raw 32-byte X25519 public key as base64url. */
export function isRawKey(value: string): boolean {
	return RAW_KEY.test(value);
}

export function randomDeviceId(): string {
	return base32(randomBytes(16));
}
