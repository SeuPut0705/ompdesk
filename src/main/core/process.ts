/**
 * The `ompdesk-core` process (native/ompdesk/crates/core), where main's subsystems move one at a time. Started on its
 * first request with an open stdin pipe, so it exits when main does, however main ends. Both ways, one JSON object per
 * line; a frame with `"bin": n` is followed by exactly n raw bytes (file contents, never base64). Requests run
 * concurrently in the core and are matched here by id; events reach subscribers.
 *
 * A request fails alone when its timeout passes (its late answer is dropped), and every request waiting on a core that
 * ends without being asked to fails at once; the next request starts a fresh core. A core that ends three times in a
 * row before answering anything is not started again for 30 s, so a broken binary is never spawned per request.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { nativeBinPath } from "../native-bin";

const REQUEST_TIMEOUT_MS = 30_000;
const STOP_KILL_MS = 5_000;
const MAX_FAILED_STARTS = 3;
const FAILED_START_REST_MS = 30_000;
const NEWLINE = 0x0a;

/** A request the core refused (`code` from its answer) or that never got an answer (`timeout`, `core_exited`, …). */
export class CoreError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "CoreError";
		this.code = code;
	}
}

export interface CoreCallOptions {
	/** Raw bytes sent after the request's line. */
	bin?: Uint8Array;
	/** Replaces the 30 s default. */
	timeoutMs?: number;
}

export interface CoreAnswer<T> {
	result: T;
	/** The answer's raw bytes: a plain `Uint8Array` that owns its buffer; null when it carried none. */
	bin: Uint8Array | null;
}

export interface CoreProcessOptions {
	/** The binary to run, read at each start (`index.ts` configures the packaged location before the first request). */
	binary: () => string;
	/** Each line the core writes to stderr, and this side's own notes. */
	log?: (line: string) => void;
	timeoutMs?: number;
}

interface Frame {
	id?: number;
	ok?: boolean;
	result?: unknown;
	error?: { code?: string; message?: string };
	event?: string;
	data?: unknown;
	bin?: number;
}

interface Pending {
	method: string;
	child: ChildProcessWithoutNullStreams;
	resolve: (answer: CoreAnswer<unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** JSON carries no lone surrogate (the core's parser refuses one): it goes as U+FFFD, as node writes it to disk. */
const wellFormed = (_key: string, value: unknown): unknown =>
	typeof value === "string" ? value.toWellFormed() : value;

/** Splits stdout into frames, copying each `bin` tail straight into its own exactly sized array. */
class FrameReader {
	#line: Buffer[] = [];
	#bin: { frame: Frame; data: Uint8Array; filled: number } | null = null;
	readonly #deliver: (frame: Frame, bin: Uint8Array | null) => void;
	readonly #log: (line: string) => void;

	constructor(deliver: (frame: Frame, bin: Uint8Array | null) => void, log: (line: string) => void) {
		this.#deliver = deliver;
		this.#log = log;
	}

	push(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length) {
			const bin = this.#bin;
			if (bin) {
				const take = Math.min(bin.data.length - bin.filled, chunk.length - offset);
				bin.data.set(chunk.subarray(offset, offset + take), bin.filled);
				bin.filled += take;
				offset += take;
				if (bin.filled === bin.data.length) {
					this.#bin = null;
					this.#deliver(bin.frame, bin.data);
				}
				continue;
			}
			const end = chunk.indexOf(NEWLINE, offset);
			if (end === -1) {
				this.#line.push(chunk.subarray(offset));
				return;
			}
			this.#line.push(chunk.subarray(offset, end));
			offset = end + 1;
			const text = Buffer.concat(this.#line).toString("utf8");
			this.#line = [];
			let frame: Frame;
			try {
				frame = JSON.parse(text) as Frame;
			} catch {
				this.#log(`ompdesk-core: skipped a line that is not a frame (${text.length} characters)`);
				continue;
			}
			if (typeof frame.bin === "number" && frame.bin > 0) {
				this.#bin = { frame, data: new Uint8Array(frame.bin), filled: 0 };
			} else {
				this.#deliver(frame, typeof frame.bin === "number" ? new Uint8Array(0) : null);
			}
		}
	}
}

export class CoreProcess {
	#child: ChildProcessWithoutNullStreams | null = null;
	/** Whether the running core answered anything yet: a start that ends before that counts as failed. */
	#answered = false;
	#failedStarts = 0;
	#restUntil = 0;
	#sequence = 0;
	readonly #pending = new Map<number, Pending>();
	readonly #stopping = new Set<ChildProcessWithoutNullStreams>();
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
	readonly #binary: () => string;
	readonly #log: (line: string) => void;
	readonly #timeoutMs: number;

	constructor(options: CoreProcessOptions) {
		this.#binary = options.binary;
		this.#log = options.log ?? (line => console.warn(line));
		this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	}

	/** The running core's process id (null while none runs). */
	get pid(): number | null {
		return this.#child?.pid ?? null;
	}

	/** Subscribes to an event the core sends; returns the unsubscribe. */
	on(event: string, listener: (data: unknown) => void): () => void {
		let listeners = this.#listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.#listeners.set(event, listeners);
		}
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	call<T>(method: string, params: unknown = {}, options: CoreCallOptions = {}): Promise<CoreAnswer<T>> {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.#start();
		} catch (error) {
			return Promise.reject(error);
		}
		const id = ++this.#sequence;
		const { promise, resolve, reject } = Promise.withResolvers<CoreAnswer<unknown>>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new CoreError("timeout", `ompdesk-core did not answer ${method} in time`));
		}, options.timeoutMs ?? this.#timeoutMs);
		this.#pending.set(id, { method, child, resolve, reject, timer });
		const bin = options.bin ? { bin: options.bin.byteLength } : {};
		child.stdin.write(`${JSON.stringify({ id, method, params, ...bin }, wellFormed)}\n`);
		if (options.bin) child.stdin.write(options.bin);
		return promise as Promise<CoreAnswer<T>>;
	}

