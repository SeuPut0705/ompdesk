/**
 * What the Default browser setting resolves to for a session (rules: src/shared/default-browser.ts; section and
 * relay override: ./default-browser-core.ts). Dependency-free: main and the bridge both import it.
 */

/** Env main sets at every spawn; see {@link agentBrowserEnv}. */
export const DEFAULT_BROWSER_ENV = "OMP_GUI_BROWSER";

/**
 * `ego`: ego-browser's CLI. `relay`: the user's own signed-in browser (`name`, e.g. "Google Chrome") through stock's
 * browser relay at `url`, the loopback endpoint only that browser's extension copy dials (one relay per browser:
 * every extension on a shared endpoint would let "Chrome" drive a connected Edge). `builtin`: omp's own browser, stock.
 */
export type AgentBrowser = { kind: "ego" } | { kind: "relay"; name: string; url: string } | { kind: "builtin" };

/** `http://127.0.0.1:<port>`: the only relay endpoint a session may be pointed at. */
const RELAY_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** The env value: `ego`, `builtin` or `relay:<name>@<url>`. */
export function agentBrowserEnv(browser: AgentBrowser): string {
	return browser.kind === "relay" ? `relay:${browser.name}@${browser.url}` : browser.kind;
}

/** A browser name that is safe to name in a prompt and to carry in an env value: short, one line, no `@`. */
function isBrowserName(name: unknown): name is string {
	return typeof name === "string" && name.trim().length > 0 && name.length <= 64 && !/[\p{Cc}@]/u.test(name);
}

/** The env value read back; missing or malformed reads as the built-in browser. */
export function parseAgentBrowserEnv(value: string | undefined): AgentBrowser {
	if (value === "ego") return { kind: "ego" };
	if (value?.startsWith("relay:")) {
		const rest = value.slice("relay:".length);
		const at = rest.lastIndexOf("@");
		const name = rest.slice(0, at).trim();
		const url = rest.slice(at + 1);
		if (at > 0 && isBrowserName(name) && RELAY_URL.test(url)) return { kind: "relay", name, url };
	}
	return { kind: "builtin" };
}

/** A `default_browser_set` value; undefined when it is not a browser. */
export function parseAgentBrowser(value: unknown): AgentBrowser | undefined {
	if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
	if (value.kind === "ego" || value.kind === "builtin") return { kind: value.kind };
	if (
		value.kind === "relay" &&
		"name" in value &&
		isBrowserName(value.name) &&
		"url" in value &&
		typeof value.url === "string" &&
		RELAY_URL.test(value.url)
	) {
		return { kind: "relay", name: value.name.trim(), url: value.url };
	}
	return undefined;
}
