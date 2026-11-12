/**
 * Node's end of the host protocol (native/ompdesk/crates/shell/PROTOCOL.md): requests both ways, answers, events and
 * `{cancel: id}` over one duplex stream (the named pipe / unix socket the shell hands Node in
 * `OMPDESK_SHELL_SOCKET`), framed as the core's wire (`wire.ts`). One writer: every frame is a single `write`, so
 * frames never interleave. A dropped stream rejects every request still waiting and ends the client.
 */
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { encodeFrame, FrameReader } from "./wire";

/** An error answer (or a connection that ended) as a request sees it: `code` is the protocol's. */
export class HostError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HostError";
		this.code = code;
	}
}

/** What a request handler returns when its answer carries raw bytes. */
export class Answered {
	readonly result: unknown;
	readonly bin: Uint8Array;
	constructor(result: unknown, bin: Uint8Array) {
		this.result = result;
		this.bin = bin;
	}
}

export interface Answer<T> {
	result: T;
	bin?: Buffer;
}

export interface RequestOptions {
	/** Raw bytes sent with the request (`bin`). */
	bin?: Uint8Array;
	/** Aborting sends `{cancel: id}`; the request then rejects with `code: "cancelled"`. */
	signal?: AbortSignal;
}

export interface HandlerContext {
	/** The request's own `bin` tail. */
	bin?: Buffer;
	/** Aborted when the other side sent `{cancel: id}` or the connection ended. */
	signal: AbortSignal;
}

/** Handles a request the other side made; the value (or an `Answered`) is the answer, a throw is an error answer. */
export type RequestHandler = (params: never, context: HandlerContext) => unknown;
export type EventListener = (data: never, bin?: Buffer) => void;

