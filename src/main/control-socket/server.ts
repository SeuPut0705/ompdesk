/**
 * The control socket itself: a `node:net` server on a Unix socket (owner only) or a Windows named pipe, never on TCP.
 * It frames JSON lines, makes the first line prove the token, and hands every later request to the router. Nothing
 * here knows what a request means.
 */

import { timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, renameSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlErrorCode,
	type ControlResponse,
	MAX_FRAME_BYTES,
} from "../../../resources/cli/protocol";
import type { EventSink } from "./events";
import { type ConnectionContext, type ControlRouter, outsideCaller, type RoutedRequest } from "./router";

const NEWLINE = 0x0a;
const HELLO_TIMEOUT_MS = 10_000;
const LINGER_MS = 5_000;
const OWNER_ONLY_UMASK = 0o177;
const OWNER_ONLY_FILE = 0o600;
/** A line before the hello is at most this: nobody unauthenticated makes the server hold megabytes. */
const PRE_AUTH_FRAME_BYTES = 64 * 1024;
/** Connections at once; the next is turned away. */
const MAX_CONNECTIONS = 64;
/** A connection's requests running at once; past it the server stops reading that connection until one answers. */
const MAX_IN_FLIGHT = 16;

export interface ControlServerOptions {
	token: string;
	router: ControlRouter;
	helloTimeoutMs?: number;
	maxConnections?: number;
	maxInFlight?: number;
}

/** Another process already listens on the socket path: this one does not start over it. */
export class SocketInUse extends Error {
	constructor(path: string) {
		super(`${path} is in use by another process`);
		this.name = "SocketInUse";
	}
}

function parseFrame(line: string): Record<string, unknown> | undefined {
	try {
		const frame: unknown = JSON.parse(line);
		return typeof frame === "object" && frame !== null && !Array.isArray(frame) ? { ...frame } : undefined;
	} catch {
		return undefined;
	}
}

function reply(id: number, code: ControlErrorCode, message: string): ControlResponse {
	return { id, ok: false, error: { code, message } };
}

export class ControlServer {
	readonly #router: ControlRouter;
	readonly #expectedToken: Buffer;
	readonly #helloTimeoutMs: number;
	readonly #maxConnections: number;
	readonly #maxInFlight: number;
	readonly #server: Server;
	readonly #connections = new Set<Socket>();
	/** Numbers the connections: each one is its own caller (`outsideCaller`). */
	#accepted = 0;
	/** The socket file this server made (POSIX), so close removes only that one. */
	#made: { path: string; dev: number; ino: number } | undefined;

	constructor({
		token,
		router,
		helloTimeoutMs = HELLO_TIMEOUT_MS,
		maxConnections = MAX_CONNECTIONS,
		maxInFlight = MAX_IN_FLIGHT,
	}: ControlServerOptions) {
		this.#router = router;
		this.#expectedToken = Buffer.from(token);
		this.#helloTimeoutMs = helloTimeoutMs;
		this.#maxConnections = maxConnections;
		this.#maxInFlight = maxInFlight;
		this.#server = createServer(socket => this.#accept(socket));
	}

