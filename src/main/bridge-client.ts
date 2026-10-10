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
	#pending = new Map<number, Pending>();
	#listeners = new Set<(event: BridgeEvent) => void>();
	#nextId = 0;
	#buffer = "";
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
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`GUI bridge did not accept a connection within ${timeoutMs}ms`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			if (this.#closed) {
				socket.destroy();
				reject(new Error("GUI bridge is closed"));
				return;
			}
			this.#socket = socket;
			resolve();
		});
		socket.once("error", err => {
			clearTimeout(timer);
			reject(err);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#onData(chunk));
		socket.on("close", () => {
			if (this.#socket === socket) this.#socket = null;
			this.#rejectAll("GUI bridge disconnected");
		});
		this.#connecting = promise.finally(() => {
			this.#connecting = null;
		});
		return this.#connecting;
	}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		if (this.#connecting) await this.#connecting;
		const socket = this.#socket;
		if (!socket || socket.destroyed) throw new LocalCommandError("GUI bridge is not connected", "bridge_unavailable");
		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		socket.write(`${JSON.stringify({ id, method, params })}\n`);
		return promise as Promise<T>;
	}

	onEvent(cb: (event: BridgeEvent) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	close(): void {
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = null;
		this.#rejectAll("GUI bridge closed");
		this.#listeners.clear();
	}

	#onData(chunk: string): void {
		// Look for the newline in the new chunk only: rescanning the whole buffer per
		// chunk made a multi-MB reply cost quadratic time and stalled every request behind it.
		let newline = chunk.indexOf("\n");
		if (newline === -1) {
			this.#buffer += chunk;
			return;
		}
		let rest = chunk;
		while (newline !== -1) {
			const line = this.#buffer + rest.slice(0, newline);
			this.#buffer = "";
			rest = rest.slice(newline + 1);
			if (line.trim()) this.#onFrame(line);
			newline = rest.indexOf("\n");
		}
		this.#buffer = rest;
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
