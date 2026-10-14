import type { AgentMessage } from "../../../shared/rpc-types";
import { isRenderableMessageText } from "../../lib/messages";

export function messageSourceTimestamp(message: AgentMessage) {
	const timestamp = message.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	if (typeof timestamp === "string") {
		const parsed = Date.parse(timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function messageTimestampMs(message: AgentMessage): number {
	return messageSourceTimestamp(message) ?? 0;
}

/** pi-tui chat/messages.ts `SILENT_ABORT_MARKER`, and pi-ai `AIError.Flag.SilentAbort`. */
const SILENT_ABORT_MARKER = "__omp.silent_abort__";
const SILENT_ABORT_FLAG = 0x0200_0000;

/**
 * Stock's own abort of a turn it ends on purpose: a plan proposal awaiting approval, a TTSR
 * rule re-running the step. Never a stop the user made. Kept: the renderer cannot import
 * stock's `isSilentAbort` (pi-tui chat/messages.ts); silent-abort-stock.test.ts pins it.
 */
export function isSilentAbort(message: Pick<AgentMessage, "errorId" | "errorMessage">): boolean {
	return ((message.errorId ?? 0) & SILENT_ABORT_FLAG) !== 0 || message.errorMessage === SILENT_ABORT_MARKER;
}

/** The final reply that closes compact work, including an automatic follow-up boundary. */
export function isWorkReply(message: AgentMessage) {
	if (message.role !== "assistant") return false;
	if (message.errorMessage || message.steering) return true;
	if (typeof message.content === "string") return isRenderableMessageText(message.content);
	const content = message.content ?? [];
	if (content.some(block => block.type === "image")) return true;
	return (
		!content.some(block => block.type === "toolCall") &&
		content.some(block => block.type === "text" && isRenderableMessageText(block.text))
	);
}

/** Source start of the latest unfinished work, not an earlier user turn or completed phase. */
export function workTurnStartedAt(messages: readonly AgentMessage[]) {
	let start: number | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		// A steer is delivered inside a running loop: it redirects work, never starts it.
		if ((message.role === "user" && message.steering !== true) || isWorkReply(message)) break;
		if (message.role !== "assistant") continue;
		const hasWork =
			Array.isArray(message.content) &&
			message.content.some(
				block =>
					block.type === "toolCall" || (block.type === "thinking" && isRenderableMessageText(block.thinking)),
			);
		if (hasWork) start = messageSourceTimestamp(message) ?? start;
	}
	return start;
}