	/** Ends the core: its stdin closes, it answers what it holds and exits; killed after 5 s. Resolves once it is gone. */
	async stop(): Promise<void> {
		const child = this.#child;
		if (!child) return;
		this.#child = null;
		this.#stopping.add(child);
		const closed = once(child, "close");
		child.stdin.end();
		const kill = setTimeout(() => child.kill(), STOP_KILL_MS);
		try {
			await closed;
		} finally {
			clearTimeout(kill);
		}
	}

	#start(): ChildProcessWithoutNullStreams {
		if (this.#child) return this.#child;
		if (Date.now() < this.#restUntil)
			throw new CoreError(
				"core_unavailable",
				`ompdesk-core ended ${MAX_FAILED_STARTS} times in a row before answering; it is not started again for ${FAILED_START_REST_MS / 1000} s`,
			);
		const child = spawn(this.#binary(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.#child = child;
		this.#answered = false;
		const reader = new FrameReader((frame, bin) => this.#receive(child, frame, bin), this.#log);
		child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
		createInterface({ input: child.stderr }).on("line", line => this.#log(line));
		// A write to a core that already ended fails here; its close rejects what waits.
		child.stdin.on("error", () => {});
		let ended = false;
		const end = (error: CoreError) => {
			if (ended) return;
			ended = true;
			this.#ended(child, error);
		};
		child.on("error", error =>
			end(new CoreError("core_unavailable", `ompdesk-core could not run: ${error.message}`)),
		);
		child.on("close", (code, signal) =>
			end(new CoreError("core_exited", `ompdesk-core exited (${signal ?? `code ${code}`})`)),
		);
		return child;
	}

	#receive(child: ChildProcessWithoutNullStreams, frame: Frame, bin: Uint8Array | null): void {
		if (typeof frame.event === "string") {
			for (const listener of this.#listeners.get(frame.event) ?? []) listener(frame.data);
			return;
		}
		if (typeof frame.id !== "number") return;
		if (child === this.#child) {
			this.#answered = true;
			this.#failedStarts = 0;
		}
		const pending = this.#pending.get(frame.id);
		if (!pending) {
			this.#log(`ompdesk-core: dropped a late answer to request ${frame.id}`);
			return;
		}
		this.#pending.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.ok) pending.resolve({ result: frame.result, bin });
		else
			pending.reject(
				new CoreError(
					frame.error?.code ?? "unknown",
					frame.error?.message ?? `ompdesk-core refused ${pending.method}`,
				),
			);
	}

	#ended(child: ChildProcessWithoutNullStreams, error: CoreError): void {
		const expected = this.#stopping.delete(child);
		if (this.#child === child) {
			this.#child = null;
			if (!this.#answered && ++this.#failedStarts >= MAX_FAILED_STARTS) {
				this.#failedStarts = 0;
				this.#restUntil = Date.now() + FAILED_START_REST_MS;
			}
		}
		if (!expected) this.#log(error.message);
		for (const [id, pending] of this.#pending) {
			if (pending.child !== child) continue;
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}

let instance: CoreProcess | null = null;

/** The app's one core. */
export function core(): CoreProcess {
	instance ??= new CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
	return instance;
}

/** Ends the app's core (quit); a later request starts it again. */
export function stopCore(): Promise<void> {
	return instance?.stop() ?? Promise.resolve();
}
