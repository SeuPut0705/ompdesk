/**
 * The control socket's requests, answered for one outside caller. Waits live here, in main, not in the CLI: the
 * rules are Herdr's (re-implemented): subscribe to activity before reading a session so a fast turn is never missed,
 * `agent_blocked` before sending to a session that waits on the person, and `agent_prompt_stalled` when a sent
 * prompt never starts a turn.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
	CALLER_NAME,
	type ControlError,
	type ControlErrorCode,
	type ControlRequest,
	type ControlResponse,
	DEFAULT_CALLER,
	type SendResult,
	type SessionState,
	type SessionStatus,
	START_WAIT_MS,
	type ToolResult,
	WAIT_UNTIL,
	type WaitResult,
	type WaitUntil,
} from "../../../resources/cli/protocol";
import type { OutsideCaller } from "../agent-control/host";
import type { ControlBackend, SessionView } from "./backend";
import type { EventHub, EventSink } from "./events";

export type RoutedRequest = Exclude<ControlRequest, { method: "hello" }>;

/** What a connection gives its requests: who calls, where events go, and a signal that fires when it closes. */
export interface ConnectionContext {
	caller: OutsideCaller;
	sink: EventSink;
	signal: AbortSignal;
}

export interface RouterTimings {
	/** Plan proposals raise no activity, so a wait also reads the session on this beat. */
	pollMs?: number;
	startWaitMs?: number;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
const DELIVERIES: readonly string[] = ["follow_up", "steer"];

class ControlFailure extends Error {
	readonly code: ControlErrorCode;
	constructor(code: ControlErrorCode, message: string) {
		super(message);
		this.name = "ControlFailure";
		this.code = code;
	}
}

export function outsideCaller(hello: { caller?: unknown; cwd?: unknown }): OutsideCaller {
	const name = typeof hello.caller === "string" && CALLER_NAME.test(hello.caller) ? hello.caller : DEFAULT_CALLER;
	const cwd = typeof hello.cwd === "string" && isAbsolute(hello.cwd) && isFolder(hello.cwd) ? hello.cwd : homedir();
	return { id: `outside:${name}`, title: `outside agent "${name}"`, cwd };
}

function isFolder(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function failure(code: ControlErrorCode, message: string): ControlFailure {
	return new ControlFailure(code, message);
}

/**
 * An abort signal that also fires after `ms` (with `onTimeout`'s failure) and when `parent` aborts (with its reason).
 * `dispose` leaves no timer and no listener behind.
 */
function guard(
	parent: AbortSignal,
	ms: number | undefined,
	onTimeout: () => ControlFailure,
): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const onParent = (): void => controller.abort(parent.reason);
	if (parent.aborted) onParent();
	else parent.addEventListener("abort", onParent, { once: true });
	const timer = ms === undefined ? undefined : setTimeout(() => controller.abort(onTimeout()), ms);
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			parent.removeEventListener("abort", onParent);
		},
	};
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		promise.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	const { promise: guarded, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = (): void => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return guarded;
}

/**
 * What one request saw of one tab's activity since it subscribed. It subscribes before the tab is known (resolving
 * a name is asynchronous), so it keeps every tab's lifecycle activity until `bind`, then only the bound tab's.
 */
class TabWatch {
	/** A turn started or a question was raised: the session was seen working or blocked. */
	started = false;
	/** The stop reason of the last turn that ended. */
	ended: string | undefined;
	released = false;
	#tab: string | undefined;
	readonly #backlog: { tabId: string; kind: "start" | "end" | "released"; stopReason?: string }[] = [];
	readonly #unobserve: () => void;
	#wake: (() => void) | undefined;