	/**
	 * Listens on `path` and resolves once it takes connections. A socket file left by a dead process (nothing answers
	 * on it) is replaced; one a live process listens on is left alone and the start fails (`SocketInUse`).
	 */
	async listen(path: string): Promise<void> {
		const posix = process.platform !== "win32";
		if (posix) await clearStaleSocket(path);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#server.once("error", reject);
		this.#server.once("listening", () => {
			this.#server.off("error", reject);
			resolve();
		});
		// The socket file is made by this synchronous call under the umask, so it never exists with wider access.
		const previousUmask = posix ? process.umask(OWNER_ONLY_UMASK) : undefined;
		try {
			this.#server.listen(path);
		} finally {
			if (previousUmask !== undefined) process.umask(previousUmask);
		}
		await promise;
		if (posix) {
			chmodSync(path, OWNER_ONLY_FILE);
			const made = lstatSync(path);
			this.#made = { path, dev: made.dev, ino: made.ino };
		}
	}

	async close(): Promise<void> {
		const made = this.#made;
		this.#made = undefined;
		// libuv unlinks the path a pipe server listened on when it closes, whatever is there now. A socket file another
		// process put there since (a newer OMPdesk) is moved aside for the close and put back, never deleted.
		let foreign: string | undefined;
		if (made) {
			try {
				const now = lstatSync(made.path);
				if (now.dev !== made.dev || now.ino !== made.ino) {
					foreign = `${made.path}.${process.pid}.keep`;
					renameSync(made.path, foreign);
				}
			} catch {
				// Nothing there now.
			}
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#server.close(() => resolve());
		for (const socket of this.#connections) socket.destroy();
		await promise;
		if (made && foreign) renameSync(foreign, made.path);
		else if (made) rmSync(made.path, { force: true });
	}

	#accept(socket: Socket): void {
		if (this.#connections.size >= this.#maxConnections) {
			socket.on("error", () => socket.destroy());
			socket.end(
				`${JSON.stringify(reply(0, "unavailable", "Too many connections to OMPdesk; try again shortly"))}\n`,
			);
			setTimeout(() => socket.destroy(), LINGER_MS).unref();
			return;
		}
		this.#connections.add(socket);
		const abort = new AbortController();
		const connection = ++this.#accepted;
		let authenticated: ConnectionContext | undefined;
		let closing = false;
		let lingerTimer: NodeJS.Timeout | undefined;
		/** Requests running now, lines read but not started yet, and whether the socket's writes are backed up. */
		let inFlight = 0;
		const queued: string[] = [];
		let writesBlocked = false;

		// Read more only while the requests running are under the cap and the answers are being taken.
		const flow = (): void => {
			if (closing) return;
			if (writesBlocked || inFlight >= this.#maxInFlight) socket.pause();
			else socket.resume();
		};
		const write = (text: string): boolean => {
			if (!socket.writable) return false;
			const taken = socket.write(text);
			if (!taken && !writesBlocked) {
				writesBlocked = true;
				socket.once("drain", () => {
					writesBlocked = false;
					flow();
				});
				flow();
			}
			return taken;
		};
		const send = (response: ControlResponse): void => {
			write(`${JSON.stringify(response)}\n`);
		};
		// Ends our side and keeps discarding input: closing on unread input would reset the connection and lose the
		// answer. The client closes on seeing our end; the timer is only for one that never does.
		const hangUp = (response?: ControlResponse): void => {
			closing = true;
			clearTimeout(helloTimer);
			queued.length = 0;
			socket.resume();
			if (!socket.writable) {
				socket.destroy();
				return;
			}
			if (response === undefined) socket.end();
			else socket.end(`${JSON.stringify(response)}\n`);
			lingerTimer = setTimeout(() => socket.destroy(), LINGER_MS);
			lingerTimer.unref();
		};
		const helloTimer = setTimeout(() => hangUp(), this.#helloTimeoutMs);

		const sink: EventSink = {
			write,
			onDrain: callback => {
				socket.once("drain", callback);
			},
		};

		const start = (context: ConnectionContext, request: RoutedRequest): void => {
			inFlight++;
			flow();
			void this.#router.handle(request, context).then(response => {
				inFlight--;
				send(response);
				pump();
				flow();
			});
		};

		const onLine = (line: string): void => {
			const frame = parseFrame(line);
			const id = typeof frame?.id === "number" ? frame.id : 0;
			if (authenticated === undefined) {
				if (frame === undefined || frame.method !== "hello") {
					hangUp(reply(id, "unauthorized", "The first request must be hello with the token"));
					return;
				}
				if (!this.#tokenMatches(frame.token)) {
					hangUp(reply(id, "unauthorized", "Wrong token"));
					return;
				}
				if (frame.protocol !== CONTROL_PROTOCOL_VERSION) {
					hangUp(
						reply(
							id,
							"protocol_mismatch",
							`This OMPdesk speaks protocol ${CONTROL_PROTOCOL_VERSION}, the client sent ${String(frame.protocol)}`,
						),
					);
					return;
				}
				clearTimeout(helloTimer);
				const caller = outsideCaller(frame, connection);
				authenticated = { caller, sink, signal: abort.signal };
				send({ id, ok: true, result: { protocol: CONTROL_PROTOCOL_VERSION, caller: caller.id } });
				return;
			}
			if (frame === undefined || typeof frame.id !== "number" || typeof frame.method !== "string") {
				send(reply(id, "bad_request", "A request is a JSON object with a numeric id and a method"));
				return;
			}
			if (frame.method === "hello") {
				send(reply(id, "bad_request", "hello was already sent"));
				return;
			}
			// The router checks every field of the request it handles, so the shape is only trusted from there on.
			start(authenticated, frame as unknown as RoutedRequest);
		};

		// Lines are taken one by one, a new one only while the cap allows (a chunk may hold many).
		const pump = (): void => {
			while (!closing && queued.length > 0 && inFlight < this.#maxInFlight) {
				const line = queued.shift();
				if (line !== undefined) onLine(line);
			}
		};

		let pending: Buffer[] = [];
		let pendingBytes = 0;
		const limit = (): number => (authenticated === undefined ? PRE_AUTH_FRAME_BYTES : MAX_FRAME_BYTES);
		const oversize = (): void => hangUp(reply(0, "bad_request", `A request line is at most ${limit()} bytes`));

		socket.on("data", chunk => {
			let from = 0;
			while (!closing && from < chunk.length) {
				const end = chunk.indexOf(NEWLINE, from);
				if (end < 0) {
					pendingBytes += chunk.length - from;
					if (pendingBytes > limit()) return oversize();
					pending.push(chunk.subarray(from));
					break;
				}
				const lineBytes = pendingBytes + (end - from);
				if (lineBytes > limit()) return oversize();
				const line = Buffer.concat([...pending, chunk.subarray(from, end)], lineBytes).toString("utf8");
				pending = [];
				pendingBytes = 0;
				from = end + 1;
				if (line.trim().length === 0) continue;
				// The hello decides the limit of every later line, so it is never queued behind anything.
				if (authenticated === undefined && queued.length === 0) onLine(line);
				else queued.push(line);
				pump();
			}
			flow();
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			closing = true;
			queued.length = 0;
			clearTimeout(helloTimer);
			clearTimeout(lingerTimer);
			abort.abort(new Error("The control connection closed"));
			if (authenticated) this.#router.release(authenticated.caller);
			this.#connections.delete(socket);
		});
	}

	#tokenMatches(given: unknown): boolean {
		if (typeof given !== "string") return false;
		const candidate = Buffer.from(given);
		return candidate.length === this.#expectedToken.length && timingSafeEqual(candidate, this.#expectedToken);
	}
}

/**
 * A socket file at `path` is replaced only when nobody answers on it (a dead OMPdesk left it). A live listener, or
 * anything that is no socket, stops the start: never delete what another process serves.
 */
async function clearStaleSocket(path: string): Promise<void> {
	let isSocket: boolean;
	try {
		isSocket = lstatSync(path).isSocket();
	} catch {
		return;
	}
	if (!isSocket) throw new SocketInUse(path);
	const { promise, resolve } = Promise.withResolvers<"live" | "dead">();
	const probe = connect(path);
	probe.once("connect", () => {
		probe.destroy();
		resolve("live");
	});
	probe.once("error", (error: NodeJS.ErrnoException) =>
		resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "dead" : "live"),
	);
	if ((await promise) === "live") throw new SocketInUse(path);
	rmSync(path, { force: true });
}
