/**
 * A real phone page against the built app: `tailscale serve`'s part played by a loopback proxy. Serve hands a
 * tailnet request on to OMPdesk's handler (`http://127.0.0.1:<port>/<secret>/`) with the caller's
 * `Tailscale-User-Login` and address, and the page's origin is the published `https://<site>`. The proxy does the
 * same for a browser on `http://localhost:<proxy>`: it prefixes the secret path, sets `Host`/`Origin` to the
 * site, adds the login and address, and passes WebSocket upgrades through. Its target follows the app across a
 * relaunch (`retarget`), as serve keeps the same address while the handler behind it changes.
 */
import * as http from "node:http";
import * as net from "node:net";
import type { FixtureTailscale } from "./fake-tailscale-install";

/** One of OMPdesk's published serve handlers: its address, the loopback port it proxies to and the secret path. */
export interface ServeSite {
	site: string;
	port: string;
	prefix: string;
}

/**
 * OMPdesk's handlers in the fake serve config (the user's own `:443` one is left out). A relaunch whose loopback
 * port differs from the last run's publishes on the next free address and leaves the old handler.
 */
export function serveSites(tailscale: FixtureTailscale): ServeSite[] {
	return Object.entries(tailscale.scenario().serve.Web ?? {}).flatMap(([site, web]) => {
		const target = web.Handlers["/"]?.Proxy;
		if (!target || site.endsWith(":443")) return [];
		const { port, pathname } = new URL(target);
		return [{ site, port, prefix: pathname.replace(/\/$/, "") }];
	});
}

/** The device cookie serve's HTTPS origin gets, and the name a `plainCookie` proxy gives it on `http://localhost`. */
const DEVICE_COOKIE = "__Host-ompdesk";
const PLAIN_COOKIE = "ompdesk-e2e";

/** A phone's network (e2e/web-perf.e2e.ts): every byte between the page and the app crosses it. */
export interface LinkProfile {
	/** Round trip; half of it is added each way, and one more to a new connection's first request (its handshake). */
	rttMs: number;
	downKbps: number;
	upKbps: number;
}

/** Bytes the page received and sent through the proxy, as they crossed the wire (compressed if the app compressed). */
export interface WireBytes {
	httpDown: number;
	httpRequests: number;
	wsDown: number;
	wsUp: number;
	wsFramesDown: number;
}

export interface ServeProxyOptions {
	/**
	 * WebKit drops a `Secure` cookie on `http://localhost`, so the page never stays paired: the proxy hands the
	 * page the device cookie under a plain name without `Secure` and gives the app its real name back.
	 */
	plainCookie?: boolean;
	/** Shape the traffic like this link (unset: loopback speed). `setLink` changes it later. */
	link?: LinkProfile;
}

/**
 * One direction of a shaped link: what is sent leaves in order, each chunk after the ones before it are through
 * (the bandwidth), and arrives half a round trip later. One timer drains the queue, so order is never lost.
 */
class LinkPipe {
	#free = 0;
	#queue: { at: number; deliver: () => void }[] = [];
	#timer: NodeJS.Timeout | undefined;

	send(link: LinkProfile, kbps: number, bytes: number, deliver: () => void, extraMs = 0): void {
		const now = performance.now();
		const start = Math.max(now, this.#free);
		this.#free = start + (bytes * 8) / kbps;
		const at = Math.max(this.#queue.at(-1)?.at ?? 0, this.#free + link.rttMs / 2 + extraMs);
		this.#queue.push({ at, deliver });
		this.#arm();
	}

	#arm(): void {
		const next = this.#queue[0];
		if (this.#timer || !next) return;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				const now = performance.now();
				while (this.#queue[0] && this.#queue[0].at <= now + 0.5) this.#queue.shift()?.deliver();
				this.#arm();
			},
			Math.max(0, next.at - performance.now()),
		);
	}
}

export class ServeProxy {
	readonly #server: http.Server;
	readonly #login: string;
	readonly #address: string;
	readonly #plainCookie: boolean;
	readonly #sockets = new Set<net.Socket>();
	readonly #down = new LinkPipe();
	readonly #up = new LinkPipe();
	/** Client connections that have sent a request already (a new one pays its handshake once). */
	readonly #warm = new WeakSet<net.Socket>();
	/** Requests held by `hold` until released: the path and when it may go. */
	readonly #holds = new Set<{ path: string; until: Promise<void> }>();
	#link: LinkProfile | undefined;
	#target: ServeSite;
	readonly bytes: WireBytes = { httpDown: 0, httpRequests: 0, wsDown: 0, wsUp: 0, wsFramesDown: 0 };

	private constructor(
		server: http.Server,
		target: ServeSite,
		login: string,
		address: string,
		options: ServeProxyOptions,
	) {
		this.#server = server;
		this.#target = target;
		this.#login = login;
		this.#address = address;
		this.#plainCookie = options.plainCookie === true;
		this.#link = options.link;
	}

