/**
 * What a host sends a device for `events` and `subagentFrame` when the device's hello said `slimEvents`, and how the
 * device turns it back into what a local sidecar delivers to its pool.
 *
 * Stock's `message_update` carries the whole accumulated message twice, so a reply of K tokens costs O(K²) bytes on
 * the link (`link-traffic-report.test.ts`). The encoder (host, one per tab and connection) applies the slimming the
 * local pool does on its way to a window ({@link createMessageUpdateSlimmer}: the first update of each message whole,
 * the rest reduced; {@link slimSubagentFrame}: a subagent's every update reduced) and drops a `usage` that repeats the
 * last one of its message. The decoder (device, one per tab) puts the usage back and, for the tab's own stream,
 * rebuilds the snapshot the pool's per-window slimmer needs for a window that attaches mid-message: the text and
 * thinking blocks accumulated from the deltas and the tool call a `toolcall_delta` names. What it hands the pool
 * therefore slims to exactly what a local tab's window receives, and a host that sends whole updates (an older one)
 * passes through untouched.
 */
import type { AgentSessionEvent, MessageContent, SubagentFrame } from "../../shared/rpc-types";
import { createMessageUpdateSlimmer } from "../message-update-slim";
import { slimSubagentFrame } from "../subagent-frames";

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;

/** The stream events carry fields the declared `AssistantMessageEvent` union leaves out. */
interface WireIncrement {
	type: string;
	contentIndex: number;
	delta?: string;
	partial?: { role: MessageUpdate["message"]["role"]; content?: Array<MessageContent | null> };
}

export interface LinkEventEncoder {
	events(batch: AgentSessionEvent[]): AgentSessionEvent[];
	subagentFrame(frame: SubagentFrame): SubagentFrame;
}

export interface LinkEventDecoder {
	events(batch: AgentSessionEvent[]): AgentSessionEvent[];
	subagentFrame(frame: SubagentFrame): SubagentFrame;
}

/** Drops `message.usage` from an update that repeats the last one of its stream, keyed by `key`. */
function usageDropper(): (key: string, update: MessageUpdate) => MessageUpdate {
	const sent = new Map<string, { timestamp: unknown; json: string }>();
	return (key, update) => {
		const { usage, timestamp } = update.message;
		if (usage === undefined || timestamp === undefined) return update;
		const json = JSON.stringify(usage);
		const last = sent.get(key);
		if (last?.timestamp === timestamp && last.json === json) {
			const { usage: _usage, ...message } = update.message;
			return { ...update, message };
		}
		sent.set(key, { timestamp, json });
		return update;
	};
}

/** The inverse of {@link usageDropper}: an update without `usage` gets the last one of its stream and message. */
function usageRestorer(): (key: string, update: MessageUpdate) => MessageUpdate {
	const known = new Map<string, { timestamp: unknown; usage: MessageUpdate["message"]["usage"] }>();
	return (key, update) => {
		const { usage, timestamp } = update.message;
		if (timestamp === undefined) return update;
		if (usage !== undefined) {
			known.set(key, { timestamp, usage });
			return update;
		}
		const last = known.get(key);
		return last?.timestamp === timestamp ? { ...update, message: { ...update.message, usage: last.usage } } : update;
	};
}

export function createLinkEventEncoder(): LinkEventEncoder {
	const slim = createMessageUpdateSlimmer();
	const drop = usageDropper();
	return {
		events(batch) {
			const slimmed = slim(batch);
			let out: AgentSessionEvent[] | null = null;
			for (const [index, event] of slimmed.entries()) {
				if (event.type !== "message_update") continue;
				const next = drop("", event);
				if (next === event) continue;
				out ??= slimmed.slice();
				out[index] = next;
			}
			return out ?? slimmed;
		},
		subagentFrame(frame) {
			const slimmed = slimSubagentFrame(frame);
			if (slimmed.type !== "subagent_event" || slimmed.payload.event.type !== "message_update") return slimmed;
			return {
				type: slimmed.type,
				payload: { ...slimmed.payload, event: drop(slimmed.payload.id, slimmed.payload.event) },
			};
		},
	};
}

/** The blocks of the message being streamed, rebuilt from the deltas after its first whole update. */
interface Rebuilt {
	timestamp: unknown;
	blocks: Array<MessageContent | undefined>;
}

function advance(blocks: Rebuilt["blocks"], increment: WireIncrement): void {
	const { contentIndex: index } = increment;
	const current = blocks[index];
	switch (increment.type) {
		case "text_start":
			blocks[index] = { type: "text", text: "" };
			break;
		case "thinking_start":
			blocks[index] = { type: "thinking", thinking: "" };
			break;
		case "text_delta":
			blocks[index] = {
				type: "text",
				text: (current?.type === "text" ? current.text : "") + (increment.delta ?? ""),
			};
			break;
		case "thinking_delta":
			blocks[index] = {
				type: "thinking",
				thinking: (current?.type === "thinking" ? current.thinking : "") + (increment.delta ?? ""),
			};
			break;
		case "toolcall_delta": {
			const block = increment.partial?.content?.[index];
			if (block?.type === "toolCall") blocks[index] = block;
			break;
		}
	}
}

export function createLinkEventDecoder(): LinkEventDecoder {
	let rebuilt: Rebuilt | null = null;
	const restore = usageRestorer();
	const decode = (event: AgentSessionEvent): AgentSessionEvent => {
		if (event.type === "message_end" || event.type === "agent_end") {
			rebuilt = null;
			return event;
		}
		if (event.type !== "message_update") return event;
		const { content, timestamp } = event.message;
		if (Array.isArray(content)) {
			rebuilt = { timestamp, blocks: content.slice() };
			restore("", event);
			return event;
		}
		const update = restore("", event);
		const previous = rebuilt;
		const stream: Rebuilt = previous && previous.timestamp === timestamp ? previous : { timestamp, blocks: [] };
		rebuilt = stream;
		const increment = update.assistantMessageEvent as unknown as WireIncrement;
		advance(stream.blocks, increment);
		let { assistantMessageEvent } = update;
		const block = increment.partial?.content?.[increment.contentIndex];
		if (increment.type === "toolcall_delta" && block && increment.partial) {
			// What the local slimmer sends: the block alone, in a sparse array (JSON turned the holes into null).
			const sparse: MessageContent[] = [];
			sparse[increment.contentIndex] = block;
			assistantMessageEvent = {
				...assistantMessageEvent,
				partial: { role: increment.partial.role, content: sparse },
			} as typeof assistantMessageEvent;
		}
		return {
			...update,
			message: { ...update.message, content: stream.blocks.filter(block => block !== undefined) },
			assistantMessageEvent,
		};
	};
	const restoreSubagent = usageRestorer();
	return {
		events(batch) {
			let out: AgentSessionEvent[] | null = null;
			for (const [index, event] of batch.entries()) {
				const next = decode(event);
				if (next === event) continue;
				out ??= batch.slice();
				out[index] = next;
			}
			return out ?? batch;
		},
		subagentFrame(frame) {
			if (frame.type !== "subagent_event" || frame.payload.event.type !== "message_update") return frame;
			const event = restoreSubagent(frame.payload.id, frame.payload.event);
			return event === frame.payload.event ? frame : { type: frame.type, payload: { ...frame.payload, event } };
		},
	};
}
