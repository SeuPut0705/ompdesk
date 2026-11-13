/**
 * A session that waits on another session is not woken by stock's stop-time todo reminder (rules: ./todo-wait-core.ts).
 *
 * Stock's `TodoTracker.checkCompletion` has no hook and no setting for this; it decides by what it can read (the open
 * items, a pending async job, a closing question). The one seam is the order of its synchronous start: it reads the
 * session's `getActiveToolNames()` before it counts a reminder, and a list without `todo` makes it reset and return
 * false (stock's own "todo is off" path). So `checkCompletion` is wrapped only to say "the check is running now", and
 * the session's `getActiveToolNames` answers without `todo` once, during that window, when the session waits. Nothing
 * else sees a different list. An upstream option (a host callback or setting the tracker consults) would be cleaner;
 * asked for in https://github.com/can1357/oh-my-pi/issues/19151, and this wrapper goes when stock has one.
 *
 * Feature-detected: an omp without either method keeps stock's reminder (`todoWait` in capabilities.ts).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as trackerModule from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { MAIL_CUSTOM_TYPE } from "./agent-control-contracts";
import { hasPath } from "./capabilities";
import { guard } from "./health";
import { type Arrival, controlCall, type PhaseLike, WaitBook, waitReason } from "./todo-wait-core";

const ORIGINAL = Symbol.for("ompdesk.todo-wait.original");

/** The main session's replies owed; the main agent only (an ompdesk_session_* call is the main agent's). */
const book = new WaitBook();

/** True during the synchronous start of one `checkCompletion` call. */
let checking = false;

interface WaitSession {
	getActiveToolNames(): string[];
	getTodoPhases?(): PhaseLike[];
}

type MethodOf<T> = (this: unknown, ...args: never[]) => T;

function mainSession(pi: ExtensionAPI): unknown {
	return pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
}

/** Wraps `TodoTracker.prototype.checkCompletion` once; false when this omp has no such method. */
function patchTracker(pi: ExtensionAPI): boolean {
	const tracker: unknown = trackerModule.TodoTracker;
	if (!hasPath(tracker, "prototype.checkCompletion()")) {
		pi.logger.warn("gui-bridge: todo wait unavailable, TodoTracker.checkCompletion missing");
		return false;
	}
	const proto: Record<string | symbol, unknown> = Reflect.get(Object(tracker), "prototype");
	if (proto[ORIGINAL]) return true;
	const original = Reflect.get(proto, "checkCompletion") as MethodOf<Promise<boolean>>;
	proto[ORIGINAL] = original;
	proto.checkCompletion = function checkCompletion(this: unknown, ...args: never[]): Promise<boolean> {
		checking = true;
		try {
			// An async method runs synchronously up to its first await, and the tool-list read is before it.
			return original.apply(this, args);
		} finally {
			checking = false;
		}
	};
	return true;
}

/** Wraps the session class's `getActiveToolNames` once (the main session and every subagent share the class). */
function patchSession(pi: ExtensionAPI): void {
	const session = mainSession(pi);
	if (!session) return;
	const proto: Record<string | symbol, unknown> = Object.getPrototypeOf(session);
	if (proto[ORIGINAL]) return;
	const original = Reflect.get(proto, "getActiveToolNames");
	if (typeof original !== "function") {
		pi.logger.warn("gui-bridge: todo wait unavailable, AgentSession.getActiveToolNames missing");
		proto[ORIGINAL] = true;
		return;
	}
	const names = original as MethodOf<string[]>;
	proto[ORIGINAL] = names;
	proto.getActiveToolNames = function getActiveToolNames(this: WaitSession): string[] {
		const active = names.call(this);
		if (!checking) return active;
		checking = false;
		const reason = waitReason({
			book: this === mainSession(pi) ? book : undefined,
			phases: this.getTodoPhases?.() ?? [],
		});
		if (!reason) return active;
		pi.logger.debug("gui-bridge: todo reminder skipped, the session waits", { reason });
		return active.filter(name => name !== "todo");
	};
}

function arrival(message: {
	role?: unknown;
	customType?: unknown;
	content?: unknown;
	details?: unknown;
}): Arrival | undefined {
	if ((message.role === "custom" || message.role === "hookMessage") && message.customType === MAIL_CUSTOM_TYPE) {
		const details = (
			typeof message.details === "object" && message.details !== null ? message.details : {}
		) as Record<string, unknown>;
		const text = (value: unknown) => (typeof value === "string" ? value : undefined);
		return { kind: "mail", from: text(details.from), title: text(details.fromTitle), mailKind: text(details.kind) };
	}
	if (message.role !== "user") return undefined;
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map(block => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
						.join("")
				: "";
	return { kind: "user", text };
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	if (!patchTracker(pi)) return;
	patchSession(pi);
	pi.on("session_start", (_event, ctx) => {
		if (ctx?.agent?.kind === "main") book.clear();
		patchSession(pi);
	});
	pi.on("before_agent_start", () => {
		patchSession(pi);
	});
	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const text = event.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		const call = controlCall({ toolName: event.toolName, input: event.input, isError: event.isError, text });
		if (call) book.noteCall(event.toolCallId, call);
	});
	const arrived = (event: { message: Parameters<typeof arrival>[0] }, ctx: { agent: { kind?: string } }) => {
		if (ctx.agent.kind !== "main") return;
		const note = arrival(event.message);
		if (note) book.noteArrival(note);
	};
	pi.on("message_start", arrived);
	pi.on("message_end", arrived);
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("todoWait", {});
