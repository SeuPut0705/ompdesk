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

/** One lifecycle step of a tab, numbered in the order this request heard it. */
interface Lifecycle {
	seq: number;
	tabId: string;
	kind: "working" | "blocked" | "ended" | "released";
	stopReason?: string;
}

/**
 * The tab's lifecycle steps since this request subscribed, each with a sequence number, so a wait can ask "what
 * happened after mark N" and replay it (Herdr's `last_event_sequence`). It subscribes before the tab is known
 * (resolving a name is asynchronous) and keeps every tab's steps until `bind`, then only the bound tab's.
 */
class TabWatch {
	#seq = 0;
	#tab: string | undefined;
	#log: Lifecycle[] = [];
	readonly #unobserve: () => void;
	#wake: (() => void) | undefined;

	constructor(backend: ControlBackend) {
		this.#unobserve = backend.observe(activity => {
			if (activity.type === "busy") this.#note(activity.tabId, "working");
			else if (activity.type === "ask") this.#note(activity.tabId, "blocked");
			else if (activity.type === "idle") this.#note(activity.tabId, "ended", activity.outcome?.stopReason ?? "stop");
			else if (activity.type === "released") this.#note(activity.tabId, "released");
		});
	}

	bind(tab: string): void {
		this.#tab = tab;
		this.#log = this.#log.filter(entry => entry.tabId === tab);
	}

	/** The sequence heard so far: `since(mark())` later holds only what happens from now on. */
	mark(): number {
		return this.#seq;
	}

	/** The bound tab's steps after `mark`, oldest first. */
	since(mark: number): Lifecycle[] {
		return this.#log.filter(entry => entry.seq > mark && entry.tabId === this.#tab);
	}

	#note(tabId: string, kind: Lifecycle["kind"], stopReason?: string): void {
		if (this.#tab !== undefined && tabId !== this.#tab) return;
		this.#log.push({ seq: ++this.#seq, tabId, kind, ...(stopReason ? { stopReason } : {}) });
		if (tabId === this.#tab) this.#wake?.();
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

/** What each `until` accepts from a replayed lifecycle step; `any` takes the first step of all. */
const STEP_MATCHES: Record<WaitUntil | "settled", ReadonlySet<Lifecycle["kind"]>> = {
	settled: new Set(["ended", "blocked"]),
	idle: new Set(["ended"]),
	blocked: new Set(["blocked"]),
	done: new Set(["ended"]),
	any: new Set(["working", "blocked", "ended"]),
};

const STEP_STATE: Record<Exclude<Lifecycle["kind"], "released">, SessionState> = {
	working: "working",
	blocked: "blocked",
	ended: "idle",
};

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

	/**
	 * The check a wait settles on. It first replays the tab's lifecycle steps after `mark` (so a turn that ended while
	 * the send's activity gate ran still ends the wait), then reads the session as it is now. `done` needs a turn end
	 * after `mark`; `any` compares the state now with `startState`.
	 */
	#evaluate(
		tab: string,
		watch: TabWatch,
		until: WaitUntil | undefined,
		mark: number,
		startState: SessionState,
	): () => WaitResult | undefined {
		const matched = until ?? "settled";
		return () => {
			const steps = watch.since(mark);
			const view = this.#backend.view(tab);
			if (view === null || steps.some(step => step.kind === "released"))
				throw failure("session_gone", `Session ${tab} is gone`);
			const step = steps.find(entry => STEP_MATCHES[matched].has(entry.kind));
			if (step && step.kind !== "released")
				return {
					...status(view),
					state: STEP_STATE[step.kind],
					matched,
					...(step.stopReason ? { stopReason: step.stopReason } : {}),
				};
			const now = (): WaitResult => ({ ...status(view), matched });
			switch (until) {
				case undefined:
					// A stopped omp moves on only when someone restarts it: a settled wait reports it rather than hang.
					return view.state === "idle" || view.state === "blocked" || view.state === "stopped" ? now() : undefined;
				case "idle":
				case "blocked":
					return view.state === until ? now() : undefined;
				case "any":
					return view.state !== startState ? now() : undefined;
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
			// From the subscription on: a turn that ended while the name was resolved counts for `done`.
			return await watch.until(
				this.#evaluate(view.session, watch, until, 0, view.state),
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
			// Herdr's prompt --wait: the gate and the final wait both read what happened after this point, and one
			// timeout (`bounds`) covers the send, the gate and the wait.
			const preSend = watch.mark();
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
			// The activity gate: the session was working already, or after the send it was seen working, blocked or
			// ending a turn (a step, or the state now: a plan proposal raises no step). Within START_WAIT_MS or less
			// when the total timeout is nearer; else agent_prompt_stalled.
			const startBounds = guard(bounds.signal, this.#startWaitMs, () =>
				failure(
					"agent_prompt_stalled",
					`Session ${tab} produced no observed working or blocked state within ${this.#startWaitMs} ms of the message`,
				),
			);
			try {
				await watch.until(
					() => {
						const steps = watch.since(preSend);
						const now = this.#backend.view(tab);
						if (now === null || steps.some(step => step.kind === "released"))
							throw failure("session_gone", `Session ${tab} is gone`);
						return wasWorking || steps.length > 0 || now.state === "working" || now.state === "blocked"
							? true
							: undefined;
					},
					startBounds.signal,
					this.#pollMs,
				);
			} finally {
				startBounds.dispose();
			}
			const waited = await watch.until(
				this.#evaluate(tab, watch, until, preSend, view.state),
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
