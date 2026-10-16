/**
 * The paired device's key (design §5.2): a non-extractable ECDSA P-256 pair WebCrypto makes at pairing and
 * IndexedDB keeps. The host stores only the public half and asks for a signature over a one-time nonce before
 * it hands out a WebSocket ticket, so a stolen cookie alone gets no connection.
 *
 * A page without `crypto.subtle` (the degraded HTTP mode) has no key and pairs with the cookie only.
 */

const DB_NAME = "ompdesk-device";
const STORE = "keys";
const KEY_ID = "device-key";
const ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGNATURE: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

export interface DeviceKey {
	privateKey: CryptoKey;
	publicKey: CryptoKey;
}

/** The browser can make and use a device key. */
export function deviceKeySupported(): boolean {
	return typeof crypto !== "undefined" && crypto.subtle !== undefined && typeof indexedDB !== "undefined";
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(DB_NAME, 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore(STORE);
		};
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error ?? new Error("IndexedDB could not open"));
	});
}

function isDeviceKey(value: unknown): value is DeviceKey {
	return (
		typeof value === "object" &&
		value !== null &&
		"privateKey" in value &&
		"publicKey" in value &&
		value.privateKey instanceof CryptoKey &&
		value.publicKey instanceof CryptoKey
	);
}

/** The stored key, or null when this browser has none (never paired here, or the site data was cleared). */
export async function loadDeviceKey(): Promise<DeviceKey | null> {
	if (!deviceKeySupported()) return null;
	const db = await openDb();
	try {
		const value: unknown = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID));
		return isDeviceKey(value) ? value : null;
	} finally {
		db.close();
	}
}

/** Make a fresh key (replacing any stored one) and keep it; the private half never leaves the browser. */
export async function createDeviceKey(): Promise<{ key: DeviceKey; publicKeyJwk: JsonWebKey }> {
	const pair = await crypto.subtle.generateKey(ALGORITHM, false, ["sign", "verify"]);
	const key: DeviceKey = { privateKey: pair.privateKey, publicKey: pair.publicKey };
	const db = await openDb();
	try {
		await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(key, KEY_ID));
	} finally {
		db.close();
	}
	return { key, publicKeyJwk: await crypto.subtle.exportKey("jwk", key.publicKey) };
}

function base64url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** ECDSA P-256 / SHA-256 over the UTF-8 nonce, raw IEEE-P1363 (what `subtle.sign` returns), base64url. */
export async function signNonce(privateKey: CryptoKey, nonce: string): Promise<string> {
	const signature = await crypto.subtle.sign(SIGNATURE, privateKey, new TextEncoder().encode(nonce));
	return base64url(signature);
}
