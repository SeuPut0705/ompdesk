/**
 * The per-install secret path of `tailscale serve`'s target (`http://127.0.0.1:<port>/<secret>`), kept in
 * `<userData>/web-serve-secret.json` (mode 0600, written atomically) by the core
 * (`native/ompdesk/crates/core/src/web/store.rs` `serve_secret`).
 *
 * Serve is the only thing that sets `Tailscale-User-Login`, but a local process can write the same header on the
 * loopback port. Only traffic that came through serve carries the secret prefix (serve joins the target's path to
 * the request path), so the server treats a request as "through serve" — and trusts its identity headers — only
 * then. The page never sees the prefix: the server strips it. A missing or corrupt file makes a new secret, and the
 * serve handler is published again with it (a handler with the old one stops being ours; tailscale/serve.ts).
 *
 * The core makes it, so the first read is a request: `await ready()`, then `get()` is synchronous, for the callers
 * that need it in the same tick (`MobileWebService`'s publish).
 */
import { core } from "../core/process";

export class ServeSecretStore {
	readonly #userData: string;
	#secret: string | null = null;
	#loading: Promise<void> | null = null;

	constructor(userData: string) {
		this.#userData = userData;
	}

	/** Reads the secret from the core, which makes and saves it on first use or when its file is unusable. */
	ready(): Promise<void> {
		this.#loading ??= core()
			.call<{ secret: string }>("web.secret", { userData: this.#userData })
			.then(({ result }) => {
				this.#secret = result.secret;
			})
			.catch(error => {
				this.#loading = null;
				throw error;
			});
		return this.#loading;
	}

	/** The secret; only after `ready()` has resolved. */
	get(): string {
		if (this.#secret === null) throw new Error("The serve secret was read before ServeSecretStore.ready() resolved");
		return this.#secret;
	}
}
