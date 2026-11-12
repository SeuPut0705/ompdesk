/**
 * What web devices' TypeScript store still needs of the ids: Crockford base32 device ids. The keys, the handshake's key
 * schedule, the identity file and the remote device stores are the core's (`crates/core/src/remote/`, which pins
 * these against rows captured from this file); this goes with `web/devices-store.ts` when it moves.
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

export function randomDeviceId(): string {
	return base32(randomBytes(16));
}
