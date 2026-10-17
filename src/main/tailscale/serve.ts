/**
 * Publishing OMPdesk's page with `tailscale serve`, without touching anything else the user serves (design §4.3).
 *
 * The only commands this module's callers ever run are `serve --bg --https=<port> http://127.0.0.1:<local>/<secret>`
 * and `serve --https=<port> off`, and the second only for a handler the prefs record says OMPdesk published and that
 * is still exactly that (one `/` handler proxying to the recorded target, with or without the secret path: an
 * earlier OMPdesk published it without). There is no reset of the whole serve config and no Funnel command
 * anywhere: a port Funnel could expose (443, 8443, 10000) is never ours, and a Funnel flag found on our own port
 * makes the page refuse to start. The secret (web/serve-secret.ts) is never recorded in the prefs.
 */
import { z } from "zod";
import { MOBILE_WEB_PORT } from "../../shared/mobile-web";

const lenient = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().catch(undefined);

const ServeSchema = z.object({
	TCP: lenient(
		z.record(z.object({ HTTPS: lenient(z.boolean()), HTTP: lenient(z.boolean()), TCPForward: lenient(z.string()) })),
	),
	Web: lenient(
		z.record(
			z.object({
				Handlers: lenient(
					z.record(
						z.object({
							Proxy: lenient(z.string()),
							Path: lenient(z.string()),
							Text: lenient(z.string()),
							Redirect: lenient(z.string()),
						}),
					),
				),
			}),
		),
	),
	AllowFunnel: lenient(z.record(z.boolean())),
});

export interface ServeHandler {
	proxy: string | null;
	/** A path, text or redirect handler: never something OMPdesk published. */
	other: boolean;
}

/** `serve status --json`, reduced to what ownership and port choice need. */
export interface ServeConfig {
	/** Ports with a TCP handler (an HTTPS handler or a TCP forward). */
	tcpPorts: Set<number>;
	/** `<host>:<port>` → `<mount path>` → handler. */
	web: Map<string, Map<string, ServeHandler>>;
	/** `<host>:<port>` keys Funnel exposes. */
	funnel: Set<string>;
}

/** The serve config in `stdout` (an empty answer is an empty config), or null when it is not one. */
export function parseServeStatus(stdout: string): ServeConfig | null {
	let json: unknown = {};
	if (stdout.trim()) {
		try {
			json = JSON.parse(stdout);
		} catch {
			return null;
		}
	}
	const parsed = ServeSchema.safeParse(json);
	if (!parsed.success) return null;
	const doc = parsed.data;
	const web = new Map<string, Map<string, ServeHandler>>();
	for (const [key, site] of Object.entries(doc.Web ?? {})) {
		const handlers = new Map<string, ServeHandler>();
		for (const [mount, handler] of Object.entries(site.Handlers ?? {})) {
			handlers.set(mount, {
				proxy: handler.Proxy ?? null,
				other: Boolean(handler.Path || handler.Text || handler.Redirect),
			});
		}
		web.set(key.toLowerCase(), handlers);
	}
	return {
		tcpPorts: new Set(
			Object.keys(doc.TCP ?? {})
				.map(Number)
				.filter(Number.isInteger),
		),
		web,
		funnel: new Set(
			Object.entries(doc.AllowFunnel ?? {})
				.filter(([, on]) => on)
				.map(([key]) => key.toLowerCase()),
		),
	};
}

/** What OMPdesk published: the prefs record `mobileWeb.serve`. */
export interface ServeRecord {
	host: string;
	port: number;
	/** `http://127.0.0.1:<local port>`, without the secret path. */
	target: string;
}

/** The pref's value as a record, or null when it is anything else. */
export function readServeRecord(value: unknown): ServeRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const { host, port, target } = value as Record<string, unknown>;
	if (typeof host !== "string" || !host || typeof target !== "string" || !target) return null;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host, port, target };
}

function siteKey(host: string, port: number): string {
	return `${host.toLowerCase()}:${port}`;
}

/** Whether some handler already listens on `port` (any host name of this node, TCP forward or HTTPS). */
export function portTaken(config: ServeConfig, port: number): boolean {
	if (config.tcpPorts.has(port)) return true;
	for (const key of config.web.keys()) if (key.endsWith(`:${port}`)) return true;
	return false;
}

/**
 * The URL of the single `/` proxy on `record`'s `<host>:<port>` when it is what OMPdesk published (the recorded
 * target, alone or followed by a path: the secret), else null.
 */
export function ownProxy(config: ServeConfig, record: ServeRecord): string | null {
	const handlers = config.web.get(siteKey(record.host, record.port));
	if (handlers?.size !== 1) return null;
	const root = handlers.get("/");
	if (root === undefined || root.other || root.proxy === null) return null;
	return root.proxy === record.target || root.proxy.startsWith(`${record.target}/`) ? root.proxy : null;
}

/** The handler on `record`'s `<host>:<port>` is what OMPdesk published. */
export function handlerIsOurs(config: ServeConfig, record: ServeRecord): boolean {
	return ownProxy(config, record) !== null;
}

/** Funnel exposes `<host>:<port>`. */
export function funnelOn(config: ServeConfig, host: string, port: number): boolean {
	return config.funnel.has(siteKey(host, port));
}

/** The next port to try this many times above the first before giving up. */
const PORT_ATTEMPTS = 50;

export type PublishPlan = { kind: "reuse"; port: number } | { kind: "publish"; port: number } | { kind: "none" };

/**
 * Where to publish `target` (the full proxy URL, secret path included) on `host`:
 * - our own earlier handler (the record matches what is there): that port, left alone when it already proxies to
 *   exactly `target`, published again over itself otherwise (an old target without the secret, a new local port);
 * - else the first port from 47831 up that nothing uses (the user's other handlers are never moved or reused).
 */
export function planPublish(
	config: ServeConfig,
	host: string,
	target: string,
	record: ServeRecord | null,
	first: number = MOBILE_WEB_PORT,
): PublishPlan {
	if (record && record.host.toLowerCase() === host.toLowerCase() && handlerIsOurs(config, record)) {
		return ownProxy(config, record) === target
			? { kind: "reuse", port: record.port }
			: { kind: "publish", port: record.port };
	}
	for (let port = first; port < first + PORT_ATTEMPTS && port <= 65535; port++) {
		if (!portTaken(config, port)) return { kind: "publish", port };
	}
	return { kind: "none" };
}

/** Everything in `config` except what is on `port`: what turning our handler off must leave exactly as it was. */
export function withoutPort(config: ServeConfig, port: number): ServeConfig {
	const suffix = `:${port}`;
	return {
		tcpPorts: new Set([...config.tcpPorts].filter(other => other !== port)),
		web: new Map([...config.web].filter(([key]) => !key.endsWith(suffix))),
		funnel: new Set([...config.funnel].filter(key => !key.endsWith(suffix))),
	};
}

/** The two configs hold the same handlers (map and set order aside). */
export function sameServeConfig(a: ServeConfig, b: ServeConfig): boolean {
	const handlers = (config: ServeConfig) =>
		JSON.stringify(
			[...config.web]
				.sort(([x], [y]) => x.localeCompare(y))
				.map(([key, site]) => [key, [...site].sort(([x], [y]) => x.localeCompare(y))]),
		);
	return (
		[...a.tcpPorts].sort().join() === [...b.tcpPorts].sort().join() &&
		[...a.funnel].sort().join() === [...b.funnel].sort().join() &&
		handlers(a) === handlers(b)
	);
}
