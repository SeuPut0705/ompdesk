/**
 * Remote-device crypto primitives (node:crypto only): Crockford base32 ids
 * and pairing codes, X25519 keys as base64url raw public keys, transcript
 * hashes, and the HKDF/HMAC derivations of the pairing and auth handshakes.
 */
import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

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

/** A fresh pairing code: 8 Crockford chars (40 bits), unformatted. */
export function generateCode(): string {
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) code += CROCKFORD[randomInt(32)];
	return code;
}

/** `XXXX-XXXX` for display. */
export function formatCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The canonical code a user typed: case-insensitive, dashes and spaces
 * ignored, I/L read as 1 and O as 0. Null unless it is 8 Crockford chars.
 */
export function normalizeCode(input: string): string | null {
	const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
	if (code.length !== CODE_LENGTH) return null;
	for (const char of code) if (!CROCKFORD.includes(char)) return null;
	return code;
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

const PAIR_INFO = "ompdesk-pair-v1";
const AUTH_INFO = "ompdesk-auth-v1";

/** `HKDF-SHA256(X25519(eph, eph'), salt = code, info = "ompdesk-pair-v1" || transcript hash)`. */
export function pairKey(ephemeralSecret: Buffer, normalizedCode: string, transcript: Buffer): Buffer {
	const info = Buffer.concat([Buffer.from(PAIR_INFO), transcript]);
	return Buffer.from(hkdfSync("sha256", ephemeralSecret, Buffer.from(normalizedCode), info, 32));
}

export function pairTranscript(fields: readonly string[]): Buffer {
	return transcriptHash(PAIR_INFO, fields);
}

export function authTranscript(fields: readonly string[]): Buffer {
	return transcriptHash(AUTH_INFO, fields);
}

/** HMAC-SHA256(k, role), base64url: the client proves with "A", the host answers with "B". */
export function pairMac(key: Buffer, role: "A" | "B"): string {
	return createHmac("sha256", key).update(role).digest("base64url");
}

export function macEquals(expected: string, actual: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(actual);
	return a.length === b.length && timingSafeEqual(a, b);
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
