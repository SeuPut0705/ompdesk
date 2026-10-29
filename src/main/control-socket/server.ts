/**
 * The control socket itself: a `node:net` server on a Unix socket (owner only) or a Windows named pipe, never on TCP.
 * It frames JSON lines, makes the first line prove the token, and hands every later request to the router. Nothing
 * here knows what a request means.
 */

import { timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
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

export interface ControlServerOptions {
	token: string;
	router: ControlRouter;
	helloTimeoutMs?: number;
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
	readonly #server: Server;
	readonly #connections = new Set<Socket>();
	#path: string | undefined;

	constructor({ token, router, helloTimeoutMs = HELLO_TIMEOUT_MS }: ControlServerOptions) {
		this.#router = router;
		this.#expectedToken = Buffer.from(token);
		this.#helloTimeoutMs = helloTimeoutMs;
		this.#server = createServer(socket => this.#accept(socket));
	}

	/** Listens on `path` and resolves once it takes connections. A stale socket file of a dead OMPdesk is replaced. */
	async listen(path: string): Promise<void> {
		const posix = process.platform !== "win32";
		if (posix) removeStaleSocket(path);
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
		this.#path = path;
		if (posix) chmodSync(path, OWNER_ONLY_FILE);
	}

	async close(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#server.close(() => resolve());
		for (const socket of this.#connections) socket.destroy();
		await promise;
		if (this.#path !== undefined && process.platform !== "win32") rmSync(this.#path, { force: true });
		this.#path = undefined;
	}

	#accept(socket: Socket): void {
		this.#connections.add(socket);
		const abort = new AbortController();
		let authenticated: ConnectionContext | undefined;
		let closing = false;
		let lingerTimer: NodeJS.Timeout | undefined;

		const send = (response: ControlResponse): void => {
			if (socket.writable) socket.write(`${JSON.stringify(response)}\n`);
		};
		// Ends our side and keeps discarding input: closing on unread input would reset the connection and lose the
		// answer. The client closes on seeing our end; the timer is only for one that never does.
		const hangUp = (response?: ControlResponse): void => {
			closing = true;
			clearTimeout(helloTimer);
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
			write: line => socket.write(line),
			onDrain: callback => {
				socket.once("drain", callback);
			},
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
				const caller = outsideCaller(frame);
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
			const request = frame as unknown as RoutedRequest;
			void this.#router.handle(request, authenticated).then(send);
		};

		let pending: Buffer[] = [];
		let pendingBytes = 0;
		const oversize = (): void =>
			hangUp(reply(0, "bad_request", `A request line is at most ${MAX_FRAME_BYTES} bytes`));

		socket.on("data", chunk => {
			let from = 0;
			while (!closing && from < chunk.length) {
				const end = chunk.indexOf(NEWLINE, from);
				if (end < 0) {
					pendingBytes += chunk.length - from;
					if (pendingBytes > MAX_FRAME_BYTES) return oversize();
					pending.push(chunk.subarray(from));
					return;
				}
				const lineBytes = pendingBytes + (end - from);
				if (lineBytes > MAX_FRAME_BYTES) return oversize();
				const line = Buffer.concat([...pending, chunk.subarray(from, end)], lineBytes).toString("utf8");
				pending = [];
				pendingBytes = 0;
				from = end + 1;
				if (line.trim().length > 0) onLine(line);
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			closing = true;
			clearTimeout(helloTimer);
			clearTimeout(lingerTimer);
			abort.abort(new Error("The control connection closed"));
			this.#connections.delete(socket);
		});
	}

	#tokenMatches(given: unknown): boolean {
		if (typeof given !== "string") return false;
		const candidate = Buffer.from(given);
		return candidate.length === this.#expectedToken.length && timingSafeEqual(candidate, this.#expectedToken);
	}
}

function removeStaleSocket(path: string): void {
	try {
		if (lstatSync(path).isSocket()) rmSync(path, { force: true });
	} catch {
		// Nothing there: listen makes the file.
	}
}