interface Pending {
	resolve(answer: Answer<unknown>): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class ShellClient {
	readonly #stream: Duplex;
	readonly #reader: FrameReader;
	readonly #pending = new Map<number, Pending>();
	readonly #running = new Map<number, AbortController>();
	readonly #handlers = new Map<string, RequestHandler>();
	readonly #listeners = new Map<string, Set<EventListener>>();
	readonly #closeListeners = new Set<(reason: Error | undefined) => void>();
	#nextId = 1;
	#closed = false;
	#closeReason: Error | undefined;
	/** Writes that returned false (the stream's buffer is full) and are not drained yet. */
	#draining: Promise<void> | null = null;

	constructor(stream: Duplex, onSkip: (reason: string) => void = reason => console.warn(`[shell-host] ${reason}`)) {
		this.#stream = stream;
		this.#reader = new FrameReader(onSkip);
		stream.on("data", (chunk: Buffer) => this.#receive(chunk));
		stream.on("error", error => this.#end(error));
		stream.on("close", () => this.#end(undefined));
		stream.on("end", () => this.#end(undefined));
	}

	/** Connects to the shell's socket. */
	static connect(path: string): Promise<ShellClient> {
		const { promise, resolve, reject } = Promise.withResolvers<ShellClient>();
		const socket = connect(path);
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.off("error", reject);
			socket.setNoDelay(true);
			resolve(new ShellClient(socket));
		});
		return promise;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Why the connection ended; undefined while it is open or when it ended cleanly. */
	get closeReason(): Error | undefined {
		return this.#closeReason;
	}

	/** Runs `listener` once the connection has ended (at once when it already has). */
	onClose(listener: (reason: Error | undefined) => void): void {
		if (this.#closed) listener(this.#closeReason);
		else this.#closeListeners.add(listener);
	}

	/** A request to the shell. Rejects with `HostError` for an error answer or a connection that ended. */
	request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<Answer<T>> {
		if (this.#closed) return Promise.reject(new HostError("gone", "the shell connection is closed"));
		const { signal } = options;
		if (signal?.aborted) return Promise.reject(new HostError("cancelled", `${method} was cancelled`));
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<Answer<T>>();
		const pending: Pending = { resolve: resolve as Pending["resolve"], reject, signal };
		if (signal) {
			pending.onAbort = () => {
				if (!this.#pending.delete(id)) return;
				this.#write({ cancel: id });
				reject(new HostError("cancelled", `${method} was cancelled`));
			};
			signal.addEventListener("abort", pending.onAbort, { once: true });
		}
		this.#pending.set(id, pending);
		this.#write({ id, method, params: params ?? null }, options.bin);
		return promise;
	}

	/** A request whose result is all that matters. */
	async call<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
		return (await this.request<T>(method, params, options)).result;
	}

	/** An event to the shell. Resolves once the bytes left Node's buffer (a streamed body waits on it). */
	event(name: string, data: unknown = {}, bin?: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#write({ event: name, data }, bin);
		return this.#draining ?? Promise.resolve();
	}

	/** The handler of a request the shell makes. One per method. */
	handle(method: string, handler: RequestHandler): void {
		this.#handlers.set(method, handler);
	}

	/** A listener of the shell's event `name`; returns what removes it. */
	on(name: string, listener: EventListener): () => void {
		const set = this.#listeners.get(name) ?? new Set<EventListener>();
		this.#listeners.set(name, set);
		set.add(listener);
		return () => set.delete(listener);
	}

	/** Resolves once every frame written so far left Node's buffer. */
	flush(): Promise<void> {
		return this.#draining ?? Promise.resolve();
	}

	/** Ends the connection. */
	close(): void {
		this.#stream.end();
		this.#end(undefined);
	}

	#write(head: Record<string, unknown>, bin?: Uint8Array): void {
		const frame = encodeFrame(head, bin);
		if (this.#stream.write(frame)) return;
		if (this.#draining) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#draining = promise;
		this.#stream.once("drain", () => {
			this.#draining = null;
			resolve();
		});
		// An ended stream never drains: the waiting writers must not hang with it.
		this.#closeListeners.add(() => resolve());
	}

	#receive(chunk: Buffer): void {
		for (const { head, bin } of this.#reader.push(chunk)) this.#dispatch(head, bin);
	}

	#dispatch(head: Record<string, unknown>, bin: Buffer | undefined): void {
		if (typeof head.method === "string" && typeof head.id === "number") {
			this.#serve(head.id, head.method, head.params, bin);
		} else if (typeof head.event === "string") {
			for (const listener of [...(this.#listeners.get(head.event) ?? [])]) {
				try {
					listener(head.data as never, bin);
				} catch (error) {
					console.warn(
						`[shell-host] event ${head.event}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
					);
				}
			}
		} else if (typeof head.id === "number" && typeof head.ok === "boolean") {
			this.#answer(head.id, head.ok, head.ok ? head.result : head.error, bin);
		} else if (typeof head.cancel === "number") {
			this.#running.get(head.cancel)?.abort();
		}
	}

	#answer(id: number, ok: boolean, payload: unknown, bin: Buffer | undefined): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
		if (ok) {
			pending.resolve({ result: payload, ...(bin === undefined ? {} : { bin }) });
			return;
		}
		const error = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
		pending.reject(
			new HostError(
				typeof error.code === "string" ? error.code : "failed",
				typeof error.message === "string" ? error.message : "request failed",
			),
		);
	}

	#serve(id: number, method: string, params: unknown, bin: Buffer | undefined): void {
		const handler = this.#handlers.get(method);
		if (!handler) {
			this.#write({ id, ok: false, error: { code: "unsupported", message: `no handler for ${method}` } });
			return;
		}
		const controller = new AbortController();
		this.#running.set(id, controller);
		void (async () => {
			try {
				const value = await handler((params ?? null) as never, { bin, signal: controller.signal });
				if (value instanceof Answered) this.#write({ id, ok: true, result: value.result ?? null }, value.bin);
				else this.#write({ id, ok: true, result: value ?? null });
			} catch (error) {
				const code = error instanceof HostError ? error.code : "failed";
				const message = error instanceof Error ? error.message : String(error);
				this.#write({ id, ok: false, error: { code, message } });
			} finally {
				this.#running.delete(id);
			}
		})();
	}

	#end(error: Error | undefined): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeReason = error;
		const reason = new HostError(
			"gone",
			error ? `the shell connection ended: ${error.message}` : "the shell connection ended",
		);
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
			pending.reject(reason);
		}
		for (const controller of this.#running.values()) controller.abort();
		this.#running.clear();
		for (const listener of [...this.#closeListeners]) listener(error);
		this.#closeListeners.clear();
	}
}
