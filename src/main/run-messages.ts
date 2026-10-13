/**
 * Stock `agent_end.messages` can miss part of the run the client watched:
 * - agent-session.ts defers `agent_end` while the prompt is in flight and keeps
 *   only the newest one (`#pendingAgentEndEmit`), so a prompt that auto-continued
 *   (todo reminder, session_stop hook) ends with the continuation's messages alone;
 * - rpc-frame.ts `compactTerminalFrame` drops a prefix an oversized frame already
 *   delivered by `message_end` (wire `messageCount`).
 * Every one of those messages arrived as a `message_end` first, in stream order.
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "../shared/rpc-types";

/**
 * The messages to commit for `agent_end`: everything delivered by `message_end`
 * since the previous `agent_end`, in delivery order, with the terminal frame's
 * own copy wherever it carries one (a terminal message never delivered keeps its
 * frame position). A frame that already covers the run is returned as is.
 */
export function completeRunMessages(
	delivered: readonly AgentMessage[],
	terminal: readonly AgentMessage[],
): readonly AgentMessage[] {
	if (delivered.length === 0) return terminal;
	// Pair each terminal message with its delivery, newest first: the frame is the run's tail.
	// A copy stock touched after `message_end` still pairs by role, time, and call.
	const deliveredAt = new Map<number, number>();
	let cursor = delivered.length - 1;
	for (let index = terminal.length - 1; index >= 0; index--) {
		const message = terminal[index];
		for (let candidate = cursor; candidate >= 0 && message; candidate--) {
			const sent = delivered[candidate];
			const same =
				sent !== undefined &&
				(isDeepStrictEqual(sent, message) ||
					(typeof sent.timestamp === "number" &&
						sent.role === message.role &&
						sent.timestamp === message.timestamp &&
						sent.toolCallId === message.toolCallId &&
						sent.customType === message.customType));
			if (!same) continue;
			deliveredAt.set(index, candidate);
			cursor = candidate - 1;
			break;
		}
	}
	const messages: AgentMessage[] = [];
	let next = 0;
	for (const [index, message] of terminal.entries()) {
		const at = deliveredAt.get(index);
		if (at !== undefined) {
			messages.push(...delivered.slice(next, at));
			next = at + 1;
		}
		messages.push(message);
	}
	messages.push(...delivered.slice(next));
	return messages.length === terminal.length ? terminal : messages;
}