	constructor(backend: ControlBackend) {
		this.#unobserve = backend.observe(activity => {
			if (activity.type === "busy" || activity.type === "ask") this.#note(activity.tabId, "start");
			else if (activity.type === "idle") this.#note(activity.tabId, "end", activity.outcome?.stopReason ?? "stop");
			else if (activity.type === "released") this.#note(activity.tabId, "released");
		});
	}

	bind(tab: string): void {
		this.#tab = tab;
		for (const entry of this.#backlog.splice(0)) this.#apply(entry);
	}

	#note(tabId: string, kind: "start" | "end" | "released", stopReason?: string): void {
		const entry = { tabId, kind, stopReason };
		if (this.#tab === undefined) this.#backlog.push(entry);
		else this.#apply(entry);
	}

	#apply(entry: { tabId: string; kind: "start" | "end" | "released"; stopReason?: string }): void {
		if (entry.tabId !== this.#tab) return;
		if (entry.kind === "start") this.started = true;
		else if (entry.kind === "end") this.ended = entry.stopReason;
		else this.released = true;
		this.#wake?.();
	}

	/** Resolves with the first non-undefined `check()`, tried now, on every activity and on every poll beat. */
	until<T>(check: () => T | undefined, signal: AbortSignal, pollMs: number): Promise<T> {
		if (signal.aborted) return Promise.reject(signal.reason);
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const poll = setInterval(() => step(), pollMs);
		const end = (settle: () => void): void => {
			clearInterval(poll);
			signal.removeEventListener("abort", onAbort);
			this.#wake = undefined;
			settle();
		};
		const onAbort = (): void => end(() => reject(signal.reason));
		const step = (): void => {
			try {
				const value = check();
				if (value !== undefined) end(() => resolve(value));
			} catch (error) {
				end(() => reject(error));
			}
		};
		this.#wake = step;
		signal.addEventListener("abort", onAbort, { once: true });
		step();
		return promise;
	}

	dispose(): void {
		this.#unobserve();
		this.#wake = undefined;
	}
}

function positiveMs(value: unknown, what: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw failure("bad_request", `${what} must be a positive number of milliseconds`);
	}
	return Math.min(value, MAX_TIMER_MS);
}

function untilOf(value: unknown): WaitUntil | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (WAIT_UNTIL as readonly string[]).includes(value)) return value as WaitUntil;
	throw failure("bad_request", `until must be one of ${WAIT_UNTIL.join(", ")}`);
}

function sessionName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw failure("bad_request", "session must be a name");
	return value;
}

const status = (view: SessionView): SessionStatus => ({ session: view.session, title: view.title, state: view.state });

export class ControlRouter {
	readonly #backend: ControlBackend;
	readonly #hub: EventHub;
	readonly #pollMs: number;
	readonly #startWaitMs: number;

	constructor(
		backend: ControlBackend,
		hub: EventHub,
		{ pollMs = 500, startWaitMs = START_WAIT_MS }: RouterTimings = {},
	) {
		this.#backend = backend;
		this.#hub = hub;
		this.#pollMs = pollMs;
		this.#startWaitMs = startWaitMs;
	}

	async handle(request: RoutedRequest, context: ConnectionContext): Promise<ControlResponse> {
		try {
			return { id: request.id, ok: true, result: await this.#dispatch(request, context) };
		} catch (error) {
			return { id: request.id, ok: false, error: toError(error) };
		}
	}

	async #dispatch(request: RoutedRequest, context: ConnectionContext): Promise<unknown> {
		const method: unknown = request.method;
		switch (request.method) {
			case "tool":
				return this.#tool(request, context);
			case "state":
				return status(await this.#resolve(context.caller, sessionName(request.session)));
			case "wait":
				return this.#wait(request, context);
			case "send":
				return this.#send(request, context);
			case "subscribe": {
				const unsubscribe = this.#hub.subscribe(context.caller.id, context.sink, request.id);
				if (context.signal.aborted) unsubscribe();
				else context.signal.addEventListener("abort", unsubscribe, { once: true });
				return { sub: request.id };
			}
			default:
				throw failure("unknown_method", `unknown method ${String(method)}`);
		}
	}

	async #resolve(caller: OutsideCaller, name: string): Promise<SessionView> {
		try {
			return await this.#backend.resolve(caller, name);
		} catch (error) {
			throw failure("session_not_found", error instanceof Error ? error.message : String(error));
		}
	}

