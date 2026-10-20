import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type CustomMessageOptions, rerouteTodoReminder } from "./todo-reminder-core";
import type { BridgeMethods } from "./types";

const ORIGINAL = Symbol.for("ompdesk.todo-reminder.original");

type SendCustomMessage = (message: unknown, options?: CustomMessageOptions) => Promise<unknown>;

/**
 * Patches `AgentSession.prototype.sendCustomMessage` once (main and subagent sessions share the class) so a failed
 * todo call's reminder reaches the turn it belongs to (todo-reminder-core.ts). An omp without the method keeps stock.
 */
function patch(pi: ExtensionAPI): void {
	const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
	if (!session) return;
	const proto: Record<string | symbol, unknown> = Object.getPrototypeOf(session);
	if (proto[ORIGINAL]) return;
	const original = Reflect.get(proto, "sendCustomMessage");
	if (typeof original !== "function") {
		pi.logger.warn("gui-bridge: todo reminder delivery unavailable, AgentSession.sendCustomMessage missing");
		proto[ORIGINAL] = true;
		return;
	}
	const send = original as SendCustomMessage;
	proto[ORIGINAL] = send;
	proto.sendCustomMessage = function sendCustomMessage(
		this: { isStreaming: boolean },
		message: { customType?: unknown } | undefined,
		options?: CustomMessageOptions,
	): Promise<unknown> {
		const rerouted = rerouteTodoReminder(message, options, this.isStreaming === true);
		return send.call(this, message, rerouted ?? options);
	};
}

/** Called once per extension instance by index.ts; the patch happens when a main session first exists. */
export function install(pi: ExtensionAPI): void {
	patch(pi);
	pi.on("session_start", () => patch(pi));
	pi.on("before_agent_start", () => {
		patch(pi);
	});
}

export const methods: BridgeMethods = {};
