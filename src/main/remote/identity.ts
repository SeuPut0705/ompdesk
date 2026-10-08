/**
 * This device's long-term remote identity: an X25519 key pair plus a random
 * 128-bit device id, kept in `<userData>/remote-identity.json` (mode 0600).
 * Not in safeStorage: ad-hoc builds would prompt for the keychain after every
 * update. A missing or unreadable file mints a new identity, which unpairs
 * this device everywhere.
 */
import type { KeyObject } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { exportPrivateKey, generateKeyPair, importKeyPair, randomDeviceId } from "./crypto";
import { readJson, writeSecureJson } from "./secure-file";

export interface Identity {
	readonly deviceId: string;
	/** Raw X25519 public key, base64url. */
	readonly publicKey: string;
	readonly privateKey: KeyObject;
}

const StoredIdentity = z.object({
	v: z.literal(1),
	deviceId: z.string().regex(/^[0-9a-z]{26}$/),
	publicKey: z.string(),
	privateKey: z.string(),
});

export function identityFile(userData: string): string {
	return join(userData, "remote-identity.json");
}

export function loadIdentity(userData: string): Identity {
	const file = identityFile(userData);
	const stored = StoredIdentity.safeParse(readJson(file));
	if (stored.success) {
		try {
			const keys = importKeyPair(stored.data.publicKey, stored.data.privateKey);
			return { deviceId: stored.data.deviceId, ...keys };
		} catch {
			// A damaged key is no identity at all; mint a new one below.
		}
	}
	const keys = generateKeyPair();
	const identity: Identity = { deviceId: randomDeviceId(), ...keys };
	writeSecureJson(file, {
		v: 1,
		deviceId: identity.deviceId,
		publicKey: identity.publicKey,
		privateKey: exportPrivateKey(identity.privateKey),
	});
	return identity;
}
