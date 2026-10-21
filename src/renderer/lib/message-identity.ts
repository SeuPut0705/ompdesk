import type { AgentMessage } from "../../shared/rpc-types";

/**
 * Identity shared by live delivery, persisted transcript reconciliation, and viewport anchors:
 * stock stamps every message once at creation, and parallel tool results that share a
 * millisecond still answer different calls.
 */
export function messageIdentity(message: AgentMessage): string | undefined {
	if (typeof message.id === "string" && message.id.length > 0) return message.id;
	if (message.timestamp !== undefined) {
		const base = `${message.role}-${String(message.timestamp)}`;
		return message.toolCallId ? `${base}-${message.toolCallId}` : base;
	}
	return message.entryId;
}

/**
 * What a transcript page and a live delivery of one message may differ by: the bridge adds `__ompReadGroup` to read
 * calls in pages and committed `agent_end` messages (gui-bridge stream-metadata.ts `decorateMessages`), never to live
 * `message_end`, and leaves a thinking block's `thinkingSignature` out of pages (transcript-page.ts).
 */
function withoutReadGroup(key: string, value: unknown): unknown {
	return key === "__ompReadGroup" || key === "thinkingSignature" ? undefined : value;
}

/** User text can arrive as either a string or text blocks on the wire; read calls with or without bridge metadata. */
export function sameMessageContent(left: AgentMessage, right: AgentMessage): boolean {
	const leftContent = typeof left.content === "string" ? [{ type: "text", text: left.content }] : left.content;
	const rightContent = typeof right.content === "string" ? [{ type: "text", text: right.content }] : right.content;
	return (
		left.role === right.role &&
		JSON.stringify(leftContent, withoutReadGroup) === JSON.stringify(rightContent, withoutReadGroup)
	);
}

/** The same stock message: one identity and one content, delivered live or read back from the transcript. */
export function sameDelivery(left: AgentMessage, right: AgentMessage): boolean {
	const identity = messageIdentity(left);
	return identity !== undefined && identity === messageIdentity(right) && sameMessageContent(left, right);
}
