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
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { SafeStorageFact } from "../facts";

const PREFIX = Buffer.from("v10", "ascii");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const MAC_IV = Buffer.alloc(16, 0x20);
const MAC_SALT = "saltysalt";
const MAC_ITERATIONS = 1003;

export interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	getSelectedStorageBackend(): string;
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

export function createSafeStorage(fact: SafeStorageFact, warn: (message: string) => void = console.warn): SafeStorage {
	let cipher: Cipher | null = null;
	let reason = "";
	if ("unavailable" in fact) {
		reason = fact.unavailable;
	} else {
		try {
			cipher =
				fact.kind === "win-v10"
					? windowsCipher(Buffer.from(fact.key, "base64"))
					: macCipher(Buffer.from(fact.password, "base64"));
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
		}
	}
	if (!cipher) warn(`[shell-host] safeStorage is unavailable: ${reason}`);
	const available = (action: string): Cipher => {
		if (!cipher) throw new Error(`Error while ${action}. Encryption is not available.`);
		return cipher;
	};
	return {
		isEncryptionAvailable: () => cipher !== null,
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
		getSelectedStorageBackend: () => (cipher ? (fact as { kind: string }).kind : "unknown"),
	};
}
