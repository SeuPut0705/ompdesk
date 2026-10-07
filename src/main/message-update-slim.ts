/**
 * omp's default `set_event_filter` (messageUpdates "full") attaches the whole
 * accumulated message to every streaming `message_update` — twice, as `message`
 * and `assistantMessageEvent.partial` — so forwarding a reply as-is costs
 * O(reply) per delta and O(reply²) over the run in IPC structured clones.
 * The renderer reads only:
 *
 * - messages store: `message.role`/`timestamp` and, on the first update of a
 *   message whose `message_start` it missed (a tab that just became visible),
 *   the text/thinking blocks of the snapshot to seed its buffers; then deltas.
 * - tools store: `message.timestamp` and, for `toolcall_delta`, the toolCall
 *   block at `partial.content[contentIndex]` (its id and name; arguments
 *   stream as deltas).
 * - turn meter: `message.usage` and the delta length.
 */
import type { AgentMessage, AgentSessionEvent, AssistantMessageEvent, MessageContent } from "../shared/rpc-types";

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;

/**
 * Snapshot-bearing fields of the stream events the declared union leaves out
 * (pi-ai `AssistantMessageEvent`): `text_end`/`thinking_end`/`image_end`
 * `content`, `toolcall_end` `toolCall`, `done` `message`, `error` `error`.
 */
interface WireSnapshotFields {
	content?: unknown;
	toolCall?: unknown;
	message?: unknown;
	error?: unknown;
}

/** Reduce one `message_update` to the fields the renderer reads after the first update of its message. */
export function slimMessageUpdate(event: MessageUpdate): MessageUpdate {
	const source = event.message;
	const message: AgentMessage = { role: source.role };
	if (source.timestamp !== undefined) message.timestamp = source.timestamp;
	if (source.usage !== undefined) message.usage = source.usage;
	const {
		partial,
		content: _content,
		toolCall: _toolCall,
		message: _message,
		error: _error,
		...increment
	}: AssistantMessageEvent & WireSnapshotFields = event.assistantMessageEvent;
	let assistantMessageEvent: AssistantMessageEvent = increment;
	if (increment.type === "toolcall_delta" && partial && Array.isArray(partial.content)) {
		const block = partial.content[increment.contentIndex];
		if (block?.type === "toolCall") {
			// Sparse on purpose: consumers index by contentIndex, and structured
			// clone keeps the hole instead of the blocks that were there.
			const content: MessageContent[] = [];
			content[increment.contentIndex] = { type: "toolCall", id: block.id, name: block.name, arguments: {} };
			assistantMessageEvent = { ...increment, partial: { role: partial.role, content } };
		}
	}
	return { ...event, message, assistantMessageEvent };
}

const NO_MESSAGE = Symbol("no message");

/**
 * One slimmer per renderer attachment (a tab's full-channel wiring). The
 * first `message_update` of each message it forwards keeps the full snapshot,
 * because a tab that just became visible never saw that message's
 * `message_start`; every later update of the same message is slimmed. Messages
 * stream one at a time per session, so the last full message's timestamp is
 * the whole state.
 */
export function createMessageUpdateSlimmer(): (events: AgentSessionEvent[]) => AgentSessionEvent[] {
	let fullTimestamp: unknown = NO_MESSAGE;
	return events => {
		let slimmed: AgentSessionEvent[] | null = null;
		for (const [index, event] of events.entries()) {
			if (event.type !== "message_update") continue;
			if (event.message.timestamp !== fullTimestamp) {
				fullTimestamp = event.message.timestamp;
				continue;
			}
			// The batch is shared with other listeners (run tracking): copy, never mutate.
			slimmed ??= events.slice();
			slimmed[index] = slimMessageUpdate(event);
		}
		return slimmed ?? events;
	};
}
