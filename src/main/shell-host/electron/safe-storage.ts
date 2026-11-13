/**
 * `safeStorage`, byte-identical to Electron's (Chromium's OSCrypt "v10"), so a value either app wrote reads in the
 * other. Electron's API is synchronous, so the shell reads the key once and hands it over in the facts (PROTOCOL.md
 * §11); this is the cipher around it.
 *
 * - Windows: `"v10" ‖ nonce(12) ‖ AES-256-GCM ciphertext ‖ tag(16)`, key = the DPAPI-unwrapped
 *   `os_crypt.encrypted_key` of `Local State`.
 * - macOS: `"v10" ‖ AES-128-CBC(PKCS7)`, key = PBKDF2-HMAC-SHA1(keychain password, "saltysalt", 1003, 16),
 *   IV = sixteen spaces.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { SafeStorageFact, SafeStorageKey } from "../facts";

const PREFIX = Buffer.from("v10", "ascii");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const MAC_IV = Buffer.alloc(16, 0x20);
const MAC_SALT = "saltysalt";
const MAC_ITERATIONS = 1003;
/** The keychain may show its dialog, and the person takes a while: the read waits that long. */
const KEYCHAIN_TIMEOUT_MS = 120_000;

export interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	getSelectedStorageBackend(): string;
	/**
	 * Why encryption is unavailable (the shell's own words, e.g. `keychain-would-ask`), null while it is available. Not
	 * in Electron: main reads it to tell "the keychain would ask" from "this system cannot encrypt". Settles the key
	 * like any other call (once: the answer is kept, a refused read is never repeated).
	 */
	getUnavailableReason(): string | null;
}

interface Cipher {
	encrypt(plain: Buffer): Buffer;
	decrypt(sealed: Buffer): Buffer;
}

function windowsCipher(key: Buffer): Cipher {
	if (key.length !== 32) throw new Error(`the OSCrypt key is ${key.length} bytes, not 32`);
	return {
		encrypt(plain) {
			const nonce = randomBytes(NONCE_LENGTH);
			const cipher = createCipheriv("aes-256-gcm", key, nonce);
			const body = Buffer.concat([cipher.update(plain), cipher.final()]);
			return Buffer.concat([nonce, body, cipher.getAuthTag()]);
		},
		decrypt(sealed) {
			if (sealed.length < NONCE_LENGTH + TAG_LENGTH) throw new Error("the value is too short");
			const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_LENGTH));
			decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LENGTH));
			return Buffer.concat([
				decipher.update(sealed.subarray(NONCE_LENGTH, sealed.length - TAG_LENGTH)),
				decipher.final(),
			]);
		},
	};
}

function macCipher(password: Buffer): Cipher {
	const key = pbkdf2Sync(password, MAC_SALT, MAC_ITERATIONS, 16, "sha1");
	return {
		encrypt(plain) {
			const cipher = createCipheriv("aes-128-cbc", key, MAC_IV);
			return Buffer.concat([cipher.update(plain), cipher.final()]);
		},
		decrypt(sealed) {
			const decipher = createDecipheriv("aes-128-cbc", key, MAC_IV);
			return Buffer.concat([decipher.update(sealed), decipher.final()]);
		},
	};
}

/** Reads the macOS keychain key through the shell binary itself (PROTOCOL.md §11); tests give their own. */
export type KeyFetcher = () => SafeStorageKey;

/** `<exe> --keychain-key <userData>`: its stdout is one JSON line, a `SafeStorageKey`. */
export function keychainFetcher(exe: string, userData: string): KeyFetcher {
	return () => {
		try {
			const out = execFileSync(exe, ["--keychain-key", userData], {
				encoding: "utf8",
				timeout: KEYCHAIN_TIMEOUT_MS,
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "");
			} catch {
				// not a JSON line: answered below as unreadable
			}
			if (typeof parsed === "object" && parsed !== null) {
				if (
					"kind" in parsed &&
					parsed.kind === "mac-v10" &&
					"password" in parsed &&
					typeof parsed.password === "string"
				)
					return { kind: "mac-v10", password: parsed.password };
				if ("unavailable" in parsed && typeof parsed.unavailable === "string")
					return { unavailable: parsed.unavailable };
			}
			return { unavailable: "the shell answered the keychain request with something unreadable" };
		} catch (error) {
			return {
				unavailable: `the keychain key could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};
}

export function createSafeStorage(
	fact: SafeStorageFact,
	options: { warn?: (message: string) => void; fetchKey?: KeyFetcher } = {},
): SafeStorage {
	const warn = options.warn ?? ((message: string) => console.warn(`[shell-host] ${message}`));
	let cipher: Cipher | null = null;
	let reason = "";
	let resolved = false;
	/** The first call of any method settles the key: a lazy key is fetched here, never before. */
	const resolve = (): void => {
		if (resolved) return;
		resolved = true;
		let key: SafeStorageKey;
		if ("kind" in fact && fact.kind === "mac-v10-lazy") {
			if (!options.fetchKey) key = { unavailable: "no keychain reader" };
			else key = options.fetchKey();
		} else {
			key = fact as SafeStorageKey;
		}
		if ("unavailable" in key) {
			reason = key.unavailable;
		} else {
			try {
				cipher =
					key.kind === "win-v10"
						? windowsCipher(Buffer.from(key.key, "base64"))
						: macCipher(Buffer.from(key.password, "base64"));
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
			}
		}
		if (!cipher) warn(`safeStorage is unavailable: ${reason}`);
	};
	const available = (action: string): Cipher => {
		resolve();
		if (!cipher) throw new Error(`Error while ${action}. Encryption is not available.`);
		return cipher;
	};
	return {
		isEncryptionAvailable() {
			resolve();
			return cipher !== null;
		},
		encryptString(plainText) {
			if (typeof plainText !== "string") throw new TypeError("plainText must be a string");
			return Buffer.concat([
				PREFIX,
				available("encrypting the text provided to safeStorage.encryptString").encrypt(
					Buffer.from(plainText, "utf8"),
				),
			]);
		},
		decryptString(encrypted) {
			const used = available("decrypting the text provided to safeStorage.decryptString");
			if (!Buffer.isBuffer(encrypted)) throw new TypeError("encrypted must be a Buffer");
			if (encrypted.length < PREFIX.length || !encrypted.subarray(0, PREFIX.length).equals(PREFIX))
				throw new Error(
					"Error while decrypting the ciphertext provided to safeStorage.decryptString. Ciphertext does not appear to be encrypted.",
				);
			try {
				return used.decrypt(encrypted.subarray(PREFIX.length)).toString("utf8");
			} catch {
				throw new Error(
					"Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption failed.",
				);
			}
		},
		getUnavailableReason() {
			resolve();
			return cipher ? null : reason;
		},
		getSelectedStorageBackend() {
			resolve();
			return cipher ? (process.platform === "darwin" ? "keychain" : "dpapi") : "unknown";
		},
	};
}