	async #tool(request: Extract<RoutedRequest, { method: "tool" }>, context: ConnectionContext): Promise<ToolResult> {
		if (typeof request.tool !== "string" || request.tool.length === 0) {
			throw failure("bad_request", "tool must be a tool name");
		}
		const outcome = await this.#backend.run(context.caller, request.tool, request.args);
		return { text: outcome.text, isError: outcome.isError };
	}

	/** The check a wait settles on, over the facts one watch gathered. `startState` is what `any` compares against. */
	#evaluate(
		tab: string,
		watch: TabWatch,
		until: WaitUntil | undefined,
		startState: SessionState,
		last: SessionView,
	): () => WaitResult | undefined {
		const result = (matched: WaitResult["matched"], view: SessionView | null): WaitResult => ({
			...status(view ?? { ...last, state: "idle" }),
			matched,
			...(watch.ended === undefined ? {} : { stopReason: watch.ended }),
		});
		return () => {
			if (until === "done" || until === "any") {
				if (watch.ended !== undefined) return result(until, this.#backend.view(tab));
			}
			const view = this.#backend.view(tab);
			if (view === null || watch.released) throw failure("session_gone", `Session ${tab} is gone`);
			switch (until) {
				case undefined:
					// A stopped omp moves on only when someone restarts it: a settled wait reports it rather than hang.
					return view.state === "idle" || view.state === "blocked" || view.state === "stopped"
						? result("settled", view)
						: undefined;
				case "idle":
				case "blocked":
					return view.state === until ? result(until, view) : undefined;
				case "any":
					return view.state !== startState ? result("any", view) : undefined;
				default:
					return undefined;
			}
		};
	}

	async #wait(request: Extract<RoutedRequest, { method: "wait" }>, context: ConnectionContext): Promise<WaitResult> {
		const name = sessionName(request.session);
		const until = untilOf(request.until);
		const timeoutMs = positiveMs(request.timeoutMs, "timeoutMs");
		const bounds = guard(context.signal, timeoutMs, () => failure("timeout", `Wait timed out after ${timeoutMs} ms`));
		const watch = new TabWatch(this.#backend);
		try {
			const view = await abortable(this.#resolve(context.caller, name), bounds.signal);
			watch.bind(view.session);
			return await watch.until(
				this.#evaluate(view.session, watch, until, view.state, view),
				bounds.signal,
				this.#pollMs,
			);
		} finally {
			watch.dispose();
			bounds.dispose();
		}
	}

	async #send(request: Extract<RoutedRequest, { method: "send" }>, context: ConnectionContext): Promise<SendResult> {
		const name = sessionName(request.session);
		if (typeof request.message !== "string" || request.message.length === 0) {
			throw failure("bad_request", "message must be text");
		}
		if (request.delivery !== undefined && !DELIVERIES.includes(request.delivery)) {
			throw failure("bad_request", `delivery must be one of ${DELIVERIES.join(", ")}`);
		}
		if (request.requestId !== undefined && typeof request.requestId !== "string") {
			throw failure("bad_request", "requestId must be text");
		}
		const wait = request.wait;
		if (wait !== undefined && (typeof wait !== "object" || wait === null)) {
			throw failure("bad_request", "wait must be an object");
		}
		const until = untilOf(wait?.until);
		const timeoutMs = positiveMs(wait?.timeoutMs, "wait.timeoutMs");
		const bounds = guard(context.signal, timeoutMs, () => failure("timeout", `Send timed out after ${timeoutMs} ms`));
		const watch = new TabWatch(this.#backend);
		try {
			const view = await abortable(this.#resolve(context.caller, name), bounds.signal);
			watch.bind(view.session);
			if (view.state === "blocked" && request.force !== true) {
				throw failure(
					"agent_blocked",
					`Session ${view.session} waits on the person (a question, an approval or a plan). Answer there, or send anyway with --force.`,
				);
			}
			const wasWorking = view.state === "working";
			const outcome = await abortable(
				this.#backend.run(context.caller, "ompdesk_session_send", {
					session: view.session,
					message: request.message,
					delivery: request.delivery,
					request_id: request.requestId,
				}),
				bounds.signal,
			);
			if (outcome.isError) throw failure("tool_failed", outcome.text);
			if (wait === undefined) return { receipt: outcome.text };
			const tab = view.session;
			const startBounds = guard(bounds.signal, this.#startWaitMs, () =>
				failure(
					"agent_prompt_stalled",
					`Session ${tab} did not start working within ${this.#startWaitMs} ms of the message`,
				),
			);
			let current: SessionView = view;
			try {
				await watch.until(
					() => {
						const now = this.#backend.view(tab);
						if (watch.ended !== undefined || watch.started || wasWorking) {
							if (now !== null) current = now;
							return true;
						}
						if (now === null || watch.released) throw failure("session_gone", `Session ${tab} is gone`);
						if (now.state === "working" || now.state === "blocked") {
							current = now;
							return true;
						}
						return undefined;
					},
					startBounds.signal,
					this.#pollMs,
				);
			} finally {
				startBounds.dispose();
			}
			const waited = await watch.until(
				this.#evaluate(tab, watch, until, current.state, current),
				bounds.signal,
				this.#pollMs,
			);
			return { receipt: outcome.text, waited };
		} finally {
			watch.dispose();
			bounds.dispose();
		}
	}
}

export function toError(error: unknown): ControlError {
	if (error instanceof ControlFailure) return { code: error.code, message: error.message };
	return { code: "unavailable", message: error instanceof Error ? error.message : String(error) };
}
