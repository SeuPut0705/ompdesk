import type { AgentMessage } from "../../shared/rpc-types";

/** Identity shared by live delivery, persisted transcript reconciliation, and viewport anchors. */
export function messageIdentity(message: AgentMessage): string | undefined {
	if (typeof message.id === "string" && message.id.length > 0) return message.id;
	if (message.timestamp !== undefined) return `${message.role}-${String(message.timestamp)}`;
	return message.entryId;
}

/** User text can arrive as either a string or text blocks on the wire. */
export function sameMessageContent(left: AgentMessage, right: AgentMessage): boolean {
	const leftContent = typeof left.content === "string" ? [{ type: "text", text: left.content }] : left.content;
	const rightContent = typeof right.content === "string" ? [{ type: "text", text: right.content }] : right.content;
	return left.role === right.role && JSON.stringify(leftContent) === JSON.stringify(rightContent);
}
