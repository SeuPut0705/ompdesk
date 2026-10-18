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

export interface ServeProxyOptions {
	/**
	 * WebKit drops a `Secure` cookie on `http://localhost`, so the page never stays paired: the proxy hands the
	 * page the device cookie under a plain name without `Secure` and gives the app its real name back.
	 */
	plainCookie?: boolean;
}

export class ServeProxy {
	readonly #server: http.Server;
	readonly #login: string;
	readonly #address: string;
	readonly #plainCookie: boolean;
	readonly #sockets = new Set<net.Socket>();
	#target: ServeSite;

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

	/** Cut every WebSocket the page has open (a network blip): the page reconnects on its own. */
	dropSockets(): void {
		for (const socket of this.#sockets) socket.destroy();
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
				res.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	}

	#upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
		const upstream = net.connect(Number(this.#target.port), "127.0.0.1", () => {
			const headers = this.#headers(req);
			const lines = [`${req.method} ${this.#target.prefix}${req.url ?? "/"} HTTP/1.1`];
			for (const [name, value] of Object.entries(headers)) {
				if (value === undefined) continue;
				for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
			}
			upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (head.length > 0) upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		this.#sockets.add(socket);
		const end = () => {
			this.#sockets.delete(socket);
			socket.destroy();
			upstream.destroy();
		};
		upstream.on("error", end);
		socket.on("error", end);
		upstream.on("close", end);
		socket.on("close", end);
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#server.closeAllConnections();
		await new Promise<void>(resolve => this.#server.close(() => resolve()));
	}
}
