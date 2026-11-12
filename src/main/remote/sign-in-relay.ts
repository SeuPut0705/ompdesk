/**
 * A paired host's browser sign-in, finished in THIS computer's browser. Stock's flow runs on the host, so the
 * authorization URL's `redirect_uri` is the host's loopback callback (`http://localhost:<port>/callback`), and the
 * provider sends this computer's browser to this computer's loopback, where nothing listened: the browser showed a
 * connection error and the sign-in waited out its five minutes. While the host's `login` runs, this computer listens
 * on that port on its own loopback, hands the browser's callback over the link (`host.signIn.callback`, which the
 * host replays only to its own tab's callback) and gives the browser the page the host's omp answered.
 *
 * The listener and its guards (loopback only, both families for `localhost`; the callback's exact path; the flow's
 * `state`; a loopback Host header; one use; an end at Cancel or after stock's own callback timeout) are the core's
 * (`remotebytes/signin.rs`). A port this computer already uses is reported, not shared: the panel shows the paste.
 * Nothing logs the query (it carries the authorization code).
 */
import type { IpcSignInRelay } from "../../shared/ipc-types";
import { core } from "../core/process";
import { LOOPBACK_HOSTS, loopbackCallback, type SignInCallbackPage } from "../sign-in-callback";
import { registerAsker } from "./bytes-asks";

/** Stock's callback flows give up after five minutes (callback-server.ts `DEFAULT_TIMEOUT`). */
export const SIGN_IN_RELAY_TIMEOUT_MS = 5 * 60_000;

export interface SignInRelayOptions {
	/** Stock's authorization URL (`open_url`'s `url`): its `redirect_uri` and `state`. */
	authorizationUrl: string;
	/** Hands the browser's callback (path, query without `?`) to the host; rejects when the host cannot be reached. */
	forward: (path: string, query: string) => Promise<SignInCallbackPage>;
	/** The page's words when the host could not take the callback: how to finish by pasting the address. */
	failure: () => { title: string; message: string };
	/** Listening, or the port is taken here (then nothing listens). */
	onState: (state: IpcSignInRelay) => void;
	/** Test seam: listen on this port instead (two apps on one computer share its loopback). */
	port?: number;
	timeoutMs?: number;
}

export interface SignInRelay {
	close(): void;
}

/** Relays the core runs, by number: each is released when the core says it ended. */
const running = new Map<number, () => void>();
let routed = false;

/** Starts the stand-in for the sign-in whose authorization URL this is; null when it has no loopback callback or state. */
export function startSignInRelay(options: SignInRelayOptions): SignInRelay | null {
	const callback = loopbackCallback(options.authorizationUrl);
	if (!callback || callback.state === null) return null;
	const { url, state } = callback;
	const port = options.port ?? Number(url.port);
	const process = core();
	if (!routed) {
		routed = true;
		process.on("remotebytes.signInEnded", data => running.get((data as { relay: number }).relay)?.());
	}
	const asker = registerAsker(async ask => {
		try {
			return { page: await options.forward(String(ask.path), String(ask.query)) };
		} catch {
			return { failure: options.failure() };
		}
	});
	running.set(asker.id, () => {
		running.delete(asker.id);
		asker.release();
	});
	// A close before the core answered the start waits for it, so the core never hears of a relay it has not started.
	let closed = false;
	let started = false;
	const close = () => {
		if (closed) return;
		closed = true;
		if (started) process.push("remotebytes.signInClose", { relay: asker.id });
	};
	const hosts =
		url.hostname === "localhost" ? ["127.0.0.1", "::1"] : [url.hostname === "[::1]" ? "::1" : url.hostname];
	process
		.call<{ listening?: boolean; port?: number; closed?: true }>("remotebytes.signInStart", {
			relay: asker.id,
			port,
			path: url.pathname,
			state,
			hosts,
			loopbackHosts: Object.keys(LOOPBACK_HOSTS),
			timeoutMs: options.timeoutMs ?? SIGN_IN_RELAY_TIMEOUT_MS,
		})
		.then(
			({ result }) => {
				started = true;
				if (result.listening !== true) running.get(asker.id)?.();
				if (closed) {
					if (result.listening === true) process.push("remotebytes.signInClose", { relay: asker.id });
					return;
				}
				if (result.listening === true) options.onState({ listening: true });
				else if (result.listening === false) options.onState({ listening: false, port });
			},
			() => {
				// The core could not start it: nothing listens, as when the port is taken.
				running.get(asker.id)?.();
				if (!closed) options.onState({ listening: false, port });
			},
		);
	return { close };
}
