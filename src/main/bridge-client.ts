/**
 * Main-process client of the gui-bridge extension (resources/gui-bridge) that
 * each sidecar loads with `-e`. The extension listens on the unix socket /
 * named pipe passed in `OMP_GUI_BRIDGE`; this side connects after `ready`.
 * Wire: newline-delimited JSON — `{id, method, params}` out, `{id, ok, result|error}`
 * and pushed `{event}` frames in.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type BridgeClient, LocalCommandError } from "./local/types";

type BridgeEvent = { type: string; [k: string]: unknown };

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * A fresh per-spawn endpoint. macOS caps unix socket paths at 104 bytes, so the
 * name stays short; `os.tmpdir()` there is the per-user `/var/folders/…/T`.
 */
export function newBridgeAddress(): string {
	const name = `omp-gui-${process.pid}-${randomBytes(4).toString("hex")}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/** Remove a unix socket file the bridge left behind (named pipes vanish on their own). */
export function removeBridgeAddress(address: string): void {
	if (process.platform !== "win32") rmSync(address, { force: true });
}

export class GuiBridgeClient implements BridgeClient {
	readonly #address: string;
	#socket: net.Socket | null = null;
	#connecting: Promise<void> | null = null;
	#cancelConnect: (() => void) | null = null;
	#pending = new Map<number, Pending>();
	#listeners = new Set<(event: BridgeEvent) => void>();
	#nextId = 0;
	#closed = false;

	constructor(address: string) {
		this.#address = address;
	}

	get connected(): boolean {
		return this.#socket !== null && !this.#socket.destroyed;
	}

	/** Connect once; resolves when connected, rejects on failure or timeout. */
	connect(timeoutMs = 3_000): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("GUI bridge is closed"));
		if (this.connected) return Promise.resolve();
		if (this.#connecting) return this.#connecting;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = net.connect(this.#address);
		const reader = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
		const fail = (error: Error): void => {
			clearTimeout(timer);
			reader.close();
			socket.destroy();
			if (this.#socket === socket) {
				this.#socket = null;
				this.#rejectAll(error.message);
			}
			reject(error);
		};
		const timer = setTimeout(
			() => fail(new Error(`GUI bridge did not accept a connection within ${timeoutMs}ms`)),
			timeoutMs,
		);
		this.#cancelConnect = () => fail(new Error("GUI bridge is closed"));
		socket.once("connect", () => {
			clearTimeout(timer);
			if (this.#closed) {
				fail(new Error("GUI bridge is closed"));
				return;
			}
			this.#socket = socket;
			resolve();
		});
		// readline forwards input errors on its own emitter. Both emitters must
		// route failures to the connecting caller (or outstanding requests).
		socket.on("error", fail);
		reader.on("error", fail);
		reader.on("line", line => {
			if (line.trim()) this.#onFrame(line);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			reader.close();
			if (this.#socket === socket) {
				this.#socket = null;
				this.#rejectAll("GUI bridge disconnected");
			}
			reject(new Error("GUI bridge disconnected"));
		});
		this.#connecting = promise.finally(() => {
			this.#connecting = null;
			this.#cancelConnect = null;
		});
		return this.#connecting;
	}

	/**
	 * `options.timeoutMs`: a request the bridge has not answered by then rejects (`bridge_timeout`) and is forgotten, so a
	 * frozen omp leaves no entry behind. Without it a request waits as long as the bridge takes (a user prompt, a login).
	 */
	async request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
		if (this.#connecting) await this.#connecting;
		const socket = this.#socket;
		if (!socket || socket.destroyed) throw new LocalCommandError("GUI bridge is not connected", "bridge_unavailable");
		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timeoutMs = options?.timeoutMs;
		const timer =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						const pending = this.#pending.get(id);
						if (!pending) return;
						this.#pending.delete(id);
						pending.reject(
							new LocalCommandError(
								`GUI bridge did not answer ${method} within ${timeoutMs}ms`,
								"bridge_timeout",
							),
						);
					}, timeoutMs);
		timer?.unref();
		this.#pending.set(id, {
			resolve: value => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: error => {
				clearTimeout(timer);
				reject(error);
			},
		});
		socket.write(`${JSON.stringify({ id, method, params })}\n`);
		return promise as Promise<T>;
	}

	onEvent(cb: (event: BridgeEvent) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	close(): void {
		this.#closed = true;
		this.#cancelConnect?.();
		this.#cancelConnect = null;
		this.#socket?.destroy();
		this.#socket = null;
		this.#rejectAll("GUI bridge closed");
		this.#listeners.clear();
	}

	#onFrame(line: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		if ("event" in frame) {
			const event = frame.event;
			if (typeof event === "object" && event !== null && "type" in event && typeof event.type === "string") {
				for (const listener of this.#listeners) listener(event as BridgeEvent);
			}
			return;
		}
		if (!("id" in frame) || typeof frame.id !== "number") return;
		const pending = this.#pending.get(frame.id);
		if (!pending) return;
		this.#pending.delete(frame.id);
		if ("ok" in frame && frame.ok === true) {
			pending.resolve("result" in frame ? frame.result : undefined);
			return;
		}
		const message = "error" in frame && typeof frame.error === "string" ? frame.error : "GUI bridge error";
		// The bridge codes failures the GUI can explain (`unsupported_omp`: a missing omp internal).
		pending.reject(
			"code" in frame && typeof frame.code === "string"
				? new LocalCommandError(message, frame.code)
				: new Error(message),
		);
	}

	#rejectAll(reason: string): void {
		for (const pending of this.#pending.values()) pending.reject(new LocalCommandError(reason, "bridge_unavailable"));
		this.#pending.clear();
	}
}
