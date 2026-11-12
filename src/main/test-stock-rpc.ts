/**
 * Test helper: commands to a stock omp that a test started itself (`spawn(OMP_COMMAND…)`), correlated by id with the
 * responses its stdout carries. The app does this in the core (`native/ompdesk/crates/core/src/sidecar`); a test that
 * talks to a raw omp has no lane, so it keeps its own small correlation.
 */
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { RpcTimeoutError } from "./rpc-client";

interface Pending {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class StockRpc {
	readonly #pending = new Map<string, Pending>();
	#nextId = 0;

	constructor(
		private readonly send: (frame: object) => void,
		private readonly options: { timeout: number },
	) {}

	/** Sends `command` and resolves with omp's response to it. */
	stock(command: RpcCommand): Promise<RpcResponse> {
		const id = `gui-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new RpcTimeoutError(this.options.timeout, command.type));
		}, this.options.timeout);
		this.#pending.set(id, { resolve, reject, timer });
		this.send({ ...command, id });
		return promise;
	}

	/** Gives an inbound response frame to the command that waits for it; false when none does. */
	onResponse(frame: RpcResponse): boolean {
		const entry = frame.id ? this.#pending.get(frame.id) : undefined;
		if (!entry || !frame.id) return false;
		clearTimeout(entry.timer);
		this.#pending.delete(frame.id);
		entry.resolve(frame);
		return true;
	}

	rejectAll(reason: string): void {
		for (const entry of this.#pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.#pending.clear();
	}
}
