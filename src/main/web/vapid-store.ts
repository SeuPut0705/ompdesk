/**
 * The host's VAPID keypair (RFC 8292), made once and kept in `<userData>/web-push.json` (mode 0600, written
 * atomically by remote/secure-file.ts). A page subscribes to push against the public key, so a new keypair
 * invalidates every stored subscription: a missing or corrupt file makes a fresh pair and says so (`created`),
 * and the host then drops the subscriptions that were made against the old one.
 */
import { createECDH } from "node:crypto";
import { join } from "node:path";
import webpush from "web-push";
import { z } from "zod";
import { readJson, writeSecureJson } from "../remote/secure-file";

/** The push services' contact for this sender (RFC 8292 §2.1: a `mailto:` or `https:` URL). */
export const VAPID_SUBJECT = "https://github.com/SeuPut0705/ompdesk";

export interface VapidKeys {
	/** Uncompressed P-256 point, base64url: what `PushManager.subscribe` takes as `applicationServerKey`. */
	publicKey: string;
	/** The 32-byte private scalar, base64url. */
	privateKey: string;
	subject: string;
}

const Stored = z.object({
	v: z.literal(1),
	publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
	privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** True when `privateKey` really is the private half of `publicKey`. */
function isPair(publicKey: string, privateKey: string): boolean {
	try {
		const ecdh = createECDH("prime256v1");
		ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
		return ecdh.getPublicKey().equals(Buffer.from(publicKey, "base64url"));
	} catch {
		return false;
	}
}

export class VapidStore {
	readonly #file: string;
	#keys: VapidKeys | null = null;
	#created = false;

	constructor(userData: string) {
		this.#file = join(userData, "web-push.json");
	}

	/** The keypair: read from disk, or made and saved on first use (or when the file is unusable). */
	keys(): VapidKeys {
		if (this.#keys) return this.#keys;
		const stored = Stored.safeParse(readJson(this.#file));
		if (stored.success && isPair(stored.data.publicKey, stored.data.privateKey)) {
			this.#keys = { publicKey: stored.data.publicKey, privateKey: stored.data.privateKey, subject: VAPID_SUBJECT };
			return this.#keys;
		}
		const made = webpush.generateVAPIDKeys();
		writeSecureJson(this.#file, { v: 1, publicKey: made.publicKey, privateKey: made.privateKey });
		this.#created = true;
		this.#keys = { ...made, subject: VAPID_SUBJECT };
		return this.#keys;
	}

	/**
	 * True once, when this keypair was made by this process (first run, or the file was missing or corrupt):
	 * every subscription stored before it was made against another key and can no longer be pushed to.
	 */
	takeCreated(): boolean {
		this.keys();
		const created = this.#created;
		this.#created = false;
		return created;
	}
}
