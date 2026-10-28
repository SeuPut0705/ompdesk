/**
 * Typed RPC client with id correlation and timeout.
 *
 * `command()` is the single send path every main-process caller uses (renderer
 * passthrough, idle-session commands, health checks). Commands with a GUI-side
 * handler (src/main/local) are answered in-process and never reach omp;
 * `stock()` always goes to the omp sidecar.
 */
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";

/** How long a command may take before the caller gets `RPC timeout`. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** A command that got no answer in time: its outcome is unknown (omp may still have run it). */
export class RpcTimeoutError extends Error {
	constructor(timeoutMs: number, type: string) {
		super(`RPC timeout (${timeoutMs}ms): ${type}`);
		this.name = "RpcTimeoutError";
	}
}

interface PendingRequest {
	command: RpcCommand;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RpcClientOptions {
	timeout?: number;
	/** Answers a GUI-side command, or returns undefined to forward it to omp. */
	local?: (command: RpcCommand & { id: string }) => Promise<RpcResponse> | undefined;
	/** Sees every correlated omp response, after the caller's promise settles. */
	observe?: (command: RpcCommand, response: RpcResponse) => void;
}

export class RpcClient {
	#pending = new Map<string, PendingRequest>();
	#nextId = 0;
	#send: (frame: object) => void;
	#timeout: number;
	#local: RpcClientOptions["local"];
	#observe: RpcClientOptions["observe"];

	constructor(send: (frame: object) => void, options: RpcClientOptions = {}) {
		this.#send = send;
		this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.#local = options.local;
		this.#observe = options.observe;
	}

	/** Send a command (GUI-side handler first) and await its correlated response. Optional per-call timeout. */
	command(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		// Always a fresh id: renderer-chosen ids are only unique per window.
		const id = `gui-${++this.#nextId}`;
		const local = this.#local?.({ ...cmd, id });
		if (!local) return this.#stock(cmd, id, timeoutMs);
		const timeout = timeoutMs ?? this.#timeout;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timer = setTimeout(() => reject(new RpcTimeoutError(timeout, cmd.type)), timeout);
		local.then(resolve, reject).finally(() => clearTimeout(timer));
		return promise;
	}

	/** Send straight to omp, bypassing GUI-side handlers. */
	stock(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		return this.#stock(cmd, `gui-${++this.#nextId}`, timeoutMs);
	}

	#stock(cmd: RpcCommand, id: string, timeoutMs?: number): Promise<RpcResponse> {
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timeout = timeoutMs ?? this.#timeout;
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new RpcTimeoutError(timeout, cmd.type));
		}, timeout);
		this.#pending.set(id, { command: cmd, resolve, reject, timer });
		this.#send({ ...cmd, id });
		return promise;
	}

	/** Route an inbound response frame to its waiting promise. */
	onResponse(frame: RpcResponse): boolean {
		const id = frame.id;
		if (!id) return false;

		const entry = this.#pending.get(id);
		if (!entry) return false;

		clearTimeout(entry.timer);
		this.#pending.delete(id);
		entry.resolve(frame);
		this.#observe?.(entry.command, frame);
		return true;
	}

	/** Reject all pending requests (sidecar died). */
	rejectAll(reason: string): void {
		for (const entry of this.#pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.#pending.clear();
	}
}
