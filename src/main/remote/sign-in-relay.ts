/**
 * A paired host's browser sign-in, finished in THIS computer's browser. Stock's flow runs on the host, so the
 * authorization URL's `redirect_uri` is the host's loopback callback (`http://localhost:<port>/callback`), and the
 * provider sends this computer's browser to this computer's loopback, where nothing listened: the browser showed a
 * connection error and the sign-in waited out its five minutes. While the host's `login` runs, this computer listens
 * on that port on its own loopback, hands the browser's callback over the link (`host.signIn.callback`, which the
 * host replays only to its own tab's callback) and gives the browser the page the host's omp answered.
 *
 * Guards: loopback only (both families for `localhost`, as stock binds them), the callback's exact path, the flow's
 * `state`, a loopback Host header (no DNS rebinding), one use, and an end with the sign-in, at Cancel or after stock's
 * own callback timeout. A port this computer already uses is reported, not shared: the panel shows the paste.
 * Nothing here logs the query (it carries the authorization code).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { IpcSignInRelay } from "../../shared/ipc-types";
import { LOOPBACK_HOSTS, loopbackCallback, type SignInCallbackPage } from "../sign-in-callback";

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

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);

function failurePage({ title, message }: { title: string; message: string }): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function bind(server: Server, host: string, port: number): Promise<NodeJS.ErrnoException | null> {
	const { promise, resolve } = Promise.withResolvers<NodeJS.ErrnoException | null>();
	server.once("error", resolve);
	server.listen({ host, port, exclusive: true }, () => {
		server.off("error", resolve);
		resolve(null);
	});
	return promise;
}

/** Starts the stand-in for the sign-in whose authorization URL this is; null when it has no loopback callback or state. */
export function startSignInRelay(options: SignInRelayOptions): SignInRelay | null {
	const callback = loopbackCallback(options.authorizationUrl);
	if (!callback || callback.state === null) return null;
	const { url, state } = callback;
	const port = options.port ?? Number(url.port);
	const servers: Server[] = [];
	let closed = false;
	let busy = false;
	const close = () => {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		// A callback on its way finishes: its page is the one the browser shows (the sign-in ends as it arrives).
		for (const server of servers) server.close();
		for (const server of servers) server.closeIdleConnections();
	};
	const timer = setTimeout(close, options.timeoutMs ?? SIGN_IN_RELAY_TIMEOUT_MS);
	timer.unref();

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		// One answer per connection: nothing stays open past the stand-in's end.
		const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" };
		const hostHeader = request.headers.host ?? "";
		const hostname = URL.canParse(`http://${hostHeader}`) ? new URL(`http://${hostHeader}`).hostname : "";
		if (!Object.hasOwn(LOOPBACK_HOSTS, hostname)) {
			response.writeHead(403, headers).end();
			return;
		}
		const target = new URL(request.url ?? "/", "http://localhost");
		if (request.method !== "GET" || target.pathname !== url.pathname || target.searchParams.get("state") !== state) {
			response.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" }).end("Not Found");
			return;
		}
		if (busy || closed) {
			response.writeHead(409, { ...headers, "content-type": "text/plain; charset=utf-8" }).end();
			return;
		}
		busy = true;
		let page: SignInCallbackPage;
		try {
			page = await options.forward(target.pathname, target.search.slice(1));
		} catch {
			busy = false;
			response
				.writeHead(502, { ...headers, "content-type": "text/html; charset=utf-8" })
				.end(failurePage(options.failure()));
			return;
		}
		response.writeHead(page.status, { ...headers, "content-type": page.contentType }).end(page.body, close);
	};

	const hosts =
		url.hostname === "localhost" ? ["127.0.0.1", "::1"] : [url.hostname === "[::1]" ? "::1" : url.hostname];
	void (async () => {
		for (const [index, host] of hosts.entries()) {
			const server = createServer((request, response) => void handle(request, response));
			const error = await bind(server, host, port);
			if (closed) {
				server.close();
				return;
			}
			if (error === null) {
				servers.push(server);
				continue;
			}
			// A computer without IPv6 has no `::1` to take: the IPv4 listener serves alone, as stock's does.
			if (index > 0 && error.code !== "EADDRINUSE") continue;
			close();
			options.onState({ listening: false, port });
			return;
		}
		options.onState({ listening: true });
	})();
	return { close };
}
