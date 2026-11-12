/**
 * The mobile web server's client: the core process serves HTTP and WebSocket on `127.0.0.1` (`native/ompdesk/crates/
 * core/src/web/`, native-rust ledger 8b): the static allowlist, the walls of every request, `/api/pair`,
 * `/api/session`, `/api/push`, `/upload`, `/blob/`, `/hooks/<id>` and the page's socket. Main keeps what the edge asks
 * for at each request (`web.ask`): the published address and the allowed logins (`RequestPolicy`, which Mobile web's
 * service configures), the desktop's say over a new device, `tailscale whois` and the schedule service's webhook. The
 * page sockets are the core's router's (8c); main's side of it is `WsRouter`, whose number is this host's.
 */
import { CORE_EXITED, type CoreProcess, core } from "../core/process";
import type { WebhookOutcome } from "../schedules";
import type { TailnetPeer } from "../tailscale/whois";
import type { PairingConfirmations } from "./pairing";
import type { WsRouter } from "./ws-router";

export const WEB_SERVER_HOST = "127.0.0.1";

export interface RequestPolicy {
	/** The published name (`<machine>.<tailnet>.ts.net`), or `127.0.0.1` before serve is configured. */
	host: string;
	/** The port in the published address (it differs from the loopback port when serve moved to a free one). */
	publicPort: number;
	/** The page is served over HTTPS (`tailscale serve`): `Secure` cookies, `https://` origin. */
	secure: boolean;
	/**
	 * The secret first path segment of the serve handler's target. Null until serve is published: nothing is
	 * served then, and with it set only a request carrying it is.
	 */
	servePrefix: string | null;
	/**
	 * The secret this host publishes under, known before serve's handler is confirmed (a relaunched host listens a
	 * few seconds before its first serve status). Until `servePrefix` is set, a request carrying it is answered 503
	 * (come back shortly) instead of 404: serve kept forwarding to this address while the app restarted, and a page
	 * whose lazy chunk got 404 in that window gave the chunk up for good though this build has it (e2e
	 * web-no-reload: Settings opened empty after the host's update). A request without it still gets the bare 404.
	 */
	pendingPrefix?: string | null;
	allowedUsers: () => readonly string[];
}

export interface WebServerDeps {
	/** Mutable: `configure` changes the published address as Tailscale reports it; the edge reads it per request. */
	policy: RequestPolicy;
	userData: string;
	confirmations: PairingConfirmations;
	/** Hold a new device until the desktop approves it (Settings, off by default). */
	confirmNewDevices: () => boolean;
	/** The node and user behind a tailnet address (`tailscale whois`); null when it does not know. */
	whois: (address: string) => Promise<TailnetPeer | null>;
	/** A device was just made without asking the desktop: it is told once, with the way to block it. */
	onDeviceConnected: (device: { id: string; name: string; tailscaleLogin: string | null }) => void;
	router: WsRouter;
	/** The folder holding the built renderer's `web.html` and assets; null while there is none. */
	staticRoot: () => string | null;
	/** A device authentication failed three times within a minute; told once. */
	onUnpairedAuth?: (info: { address: string }) => void;
	/** The schedule service that answers `POST /hooks/<id>`; null or absent while there is none (503). */
	hooks?: () => { webhook(id: string, bearer: string, detail: string): Promise<WebhookOutcome> } | null;
	/** Where an edge that had to start again after its core ended is noted. */
	log?: (message: string) => void;
}

interface ConfigurablePolicy {
	host?: string;
	publicPort?: number;
	secure?: boolean;
	servePrefix?: string | null;
	pendingPrefix?: string | null;
}

/** The core's question about one request or socket (`web.ask`). */
interface EdgeAsk {
	call: number;
	host: number;
	kind: "policy" | "confirmNew" | "confirm" | "whois" | "hook";
	name?: string;
	userAgent?: string;
	tailscaleLogin?: string;
	ip?: string;
	address?: string;
	id?: string;
	bearer?: string;
	detail?: string;
}

const servers = new Map<number, WebServer>();
let routed: CoreProcess | null = null;

