/**
 * Remote-device crypto primitives (node:crypto only): Crockford base32 ids,
 * X25519 keys as base64url raw public keys, transcript hashes, and the HKDF
 * derivation of the auth handshake.
 */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";

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

export interface KeyPair {
	/** Raw 32-byte X25519 public key, base64url. */
	publicKey: string;
	privateKey: KeyObject;
}

const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

export function isRawKey(value: string): boolean {
	return RAW_KEY.test(value);
}

function rawPublicKey(key: KeyObject): string {
	const { x } = key.export({ format: "jwk" });
	if (typeof x !== "string") throw new Error("X25519 key has no public component");
	return x;
}

export function generateKeyPair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	return { publicKey: rawPublicKey(publicKey), privateKey };
}

/** The persisted form of a private key: its JWK `d`. */
export function exportPrivateKey(key: KeyObject): string {
	const { d } = key.export({ format: "jwk" });
	if (typeof d !== "string") throw new Error("X25519 key has no private component");
	return d;
}

/** Rebuild a key pair from its persisted raw parts; throws when they do not match. */
export function importKeyPair(publicKey: string, privateKey: string): KeyPair {
	if (!isRawKey(publicKey) || !isRawKey(privateKey)) throw new Error("malformed X25519 key");
	const key = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: privateKey, x: publicKey }, format: "jwk" });
	if (rawPublicKey(createPublicKey(key)) !== publicKey) throw new Error("X25519 key pair mismatch");
	return { publicKey, privateKey: key };
}

/** X25519(private, peer public); throws on a malformed or low-order peer key. */
export function dh(privateKey: KeyObject, peerPublicKey: string): Buffer {
	if (!isRawKey(peerPublicKey)) throw new Error("malformed X25519 public key");
	const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerPublicKey }, format: "jwk" });
	return diffieHellman({ privateKey, publicKey });
}

/** SHA-256 of the canonical transcript: the JSON array of label and fields in protocol order. */
export function transcriptHash(label: string, fields: readonly string[]): Buffer {
	return createHash("sha256")
		.update(JSON.stringify([label, ...fields]))
		.digest();
}

const AUTH_INFO = "ompdesk-auth-v2";

export function authTranscript(fields: readonly string[]): Buffer {
	return transcriptHash(AUTH_INFO, fields);
}

export interface DirectionKeys {
	/** Client → host. */
	ab: Buffer;
	/** Host → client. */
	ba: Buffer;
}

/** Split `HKDF(ikm, info = "ompdesk-auth-v1" || transcript hash)` into the two direction keys. */
export function authKeys(ikm: Buffer, transcript: Buffer): DirectionKeys {
	const info = Buffer.concat([Buffer.from(AUTH_INFO), transcript]);
	const okm = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 64));
	return { ab: okm.subarray(0, 32), ba: okm.subarray(32) };
}

export function randomDeviceId(): string {
	return base32(randomBytes(16));
}
