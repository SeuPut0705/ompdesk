/**
 * Main's side of a port (`crates/core/src/ports.rs`): how a subsystem that moved into ompdesk-core reaches what main
 * still owns. The core asks with the event `port` and main answers with `ports.answer`; main's state, what the
 * TypeScript read synchronously, is a snapshot main pushes the moment it observes a change (`push()`) and also hands
 * with every answer, so a step in the core that resumes after an ask reads main as it was when main answered.
 *
 * The subsystem opens its own object in the core naming this port's `id` and its first `snapshot()`; `held` settles
 * once the port closed in order and rejects when the core that held it ended.
 */
import { CoreError, type CoreProcess, core } from "./process";

/** What the core may ask of main on one port: each handler's value (awaited) is the answer; a throw fails the ask. */
export type PortHandlers = Record<string, (args: never) => unknown>;

interface PortEvent {
	port: number;
	ask?: number;
	method: string;
	args?: unknown;
}

/** One number for every port this main opens, never reused, so a restarted core never meets an old one. */
let nextPort = 0;
/** A request that holds a port open to notice a dead core: renewed before node's longest timer expires. */
const HOLD_MS = 2 ** 31 - 1;

function codeOf(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

export class CorePort<S = unknown> {
	readonly id = ++nextPort;
	readonly #process: CoreProcess;
	readonly #handlers: PortHandlers;
	readonly #snapshot: (() => S) | undefined;
	readonly #unsubscribe: () => void;
	#seq = 0;
	#closed = false;

	constructor(handlers: PortHandlers, snapshot?: () => S, process: CoreProcess = core()) {
		this.#process = process;
		this.#handlers = handlers;
		this.#snapshot = snapshot;
		this.#unsubscribe = process.on("port", data => this.#receive(data as PortEvent));
	}

	/** The state as main sees it now, numbered: what the subsystem's open request carries first. */
	first(): { seq: number; state: S | null } {
		return { seq: ++this.#seq, state: this.#snapshot ? this.#snapshot() : null };
	}

	/** Main observed a change: the core reads it from now on. */
	push(): void {
		if (this.#closed || !this.#snapshot) return;
		const seq = ++this.#seq;
		this.#process.call("ports.push", { port: this.id, seq, state: this.#snapshot() }).catch(() => {});
	}

	/** Settles once the port closed in order; rejects with the core's error when the core ended first. */
	async held(): Promise<void> {
		for (;;) {
			try {
				await this.#process.call("ports.held", { port: this.id }, { timeoutMs: HOLD_MS });
				return;
			} catch (error) {
				if (error instanceof CoreError && error.code === "timeout" && !this.#closed) continue;
				throw error;
			}
		}
	}

	/** Closes the port: what the core still waits on fails, and nothing more reaches the handlers. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		this.#process.call("ports.close", { port: this.id }).catch(() => {});
	}

	#receive(event: PortEvent): void {
		if (event.port !== this.id || this.#closed) return;
		const { ask, method } = event;
		let value: unknown;
		try {
			const handler = method === "state" ? undefined : this.#handlers[method];
			if (method !== "state" && !handler)
				throw new CoreError("no_port_method", `main has no ${method} on this port`);
			value = handler ? (handler as (args: unknown) => unknown)(event.args) : null;
		} catch (error) {
			if (ask !== undefined) this.#fail(ask, error);
			return;
		}
		if (ask === undefined) {
			Promise.resolve(value).catch(() => {});
			return;
		}
		Promise.resolve(value).then(
			resolved => this.#answer(ask, { ok: true, value: resolved ?? null }),
			error => this.#fail(ask, error),
		);
	}

	#fail(ask: number, error: unknown): void {
		const code = codeOf(error);
		this.#answer(ask, {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
			...(code ? { code } : {}),
		});
	}

	#answer(ask: number, body: Record<string, unknown>): void {
		if (this.#closed) return;
		const state = this.#snapshot ? { seq: ++this.#seq, state: this.#snapshot() } : {};
		this.#process.call("ports.answer", { port: this.id, ask, ...body, ...state }).catch(() => {});
	}
}
