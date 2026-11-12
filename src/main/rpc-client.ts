/**
 * Main's facade over a tab's omp commands: `command()` is the single send path every main-process caller uses
 * (renderer passthrough, idle-session commands, health checks). Commands with a GUI-side handler (src/main/local) are
 * answered in-process and never reach omp; everything else, and `stock()` always, goes to omp through the tab's lane in
 * the core (`SidecarManager`'s `send`: a `sidecar.command` request whose answer is an event, in order with the frames).
 */
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";

/** How long a command may take before the caller gets `RPC timeout`. */
const DEFAULT_TIMEOUT_MS = 8_000;

/** A command that got no answer in time: its outcome is unknown (omp may still have run it). */
export class RpcTimeoutError extends Error {
	constructor(timeoutMs: number, type: string) {
		super(`RPC timeout (${timeoutMs}ms): ${type}`);
		this.name = "RpcTimeoutError";
	}
}

export interface RpcClientOptions {
	/** Sends a stock command to omp and resolves with its response; `Number.POSITIVE_INFINITY`: no deadline. */
	send: (command: RpcCommand, timeoutMs: number) => Promise<RpcResponse>;
	timeout?: number;
	/** Answers a GUI-side command, or returns undefined to forward it to omp. */
	local?: (command: RpcCommand & { id: string }) => Promise<RpcResponse> | undefined;
}

export class RpcClient {
	#nextId = 0;
	#retired = false;
	readonly #send: RpcClientOptions["send"];
	readonly #timeout: number;
	readonly #local: RpcClientOptions["local"];

	constructor(options: RpcClientOptions) {
		this.#send = options.send;
		this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
		this.#local = options.local;
	}

	/**
	 * Send a command (GUI-side handler first) and await its correlated response. Optional per-call timeout;
	 * `Number.POSITIVE_INFINITY`: no deadline, for a GUI-side handler as for omp.
	 */
	command(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		// Always a fresh id: renderer-chosen ids are only unique per window.
		const id = `gui-${++this.#nextId}`;
		const local = this.#local?.({ ...cmd, id });
		if (!local) return this.stock(cmd, timeoutMs);
		const timeout = timeoutMs ?? this.#timeout;
		// setTimeout would read Infinity as 1 ms.
		if (!Number.isFinite(timeout)) return local;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timer = setTimeout(() => reject(new RpcTimeoutError(timeout, cmd.type)), timeout);
		local.then(resolve, reject).finally(() => clearTimeout(timer));
		return promise;
	}

	/** Send straight to omp, bypassing GUI-side handlers. `Number.POSITIVE_INFINITY`: no deadline (only an answer or the omp's end settles it). */
	async stock(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		// The omp this client was made for is gone: a command no longer reaches the tab's next omp.
		if (this.#retired) throw new Error("Sidecar disconnected");
		return this.#send(cmd, timeoutMs ?? this.#timeout);
	}

	retire(): void {
		this.#retired = true;
	}
}
