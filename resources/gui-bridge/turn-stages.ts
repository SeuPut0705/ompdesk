import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { guard } from "./health";
import { emit } from "./modes/shared";
import { LATE_FIRST_OUTPUT_MS, MODEL_REQUEST_EVENT, TURN_STAGES_LATE_ENV } from "./turn-stages-contracts";
import { setActiveRecorder, TurnStageRecorder, wrapStreamFn } from "./turn-stages-core";

/**
 * Turn-stage tracing (rules and why in turn-stages-core.ts): feeds the recorder from stock's events and sends its
 * frames to main, which writes them to gui-runtime.jsonl (src/main/turn-stages-log.ts). It only observes.
 *
 * - `input`: an extension hook that returns nothing. No `context`, `message_update` or provider hook is registered
 *   (stock copies the whole context per request for the first and calls the second per token; the provider hooks
 *   also run for side requests, as the main agent: see `wrapStreamFn` in turn-stages-core.ts).
 * - The main session's own `subscribe`: `agent_start`, `turn_start`, `message_start`, the first `message_update`,
 *   compaction and `agent_end`, plain function calls with an early return.
 * - Start and end of every extension's `before_agent_start` handlers: not an event of its own, so the main session's
 *   `ExtensionRunner.emitBeforeAgentStart` is wrapped once on that instance (an omp without it only loses those two
 *   stages). A subagent's runner is never wrapped.
 * - The main session's `prompt` call, wrapped once on that instance: a prompt's wait counts from it (or its `input`
 *   hook), and a setup that ends before `agent_start` (stock's Stop, a newer prompt, a refusal) emits no agent event,
 *   so its return or throw is the only sign of it. The wrapper awaits the call and hands back its result or error
 *   unchanged. An omp without the method counts every run from its first event.
 * - The main agent's `streamFn`, wrapped once on that instance: the payload and response callbacks of each request
 *   the main loop itself makes (an omp without it only loses `provider_request` and `provider_response`). Each also
 *   goes to the windows as `model_request` (`sent`, `answered`) for the working cue: two frames per model call.
 */
const RUNNER_WRAPPED = Symbol.for("ompdesk.turn-stages.runner");
const PROMPT_WRAPPED = Symbol.for("ompdesk.turn-stages.prompt");
const subscribed = new WeakSet<object>();

let shared: TurnStageRecorder | undefined;

function lateMs(): number {
	const override = Number(process.env[TURN_STAGES_LATE_ENV]);
	return override > 0 ? override : LATE_FIRST_OUTPUT_MS;
}

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

function wrapHandlers(runner: unknown, recorder: TurnStageRecorder): void {
	const target = runner as Record<string | symbol, unknown> | undefined;
	const original = target?.emitBeforeAgentStart;
	if (!target || target[RUNNER_WRAPPED] || typeof original !== "function") return;
	target[RUNNER_WRAPPED] = true;
	target.emitBeforeAgentStart = async function emitBeforeAgentStart(this: unknown, ...args: unknown[]) {
		recorder.handlersStart();
		try {
			return await (original as AsyncMethod).apply(this, args);
		} finally {
			recorder.handlersEnd();
		}
	};
}

function wrapPrompt(session: object, recorder: TurnStageRecorder): void {
	const target = session as Record<string | symbol, unknown>;
	const original = target.prompt;
	if (target[PROMPT_WRAPPED] || typeof original !== "function") return;
	target[PROMPT_WRAPPED] = true;
	target.prompt = async function prompt(this: unknown, ...args: unknown[]) {
		const text = typeof args[0] === "string" ? args[0] : "";
		const setup = recorder.promptStarted(text, Reflect.get(session, "isStreaming") === true);
		let result: unknown;
		try {
			result = await (original as AsyncMethod).apply(this, args);
		} catch (error) {
			recorder.promptSettled(setup, error);
			throw error;
		}
		recorder.promptSettled(setup);
		return result;
	};
}

function mainSession(pi: ExtensionAPI) {
	return pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
}

/** Subscribes to the main session and wraps its runner, `prompt` and agent `streamFn`, each once; the session exists from `session_start` on. */
function attach(pi: ExtensionAPI, recorder: TurnStageRecorder): void {
	const session = mainSession(pi);
	if (!session) return;
	wrapHandlers(session.extensionRunner, recorder);
	wrapPrompt(session, recorder);
	wrapStreamFn(session.agent, recorder, phase => emit({ type: MODEL_REQUEST_EVENT, phase }));
	if (subscribed.has(session)) return;
	subscribed.add(session);
	session.subscribe(event => recorder.sessionEvent(event));
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts; only the main agent's events count. */
export function install(pi: ExtensionAPI): void {
	shared ??= new TurnStageRecorder({
		emit: frame => emit(frame),
		lateMs: lateMs(),
		model: () => mainSession(pi)?.model,
	});
	const recorder = shared;
	setActiveRecorder(recorder);
	pi.on("input", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		attach(pi, recorder);
		recorder.promptReceived(event.text, mainSession(pi)?.isStreaming === true);
		return undefined;
	});
	pi.on("session_start", () => attach(pi, recorder));
	pi.on("session_switch", () => attach(pi, recorder));
	attach(pi, recorder);
}

/** Hooks only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("turnStages", {});
