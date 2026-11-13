/**
 * Electron's `net` through the shell's `net.*` (PROTOCOL.md §10): Chromium's network stack (the system proxy, PAC
 * and certificate store) behind `net.fetch`, the streaming `ClientRequest` (`net.request`) that `updater.ts` and
 * electron-updater's download use, `net.isOnline()` (mirrored) and `net.resolveHost`.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { Host } from "./host";

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** What the shell reports of an HTTP authentication challenge: Electron's `authInfo`. */
interface AuthInfo {
	isProxy: boolean;
	scheme: string;
	host: string;
	port: number;
	realm: string;
}

/** The credentials a `login` listener gave, or null: no listener, or `callback()` with none (the challenge stands). */
type LoginAnswer = (info: AuthInfo) => Promise<{ username: string; password: string } | null>;

interface FetchHead {
	status: number;
	statusText: string;
	url: string;
	redirected: boolean;
	headers: Array<[string, string]>;
}

export function createNet(host: Host) {
	const { client } = host;
	const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
	let nextRequest = 1;
	let online = host.facts.system.online;
	/** The `login` answerers of the requests in flight, by request id; a request is over when its stream is. */
	const logins = new Map<number, LoginAnswer>();
	client.on("net.chunk", ({ reqId }: { reqId: number }, bin?: Buffer) => {
		if (bin) streams.get(reqId)?.enqueue(new Uint8Array(bin));
	});
	client.on("net.end", ({ reqId, error }: { reqId: number; error?: string }) => {
		const controller = streams.get(reqId);
		if (!controller) return;
		streams.delete(reqId);
		logins.delete(reqId);
		if (error) controller.error(new TypeError(error));
		else controller.close();
	});
	// An HTTP authentication challenge (server or proxy) of a request in flight (PROTOCOL.md §10): Electron's `login`.
	client.handle("net.login", async ({ reqId, ...info }: { reqId: number } & AuthInfo) => {
		const credentials = await logins.get(reqId)?.(info);
		return credentials ?? { cancel: true };
	});
	client.on("net.online", (data: { online: boolean }) => {
		online = data.online;
	});

	async function fetchViaShell(
		input: string | URL | Request,
		init: RequestInit & { bypassCustomProtocolHandlers?: boolean; partition?: string; login?: LoginAnswer } = {},
	): Promise<Response> {
		const request = new Request(input, init);
		const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
		const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
		const reqId = nextRequest++;
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start: c => {
				controller = c;
			},
			cancel: () => {
				logins.delete(reqId);
				if (streams.delete(reqId)) void client.event("net.cancel", { reqId });
			},
		});
		streams.set(reqId, controller);
		if (init.login) logins.set(reqId, init.login);
		let head: FetchHead;
		try {
			head = (
				await client.request<FetchHead>(
					"net.fetch",
					{
						reqId,
						url: request.url,
						method: request.method,
						headers: [...request.headers.entries()],
						hasBody,
						redirect: request.redirect,
						credentials: request.credentials,
						cache: request.cache,
						...(init.partition ? { partition: init.partition } : {}),
						...(init.bypassCustomProtocolHandlers ? { bypassCustomProtocolHandlers: true } : {}),
					},
					{ ...(body ? { bin: body } : {}), signal: request.signal },
				)
			).result;
		} catch (error) {
			streams.delete(reqId);
			logins.delete(reqId);
			if (request.signal.aborted)
				throw request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
			throw new TypeError(error instanceof Error ? error.message : String(error));
		}
		request.signal.addEventListener(
			"abort",
			() => {
				if (!streams.delete(reqId)) return;
				logins.delete(reqId);
				void client.event("net.cancel", { reqId });
				controller.error(request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
			},
			{ once: true },
		);
		const response = new Response(NULL_BODY_STATUS.has(head.status) ? null : stream, {
			status: head.status,
			statusText: head.statusText,
			headers: head.headers,
		});
		Object.defineProperties(response, {
			url: { value: head.url },
			redirected: { value: head.redirected },
		});
		return response;
	}

	interface RequestOptions {
		url?: string;
		method?: string;
		protocol?: string;
		host?: string;
		hostname?: string;
		port?: number | string;
		path?: string;
		redirect?: "follow" | "manual" | "error";
		headers?: Record<string, string | string[]>;
		/** The session whose network context carries the request (`session.fromPartition(…)`); the default one if none. */
		session?: { partition?: string };
	}

	class ClientResponse extends Readable {
		readonly statusCode: number;
		readonly statusMessage: string;
		readonly headers: Record<string, string | string[]>;
		readonly #reader: ReadableStreamDefaultReader<Uint8Array> | null;

		constructor(response: Response) {
			super();
			this.statusCode = response.status;
			this.statusMessage = response.statusText;
			this.headers = {};
			for (const [name, value] of response.headers.entries()) {
				const known = this.headers[name];
				this.headers[name] =
					known === undefined ? value : Array.isArray(known) ? [...known, value] : [known, value];
			}
			this.#reader = response.body?.getReader() ?? null;
		}

		override _read(): void {
			if (!this.#reader) {
				this.push(null);
				return;
			}
			this.#reader.read().then(
				({ done, value }) => {
					if (done) this.push(null);
					else this.push(Buffer.from(value));
				},
				(error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))),
			);
		}

		override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
			void this.#reader?.cancel().catch(() => undefined);
			callback(error);
		}
	}

	class ClientRequest extends EventEmitter {
		readonly #options: RequestOptions;
		readonly #headers = new Map<string, string>();
		readonly #chunks: Buffer[] = [];
		readonly #controller = new AbortController();
		#ended = false;

		constructor(options: RequestOptions | string) {
			super();
			this.#options = typeof options === "string" ? { url: options } : options;
			for (const [name, value] of Object.entries(this.#options.headers ?? {})) {
				this.#headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
			}
		}

		setHeader(name: string, value: string): void {
			this.#headers.set(name.toLowerCase(), value);
		}

		getHeader(name: string): string | undefined {
			return this.#headers.get(name.toLowerCase());
		}

		removeHeader(name: string): void {
			this.#headers.delete(name.toLowerCase());
		}

		write(chunk: string | Buffer, encoding?: BufferEncoding): boolean {
			this.#chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
			return true;
		}

		end(chunk?: string | Buffer, encoding?: BufferEncoding): void {
			if (this.#ended) return;
			this.#ended = true;
			if (chunk !== undefined) this.write(chunk, encoding);
			void this.#run();
		}

		abort(): void {
			this.#controller.abort();
		}

		#url(): string {
			const options = this.#options;
			if (options.url) return options.url;
			const protocol = options.protocol ?? "https:";
			const host = options.hostname ?? options.host ?? "localhost";
			const port = options.port === undefined ? "" : `:${options.port}`;
			return `${protocol}//${host}${port}${options.path ?? "/"}`;
		}

		/** Electron's `login`: `callback(username, password)` answers the challenge, `callback()` leaves it as it is. */
		#login(info: AuthInfo): Promise<{ username: string; password: string } | null> {
			const { promise, resolve } = Promise.withResolvers<{ username: string; password: string } | null>();
			const answered = this.emit("login", info, (username?: string, password?: string) =>
				resolve(username === undefined ? null : { username, password: password ?? "" }),
			);
			if (!answered) resolve(null);
			return promise;
		}

		async #run(): Promise<void> {
			const method = (this.#options.method ?? "GET").toUpperCase();
			const redirect = this.#options.redirect ?? "follow";
			try {
				const response = await fetchViaShell(this.#url(), {
					method,
					headers: Object.fromEntries(this.#headers),
					redirect,
					signal: this.#controller.signal,
					...(this.#options.session?.partition ? { partition: this.#options.session.partition } : {}),
					login: info => this.#login(info),
					...(this.#chunks.length > 0 && method !== "GET" && method !== "HEAD"
						? { body: Buffer.concat(this.#chunks) }
						: {}),
				});
				const location = response.headers.get("location");
				if (redirect === "manual" && response.status >= 300 && response.status < 400 && location) {
					void response.body?.cancel();
					this.emit(
						"redirect",
						response.status,
						method,
						new URL(location, this.#url()).toString(),
						Object.fromEntries(response.headers),
					);
					return;
				}
				this.emit("response", new ClientResponse(response));
			} catch (error) {
				if (this.#controller.signal.aborted) {
					this.emit("abort");
					return;
				}
				this.emit("error", error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	return {
		fetch: fetchViaShell,
		request: (options: RequestOptions | string): ClientRequest => new ClientRequest(options),
		isOnline: (): boolean => online,
		async resolveHost(
			hostname: string,
			options?: { cacheUsage?: string },
		): Promise<{ endpoints: Array<{ address: string; family: "ipv4" | "ipv6" }> }> {
			return client.call("net.resolveHost", {
				host: hostname,
				...(options?.cacheUsage ? { cacheUsage: options.cacheUsage } : {}),
			});
		},
	};
}
