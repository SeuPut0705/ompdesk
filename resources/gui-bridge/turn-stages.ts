import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { guard } from "./health";
import { emit } from "./modes/shared";
import { LATE_FIRST_OUTPUT_MS, TURN_STAGES_LATE_ENV } from "./turn-stages-contracts";
import { setActiveRecorder, TurnStageRecorder } from "./turn-stages-core";

/**
 * Turn-stage tracing (rules and why in turn-stages-core.ts): feeds the recorder from stock's events and sends its
 * frames to main, which writes them to gui-runtime.jsonl (src/main/turn-stages-log.ts). It only observes.
 *
 * - `input`, `before_provider_request`, `after_provider_response`: extension hooks that return nothing.
 *   `before_provider_request` does not touch the payload, and no `context` or `message_update` handler is registered
 *   (stock copies the whole context per request for the former, and calls the latter per token).
 * - The main session's own `subscribe`: `agent_start`, `turn_start`, `message_start`, the first `message_update`,
 *   compaction and `agent_end`, plain function calls with an early return.
 * - Start and end of every extension's `before_agent_start` handlers: not an event of its own, so the main session's
 *   `ExtensionRunner.emitBeforeAgentStart` is wrapped once on that instance (an omp without it only loses those two
 *   stages). A subagent's runner is never wrapped.
 */
const RUNNER_WRAPPED = Symbol.for("ompdesk.turn-stages.runner");
const subscribed = new WeakSet<object>();

let shared: TurnStageRecorder | undefined;

function lateMs(): number {
	const override = Number(process.env[TURN_STAGES_LATE_ENV]);
	return override > 0 ? override : LATE_FIRST_OUTPUT_MS;
}

type EmitBeforeAgentStart = (...args: unknown[]) => Promise<unknown>;

function wrapHandlers(runner: unknown, recorder: TurnStageRecorder): void {
	const target = runner as Record<string | symbol, unknown> | undefined;
	const original = target?.emitBeforeAgentStart;
	if (!target || target[RUNNER_WRAPPED] || typeof original !== "function") return;
	target[RUNNER_WRAPPED] = true;
	target.emitBeforeAgentStart = async function emitBeforeAgentStart(this: unknown, ...args: unknown[]) {
		recorder.handlersStart();
		try {
			return await (original as EmitBeforeAgentStart).apply(this, args);
		} finally {
			recorder.handlersEnd();
		}
	};
}

function mainSession(pi: ExtensionAPI) {
	return pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
}

/** Subscribes to the main session and wraps its runner, each once; the session exists from `session_start` on. */
function attach(pi: ExtensionAPI, recorder: TurnStageRecorder): void {
	const session = mainSession(pi);
	if (!session) return;
	wrapHandlers(session.extensionRunner, recorder);
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
	pi.on("before_provider_request", (_event, ctx) => {
		if (ctx.agent.kind === "main") recorder.providerRequest();
		return undefined;
	});
	pi.on("after_provider_response", (_event, ctx) => {
		if (ctx.agent.kind === "main") recorder.providerResponse();
	});
	pi.on("session_start", () => attach(pi, recorder));
	pi.on("session_switch", () => attach(pi, recorder));
	attach(pi, recorder);
}

/** Hooks only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("turnStages", {});
