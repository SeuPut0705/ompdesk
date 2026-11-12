/**
 * Main's side of the control socket in ompdesk-core. The core owns the listener, auth, framing, events and waits;
 * this answers only what needs the agent-control service (`ControlBackend`). Asks arrive as `control` events, and
 * replies and pool activity go back as numbered `control.push` requests: the number keeps their order across the
 * core's concurrent request tasks.
 */
import { homedir } from "node:os";
import type { Endpoint } from "../../shared/control-protocol";
import { CoreError, core } from "../core/process";
import type { ControlBackend, OutsideCaller } from "./backend";

export interface ControlTuning {
	helloTimeoutMs?: number;
	maxConnections?: number;
	maxInFlight?: number;
	pollMs?: number;
	startWaitMs?: number;
	eventCapacity?: number;
	eventPollMs?: number;
}

export interface ControlServerOptions {
	token: string;
	backend: ControlBackend;
	helloTimeoutMs?: number;
	maxConnections?: number;
	maxInFlight?: number;
	tuning?: ControlTuning;
	publish?: { dir: string; endpoint: Endpoint };
	log?: (line: string) => void;
}

export class SocketInUse extends Error {
	constructor(path: string) {
		super(`${path} is in use by another process`);
		this.name = "SocketInUse";
	}
}

type Ask = { server: number } & (
	| { kind: "run"; call: number; caller: OutsideCaller; tool: string; args?: unknown }
	| { kind: "resolve"; call: number; caller: OutsideCaller; name: string }
	| { kind: "release"; caller: OutsideCaller }
	| { kind: "watch"; on: boolean }
	| { kind: "poll" }
);

type Push =
	| { kind: "reply"; call: number; began?: number; ok: true; value: unknown }
	| { kind: "reply"; call: number; began?: number; ok: false; message: string }
	| {
			kind: "activity";
			activity: { type: string; tabId: string; requestId?: string; text?: string; stopReason?: string };
	  }
	| { kind: "mail"; to: string; text: string }
	| { kind: "views" };

let nextServer = 0;
let nextIncarnation = 0;
// A request held to notice a dead core. Before node's longest timer expires, it is renewed on the same listener.
const HOLD_MS = 2 ** 31 - 1;

export class ControlServer {
	readonly #number = ++nextServer;
	readonly #options: ControlServerOptions;
	readonly #callers = new Map<string, OutsideCaller>();
	#sequence = 0;
	#epoch = 0;
	#detach: (() => void) | undefined;
	#unwatch: (() => void) | undefined;
	#closed = false;
	#serving = false;
	#hold: AbortController | undefined;
	#opening: Promise<void> | undefined;

	constructor(options: ControlServerOptions) {
		this.#options = options;
	}

	listen(path: string): Promise<void> {
		this.#opening = this.#listen(path);
		return this.#opening;
	}

	async #listen(path: string): Promise<void> {
		this.#detach ??= core().on("control", data => {
			const ask = data as Ask;
			if (ask.server === this.#number) this.#answer(ask);
		});
		this.#sequence = 0;
		const epoch = ++this.#epoch;
		const { token, tuning, helloTimeoutMs, maxConnections, maxInFlight, publish } = this.#options;
		try {
			await core().call("control.listen", {
				server: this.#number,
				path,
				token,
				home: homedir(),
				publish,
				...tuning,
				...(helloTimeoutMs === undefined ? {} : { helloTimeoutMs }),
				...(maxConnections === undefined ? {} : { maxConnections }),
				...(maxInFlight === undefined ? {} : { maxInFlight }),
				// Keep connection callers disjoint across core restarts too. A decimal prefix of fixed width, then
				// the core's fixed-width connection number: it is still `outside:<name>#<digits>` on the CLI wire.
				callerPrefix: String(++nextIncarnation).padStart(16, "0"),
			});
		} catch (error) {
			if (error instanceof CoreError && error.code === "socket_in_use") throw new SocketInUse(path);
			throw error;
		}
		this.#serving = true;
		this.#hold = new AbortController();
		void this.#untilClosed(path, epoch, this.#hold.signal);
	}

	async #untilClosed(path: string, epoch: number, signal: AbortSignal): Promise<void> {
		while (!this.#closed && epoch === this.#epoch) {
			try {
				await core().call("control.closed", { server: this.#number }, { timeoutMs: HOLD_MS, signal });
				// An answer, rather than a failed call: the listener closed in order (also when stdin ended at quit).
				this.#serving = false;
				this.#release();
				return;
			} catch (error) {
				if (this.#closed || epoch !== this.#epoch) return;
				if (error instanceof CoreError && error.code === "timeout") continue;
				this.#serving = false;
				this.#release();
				try {
					await this.listen(path);
				} catch (restartError) {
					this.#options.log?.(
						`Control socket not restarted: ${restartError instanceof Error ? restartError.message : String(restartError)}`,
					);
				}
				return;
			}
		}
	}

	#push(push: Push): void {
		if (this.#closed) return;
		const views = this.#unwatch ? this.#options.backend.views() : undefined;
		// The held `control.closed` is the crash signal. A late push to a listener already closed has nobody to tell.
		void core()
			.call("control.push", { server: this.#number, seq: ++this.#sequence, ...push, views })
			.catch(() => undefined);
	}

	#answer(ask: Ask): void {
		const backend = this.#options.backend;
		const epoch = this.#epoch;
		switch (ask.kind) {
			case "run":
			case "resolve": {
				this.#callers.set(ask.caller.id, ask.caller);
				const began = this.#sequence;
				const answer = async (): Promise<unknown> =>
					ask.kind === "run" ? backend.run(ask.caller, ask.tool, ask.args) : backend.resolve(ask.caller, ask.name);
				void answer().then(
					value => {
						if (epoch === this.#epoch) this.#push({ kind: "reply", call: ask.call, began, ok: true, value });
					},
					error => {
						if (epoch === this.#epoch)
							this.#push({
								kind: "reply",
								call: ask.call,
								began,
								ok: false,
								message: error instanceof Error ? error.message : String(error),
							});
					},
				);
				return;
			}
			case "release":
				backend.release(ask.caller);
				this.#callers.delete(ask.caller.id);
				return;
			case "poll":
				this.#push({ kind: "views" });
				return;
			case "watch": {
				if (!ask.on) {
					this.#unwatch?.();
					this.#unwatch = undefined;
					return;
				}
				if (this.#unwatch) return;
				const stopActivity = backend.observe(activity => {
					const base = { type: activity.type, tabId: activity.tabId };
					this.#push({
						kind: "activity",
						activity:
							activity.type === "ask"
								? { ...base, requestId: activity.requestId, text: activity.text }
								: activity.type === "idle"
									? { ...base, stopReason: activity.outcome?.stopReason }
									: base,
					});
				});
				const stopMail = backend.onOutsideMail((to, text) => this.#push({ kind: "mail", to, text }));
				this.#unwatch = () => {
					stopActivity();
					stopMail();
				};
				// A snapshot at attach, before main can hear any new activity: the event hub's baseline.
				this.#push({ kind: "views" });
				return;
			}
		}
	}

	#release(): void {
		this.#unwatch?.();
		this.#unwatch = undefined;
		for (const caller of this.#callers.values()) this.#options.backend.release(caller);
		this.#callers.clear();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		// A close during a pending bind/restart waits for that listener too.
		await this.#opening?.catch(() => undefined);
		this.#hold?.abort();
		if (this.#serving && core().pid !== null) await core().call("control.close", { server: this.#number });
		this.#serving = false;
		this.#detach?.();
		this.#detach = undefined;
		this.#release();
	}
}
