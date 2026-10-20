import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, MessageContent, SubagentFrame } from "../../shared/rpc-types";
import { createMessageUpdateSlimmer } from "../message-update-slim";
import { slimSubagentFrame } from "../subagent-frames";
import { createLinkEventDecoder, createLinkEventEncoder } from "./link-events";

type Update = Extract<AgentSessionEvent, { type: "message_update" }>;

const usageOf = (output: number) => ({
	input: 1200,
	output,
	cacheRead: 8000,
	totalTokens: 9200 + output,
	cost: { input: 0.003, output: 0.0004, total: 0.0034 },
});

/** One assistant message as stock streams it: thinking, text and a tool call, every update carrying the whole message. */
function stockStream(timestamp: number, deltas = 3): AgentSessionEvent[] {
	const content: MessageContent[] = [];
	const message = { role: "assistant" as const, content, usage: usageOf(0), timestamp };
	const events: AgentSessionEvent[] = [{ type: "message_start", message: { ...message, content: [] } }];
	const update = (assistantMessageEvent: object): void => {
		const snapshot = structuredClone(message);
		events.push({
			type: "message_update",
			message: snapshot,
			assistantMessageEvent: { ...assistantMessageEvent, partial: structuredClone(snapshot) },
		} as unknown as AgentSessionEvent);
	};
	const words = (label: string): string[] => Array.from({ length: deltas }, (_, i) => `${label}${i} `);
	for (const [type, parts] of [
		["thinking", words("think")],
		["text", words("say")],
	] as const) {
		const block = type === "thinking" ? { type, thinking: "" } : { type, text: "" };
		const contentIndex = content.push(block) - 1;
		update({ type: `${type}_start`, contentIndex });
		for (const delta of parts) {
			if (block.type === "thinking") block.thinking += delta;
			else block.text += delta;
			update({ type: `${type}_delta`, contentIndex, delta });
		}
		update({ type: `${type}_end`, contentIndex, content: type === "thinking" ? block.thinking : block.text });
	}
	const call = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: {} };
	const contentIndex = content.push(call) - 1;
	update({ type: "toolcall_start", contentIndex });
	call.arguments = { command: "ls" };
	update({ type: "toolcall_delta", contentIndex, delta: '{"command":"ls"}' });
	message.usage = usageOf(42);
	update({ type: "toolcall_end", contentIndex, toolCall: call });
	events.push({ type: "message_end", message: structuredClone(message) });
	return events;
}

const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The renderer binds a streaming call by its id and name; arguments arrive as deltas. */
const toolIdentity = (block: MessageContent | undefined): unknown =>
	block?.type === "toolCall" ? { id: block.id, name: block.name } : block;

/** What the renderer reads of a window's first update and of every later one (message-update-slim.ts). */
function rendererView(events: AgentSessionEvent[]): unknown {
	return events.map(event => {
		if (event.type !== "message_update") return event.type;
		const blocks = Array.isArray(event.message.content) ? event.message.content : [];
		const increment = event.assistantMessageEvent as unknown as {
			type: string;
			contentIndex: number;
			delta?: string;
			partial?: { content?: MessageContent[] };
		};
		return {
			role: event.message.role,
			timestamp: event.message.timestamp,
			usage: event.message.usage,
			text: blocks
				.flatMap(block =>
					block.type === "text" ? [block.text] : block.type === "thinking" ? [block.thinking] : [],
				)
				.join("|"),
			increment: { type: increment.type, contentIndex: increment.contentIndex, delta: increment.delta },
			call:
				increment.type === "toolcall_delta"
					? toolIdentity(increment.partial?.content?.[increment.contentIndex])
					: undefined,
		};
	});
}

function carried(raw: AgentSessionEvent[], batchSize: number): AgentSessionEvent[] {
	const encoder = createLinkEventEncoder();
	const decoder = createLinkEventDecoder();
	const out: AgentSessionEvent[] = [];
	for (let at = 0; at < raw.length; at += batchSize)
		out.push(...decoder.events(overTheWire(encoder.events(raw.slice(at, at + batchSize)))));
	return out;
}

describe("a slim events frame", () => {
	it("is far smaller than the whole updates and holds no repeated usage", () => {
		const raw = stockStream(1_760_000_000_001, 80);
		const encoded = createLinkEventEncoder().events(raw);
		expect(JSON.stringify(encoded).length * 10).toBeLessThan(JSON.stringify(raw).length);
		const updates = encoded.filter((event): event is Update => event.type === "message_update");
		expect(updates[0]?.message.usage).toEqual(usageOf(0));
		expect(updates.slice(1, -1).every(update => update.message.usage === undefined)).toBe(true);
		expect(updates.at(-1)?.message.usage).toEqual(usageOf(42));
	});

	it("reaches a window that watched from the start as the same events a local tab sends it", () => {
		const raw = stockStream(1_760_000_000_001);
		for (const batchSize of [1, 4, raw.length]) {
			const local = createMessageUpdateSlimmer()(raw);
			const remote = createMessageUpdateSlimmer()(carried(raw, batchSize));
			expect(remote).toEqual(local);
		}
	});

	it("gives a window that attaches mid-message the text, thinking and tool call it would get locally", () => {
		const raw = stockStream(1_760_000_000_001);
		const arrived = carried(raw, 3);
		for (let from = 1; from < raw.length - 1; from++) {
			const local = rendererView(createMessageUpdateSlimmer()(raw.slice(from)));
			const remote = rendererView(createMessageUpdateSlimmer()(arrived.slice(from)));
			expect(remote).toEqual(local);
		}
	});

	it("carries two messages one after the other, each starting whole", () => {
		const raw = [...stockStream(1_760_000_000_001), ...stockStream(1_760_000_000_002)];
		const local = createMessageUpdateSlimmer()(raw);
		expect(createMessageUpdateSlimmer()(carried(raw, 5))).toEqual(local);
	});

	it("passes whole updates from an older host through untouched", () => {
		const raw = overTheWire(stockStream(1_760_000_000_001));
		const decoder = createLinkEventDecoder();
		const out = decoder.events(raw);
		expect(out).toBe(raw);
	});
});

describe("a subagent's slim frames", () => {
	const frame = (id: string, update: Update): SubagentFrame => ({
		type: "subagent_event",
		payload: { id, event: update },
	});
	const updates = (timestamp: number) =>
		stockStream(timestamp).filter((event): event is Update => event.type === "message_update");

	it("arrive as the frames the local batcher slims them to", () => {
		const raw = [
			...updates(1).map(update => frame("a", update)),
			...updates(2).map(update => frame("b", update)),
			{ type: "subagent_lifecycle", payload: { id: "a", status: "started" } } as unknown as SubagentFrame,
		];
		const encoder = createLinkEventEncoder();
		const decoder = createLinkEventDecoder();
		const arrived = raw.map(item => decoder.subagentFrame(overTheWire(encoder.subagentFrame(item))));
		expect(arrived.map(slimSubagentFrame)).toEqual(raw.map(slimSubagentFrame));
		expect(JSON.stringify(raw.map(item => encoder.subagentFrame(item))).length * 3).toBeLessThan(
			JSON.stringify(raw).length,
		);
	});

	it("slim again to themselves, so the device's own batcher changes nothing", () => {
		for (const update of updates(1)) {
			const local = slimSubagentFrame(frame("a", update));
			expect(slimSubagentFrame(overTheWire(local))).toEqual(local);
		}
	});
});
