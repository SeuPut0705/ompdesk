import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type InboxContent, inboxIdentity, type NativeInboxRequest } from "./agent-inbox-contracts";
import { type InboxSession, NativeInboxController } from "./agent-inbox-engine";
import { guard } from "./health";

const PROCESS_INSTANCE = `${process.pid}-${Math.round(performance.timeOrigin)}`;
const controllers = new WeakMap<object, NativeInboxController>();

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function content(value: unknown): value is InboxContent {
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(part => {
				const block = object(part);
				return block?.type === "text"
					? typeof block.text === "string"
					: block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
			}))
	);
}

function request(value: unknown): NativeInboxRequest {
	const record = object(value);
	const receiver = object(record?.receiver);
	if (
		!receiver ||
		typeof receiver.sessionPath !== "string" ||
		!receiver.sessionPath ||
		typeof receiver.instance !== "string" ||
		!receiver.instance ||
		(receiver.device !== undefined && typeof receiver.device !== "string") ||
		!Array.isArray(record?.entries)
	)
		throw new Error("Native inbox needs a receiver path/incarnation and ordered native inventory.");
	const ids = new Set<string>();
	for (const raw of record.entries) {
		const entry = object(raw);
		const sender = object(entry?.sender);
		if (
			!entry ||
			typeof entry.deliveryId !== "string" ||
			!entry.deliveryId ||
			!sender ||
			typeof sender.session !== "string" ||
			!sender.session ||
			(sender.device !== undefined && typeof sender.device !== "string") ||
			(entry.intent !== "immediate" && entry.intent !== "follow_up") ||
			(entry.kind !== "prompt" && entry.kind !== "report") ||
			typeof entry.triggerTurn !== "boolean" ||
			(entry.kind === "report" && (!object(entry.details) || Array.isArray(entry.details))) ||
			(entry.legacy !== undefined && entry.legacy !== true) ||
			!content(entry.content)
		)
			throw new Error("Native inbox inventory entry is invalid or duplicated.");
		const id = inboxIdentity({ kind: entry.kind, deliveryId: entry.deliveryId });
		if (ids.has(id)) throw new Error("Native inbox inventory entry is duplicated.");
		ids.add(id);
	}
	return value as NativeInboxRequest;
}

function controller(session: object): NativeInboxController {
	let current = controllers.get(session);
	if (!current) {
		current = new NativeInboxController(session as InboxSession, PROCESS_INSTANCE);
		controllers.set(session, current);
	}
	return current;
}

/** Only the private authenticated native Host route calls these. No local/renderer command exposes them. */
export const methods = guard("agentInbox", {
	"agent_control.inbox_status": async (_params, env) => controller(env.session()).status(),
	"agent_control.inbox": async (params, env) => controller(env.session()).accept(request(params)),
});

export function install(pi: ExtensionAPI): void {
	const main = () => pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
	const attach = () => {
		const session = main();
		if (!session) return;
		const agent = object(object(session)?.agent);
		// Unsupported stock stays unsupported in guard; never substitute a raw prompt or a receipt guess.
		if (
			typeof agent?.requestModelBoundary !== "function" ||
			typeof object(session)?.transferQueuedMessagesToAside !== "function"
		)
			return;
		controller(session);
	};
	// Agent captures streamFn when its loop starts. The bridge's first-prompt load gate installs us before it.
	pi.on("session_start", attach);
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.agent.kind === "main") attach();
	});
	pi.on("session_before_switch", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const session = main();
		if (session) controllers.get(session)?.invalidate();
	});
	pi.on("session_switch", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const session = main();
		if (session) controllers.get(session)?.replaceReceiver();
		attach();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const session = main();
		if (session) controllers.get(session)?.invalidate();
	});
	attach();
}
