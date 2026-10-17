import type { AgentMessage } from "../../../shared/rpc-types";

/** The prose of one message (string content, or its text parts), trimmed. */
export function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap(part => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();
}

/** What the header's copy button puts on the clipboard: the conversation's prose, tool work left out. */
export function transcriptToText(
	messages: readonly AgentMessage[],
	labels: { user: string; assistant: string },
): string {
	const turns: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = messageText(message);
		if (text) turns.push(`${message.role === "user" ? labels.user : labels.assistant}\n${text}`);
	}
	return turns.join("\n\n");
}
