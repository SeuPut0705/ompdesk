/**
 * A browser sign-in's loopback callback, as stock's callback-server flows advertise it: the authorization URL's
 * `redirect_uri` is `http://localhost|127.0.0.1|[::1]:<port><callbackPath>` on the computer running omp, and the
 * provider sends the browser back there with `code` and the flow's `state` (pi-ai registry/oauth/callback-server.ts).
 * One reading for everything that acts on it: Cancel reaches it with a denial (local/settings.ts), a paired host
 * replays a device's browser callback to it (remote/host-services.ts), and the device listens on its port for the
 * browser (remote/sign-in-relay.ts).
 */

/** The callback hosts stock serves (`#launchUrlIfSafe` in callback-server.ts). */
export const LOOPBACK_HOSTS: Readonly<Record<string, true>> = { localhost: true, "127.0.0.1": true, "[::1]": true };

export interface LoopbackCallback {
	/** The redirect URI without query or fragment. */
	url: URL;
	/** The flow's `state`, which its callback carries back; null when the authorization URL has none. */
	state: string | null;
}

export function loopbackCallback(authorizationUrl: string): LoopbackCallback | null {
	if (!URL.canParse(authorizationUrl)) return null;
	const authorize = new URL(authorizationUrl);
	const redirect = authorize.searchParams.get("redirect_uri");
	if (!redirect || !URL.canParse(redirect)) return null;
	const url = new URL(redirect);
	if (url.protocol !== "http:" || !Object.hasOwn(LOOPBACK_HOSTS, url.hostname) || url.port === "") return null;
	url.search = "";
	url.hash = "";
	return { url, state: authorize.searchParams.get("state") || null };
}

/** The most of the page stock's callback answers that crosses the link (its template is a few KB). */
export const SIGN_IN_PAGE_MAX_CHARS = 64 * 1024;

/** The page stock's callback server answered, as the browser gets it back. */
export interface SignInCallbackPage {
	status: number;
	contentType: string;
	body: string;
}

/**
 * The callback a browser made, replayed to omp's own callback server on this computer: `query` on the callback's
 * own address (never one a caller names). Answers stock's page; throws when the server is gone.
 */
export async function replaySignInCallback(callback: LoopbackCallback, query: string): Promise<SignInCallbackPage> {
	const target = new URL(callback.url);
	target.search = query;
	const response = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
	const type = response.headers.get("content-type") ?? "";
	return {
		status: response.status,
		contentType: /^text\/(html|plain)\b/i.test(type) ? type.slice(0, 200) : "text/plain; charset=utf-8",
		body: (await response.text()).slice(0, SIGN_IN_PAGE_MAX_CHARS),
	};
}