	static async start(
		target: ServeSite,
		login: string,
		address = "100.64.0.9",
		options: ServeProxyOptions = {},
	): Promise<ServeProxy> {
		const server = http.createServer();
		const proxy = new ServeProxy(server, target, login, address, options);
		server.on("request", (req, res) => proxy.#forward(req, res));
		server.on("upgrade", (req, socket, head) => proxy.#upgrade(req, socket as net.Socket, head));
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		return proxy;
	}

	/** The page's address. `localhost` is a secure context, so WebCrypto, `Secure` cookies and the worker work. */
	get url(): string {
		const address = this.#server.address();
		if (!address || typeof address === "string") throw new Error("proxy not listening");
		return `http://localhost:${address.port}`;
	}

	retarget(target: ServeSite): void {
		this.#target = target;
	}

	setLink(link: LinkProfile | undefined): void {
		this.#link = link;
	}

	/** Up the link to the app: `deliver` runs once the bytes would have arrived. */
	#sendUp(socket: net.Socket, bytes: number, deliver: () => void): void {
		const link = this.#link;
		if (!link) return deliver();
		const handshake = this.#warm.has(socket) ? 0 : link.rttMs;
		this.#warm.add(socket);
		this.#up.send(link, link.upKbps, bytes, deliver, handshake);
	}

	/** Down the link to the page. */
	#sendDown(bytes: number, deliver: () => void): void {
		const link = this.#link;
		if (!link) return deliver();
		this.#down.send(link, link.downKbps, bytes, deliver);
	}

	/** Cut every WebSocket the page has open (a network blip): the page reconnects on its own. */
	dropSockets(): void {
		for (const socket of this.#sockets) socket.destroy();
	}

	/**
	 * Hold every request whose path is `path` here, with its body unread, until `release` (a test's way to see the
	 * page while an upload is on its way). Never hold it in the browser with `page.route`: WebKit's interception can
	 * continue a multipart request with the inspector's copy of the body, which leaves a picked file's bytes out
	 * (the host got `report.pdf` empty, 1 in about 30 under load).
	 */
	hold(path: string): { release(): void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		const held = { path, until: promise };
		this.#holds.add(held);
		return {
			release: () => {
				this.#holds.delete(held);
				resolve();
			},
		};
	}

	#headers(req: http.IncomingMessage): http.OutgoingHttpHeaders {
		const headers: http.OutgoingHttpHeaders = { ...req.headers };
		headers.host = this.#target.site;
		if (headers.origin) headers.origin = `https://${this.#target.site}`;
		Reflect.deleteProperty(headers, "referer");
		headers["tailscale-user-login"] = this.#login;
		headers["x-forwarded-for"] = this.#address;
		if (this.#plainCookie && typeof headers.cookie === "string") {
			headers.cookie = headers.cookie.replaceAll(`${PLAIN_COOKIE}=`, `${DEVICE_COOKIE}=`);
		}
		return headers;
	}

	#forward(req: http.IncomingMessage, res: http.ServerResponse): void {
		const pathOnly = (req.url ?? "/").split("?")[0];
		const held = [...this.#holds].filter(hold => hold.path === pathOnly).map(hold => hold.until);
		if (held.length > 0) {
			void Promise.all(held).then(() => this.#forward(req, res));
			return;
		}
		this.bytes.httpRequests++;
		this.#sendUp(req.socket, 0, () => {
			const upstream = http.request(
				{
					host: "127.0.0.1",
					port: this.#target.port,
					path: `${this.#target.prefix}${req.url ?? "/"}`,
					method: req.method,
					headers: this.#headers(req),
				},
				answer => {
					// The device cookie is `__Host-` and `Secure`; Chromium keeps it on `http://localhost`, WebKit does not.
					const cookies = answer.headers["set-cookie"];
					if (this.#plainCookie && cookies) {
						answer.headers["set-cookie"] = cookies.map(cookie =>
							cookie.replace(`${DEVICE_COOKIE}=`, `${PLAIN_COOKIE}=`).replace(/;\s*Secure/i, ""),
						);
					}
					if (!this.#link) {
						answer.on("data", (chunk: Buffer) => {
							this.bytes.httpDown += chunk.length;
						});
						res.writeHead(answer.statusCode ?? 502, answer.headers);
						answer.pipe(res);
						return;
					}
					this.#sendDown(0, () => res.writeHead(answer.statusCode ?? 502, answer.headers));
					answer.on("data", (chunk: Buffer) => {
						this.bytes.httpDown += chunk.length;
						this.#sendDown(chunk.length, () => res.write(chunk));
					});
					answer.on("end", () => this.#sendDown(0, () => res.end()));
				},
			);
			upstream.on("error", () => {
				if (!res.headersSent) res.writeHead(502);
				res.end();
			});
			req.pipe(upstream);
		});
	}

	#upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
		this.#sockets.add(socket);
		let upstream: net.Socket | null = null;
		const end = () => {
			this.#sockets.delete(socket);
			socket.destroy();
			upstream?.destroy();
		};
		socket.on("error", end);
		socket.on("close", end);
		this.#sendUp(socket, 0, () => {
			if (socket.destroyed) return;
			const target = net.connect(Number(this.#target.port), "127.0.0.1", () => {
				const headers = this.#headers(req);
				const lines = [`${req.method} ${this.#target.prefix}${req.url ?? "/"} HTTP/1.1`];
				for (const [name, value] of Object.entries(headers)) {
					if (value === undefined) continue;
					for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
				}
				target.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length > 0) target.write(head);
				target.on("data", (chunk: Buffer) => {
					this.bytes.wsDown += chunk.length;
					this.bytes.wsFramesDown++;
					this.#sendDown(chunk.length, () => {
						if (!socket.destroyed) socket.write(chunk);
					});
				});
				socket.on("data", (chunk: Buffer) => {
					this.bytes.wsUp += chunk.length;
					this.#sendUp(socket, chunk.length, () => {
						if (!target.destroyed) target.write(chunk);
					});
				});
			});
			upstream = target;
			target.on("error", end);
			target.on("close", end);
		});
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#server.closeAllConnections();
		await new Promise<void>(resolve => this.#server.close(() => resolve()));
	}
}
