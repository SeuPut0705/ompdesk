/**
 * The per-install secret path of `tailscale serve`'s target (`http://127.0.0.1:<port>/<secret>`), kept in
 * `<userData>/web-serve-secret.json` (mode 0600, written atomically by remote/secure-file.ts).
 *
 * Serve is the only thing that sets `Tailscale-User-Login`, but a local process can write the same header on the
 * loopback port. Only traffic that came through serve carries the secret prefix (serve joins the target's path to
 * the request path), so the server treats a request as "through serve" — and trusts its identity headers — only
 * then. The page never sees the prefix: the server strips it. A missing or corrupt file makes a new secret, and the
 * serve handler is published again with it (a handler with the old one stops being ours; tailscale/serve.ts).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeSecureJson } from "../remote/secure-file";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const Stored = z.object({ v: z.literal(1), secret: z.string().regex(SECRET) });

export class ServeSecretStore {
	readonly #file: string;
	#secret: string | null = null;

	constructor(userData: string) {
		this.#file = join(userData, "web-serve-secret.json");
	}

	/** The secret: read from disk, or made (256 bits, base64url) and saved on first use or when the file is unusable. */
	get(): string {
		if (this.#secret) return this.#secret;
		const stored = Stored.safeParse(readJson(this.#file));
		if (stored.success) {
			this.#secret = stored.data.secret;
			return this.#secret;
		}
		const made = randomBytes(32).toString("base64url");
		writeSecureJson(this.#file, { v: 1, secret: made });
		this.#secret = made;
		return made;
	}
}