/** The core's asks reach the server they name. */
function route(process: CoreProcess): void {
	if (routed === process) return;
	routed = process;
	process.on("web.ask", data => {
		const ask = data as EdgeAsk;
		const answer = (result: unknown) =>
			void process.call("web.answer", { call: ask.call, result }).catch(() => undefined);
		const server = servers.get(ask.host);
		if (!server) return answer(null);
		server.answerAsk(ask).then(answer, error => {
			console.warn(`[web] ${ask.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
			answer(null);
		});
	});
	process.on("web.deviceConnected", data => {
		const { host, device } = data as {
			host: number;
			device: { id: string; name: string; tailscaleLogin: string | null };
		};
		servers.get(host)?.deviceConnected(device);
	});
	process.on("web.unpairedAuth", data => {
		const { host, address } = data as { host: number; address: string };
		servers.get(host)?.unpairedAuth(address);
	});
	process.on(CORE_EXITED, () => {
		for (const server of servers.values()) server.coreExited();
	});
}

export class WebServer {
	readonly #deps: WebServerDeps;
	readonly #id: number;
	#port: number | null = null;
	/** The loopback port asked for at `start`, kept to start again on it after a core that ended. */
	#asked = 0;

	constructor(deps: WebServerDeps) {
		this.#deps = deps;
		this.#id = deps.router.host;
	}

	/** The loopback port while listening, else null. */
	get port(): number | null {
		return this.#port;
	}

	/** Change the address the server answers to (Tailscale reported a name, serve moved to another port). */
	configure(change: ConfigurablePolicy): void {
		Object.assign(this.#deps.policy, change);
	}

	/** Listen on the loopback; `port` 0 picks a free one. Rejects (`EADDRINUSE`) when the port is taken. */
	async start(options: { port?: number } = {}): Promise<{ port: number }> {
		if (this.#port !== null) return { port: this.#port };
		const process = core();
		route(process);
		servers.set(this.#id, this);
		this.#asked = options.port ?? 0;
		try {
			const { result } = await process.call<{ port: number }>("web.start", {
				host: this.#id,
				userData: this.#deps.userData,
				port: this.#asked,
				staticRoot: this.#deps.staticRoot(),
				router: this.#deps.router.config(),
			});
			this.#port = result.port;
			return result;
		} catch (error) {
			servers.delete(this.#id);
			throw error;
		}
	}

	/** Pending approvals are declined, sockets close (1001, a second's grace) and the port is let go. */
	async stop(): Promise<void> {
		if (this.#port === null) return;
		this.#port = null;
		this.#deps.confirmations.declineAll();
		try {
			await core().call("web.stop", { host: this.#id });
		} finally {
			servers.delete(this.#id);
		}
	}

	/** One question of the edge (`web.ask`). */
	async answerAsk(ask: EdgeAsk): Promise<unknown> {
		const { policy } = this.#deps;
		switch (ask.kind) {
			case "policy":
				return {
					host: policy.host,
					publicPort: policy.publicPort,
					secure: policy.secure,
					servePrefix: policy.servePrefix,
					pendingPrefix: policy.pendingPrefix ?? null,
					allowedUsers: [...policy.allowedUsers()],
				};
			case "confirmNew":
				return this.#deps.confirmNewDevices();
			case "confirm":
				return this.#deps.confirmations.request({
					name: ask.name ?? "",
					userAgent: ask.userAgent ?? "",
					tailscaleLogin: ask.tailscaleLogin ?? null,
					ip: ask.ip ?? null,
				});
			case "whois":
				return this.#deps.whois(ask.address ?? "");
			case "hook": {
				const service = this.#deps.hooks?.();
				if (!service) return "unavailable";
				return service.webhook(ask.id ?? "", ask.bearer ?? "", ask.detail ?? "");
			}
		}
	}

	deviceConnected(device: { id: string; name: string; tailscaleLogin: string | null }): void {
		this.#deps.onDeviceConnected(device);
	}

	unpairedAuth(address: string): void {
		this.#deps.onUnpairedAuth?.({ address });
	}

	/** The core ended with the edge in it: its sockets are gone, and the edge listens again on the same port. */
	coreExited(): void {
		if (this.#port === null) return;
		const port = this.#port;
		this.#port = null;
		this.start({ port: this.#asked === 0 ? port : this.#asked }).catch(error =>
			this.#deps.log?.(`web: the server could not start again after the core ended: ${String(error)}`),
		);
	}
}
