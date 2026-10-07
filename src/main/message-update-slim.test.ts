import { describe, expect, it } from "vitest";
import { createMessagesStore } from "../renderer/stores/messages";
import { createToolsStore, selectToolEntry } from "../renderer/stores/tools";
import type { AgentMessage, AgentSessionEvent, AssistantMessageEvent } from "../shared/rpc-types";
import { createMessageUpdateSlimmer, slimMessageUpdate } from "./message-update-slim";

type MessageUpdate = Extract<AgentSessionEvent, { type: "message_update" }>;

const usage = { input: 10, output: 42, totalTokens: 52 };

function snapshot(timestamp: number): AgentMessage {
	return {
		role: "assistant",
		timestamp,
		usage,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		content: [
			{ type: "thinking", thinking: "plan ".repeat(200) },
			{ type: "text", text: "answer ".repeat(200) },
			{
				type: "toolCall",
				id: "call-1",
				name: "write",
				arguments: { path: "a.ts", content: "x".repeat(500) },
				partialArgs: `{"path":"a.ts","content":"${"x".repeat(500)}`,
			},
		],
	};
}

function update(timestamp: number, assistantMessageEvent: AssistantMessageEvent): MessageUpdate {
	return { type: "message_update", messageId: "msg-1", message: snapshot(timestamp), assistantMessageEvent };
}

describe("slimMessageUpdate", () => {
	it("text_delta keeps role, timestamp, usage and the delta", () => {
		const slim = slimMessageUpdate(
			update(7, { type: "text_delta", contentIndex: 1, delta: "next", partial: snapshot(7) }),
		);
		expect(slim).toEqual({
			type: "message_update",
			messageId: "msg-1",
			message: { role: "assistant", timestamp: 7, usage },
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "next" },
		});
	});

	it("thinking_delta keeps role, timestamp, usage and the delta", () => {
		const slim = slimMessageUpdate(
			update(7, { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: snapshot(7) }),
		);
		expect(slim.message).toEqual({ role: "assistant", timestamp: 7, usage });
		expect(slim.assistantMessageEvent).toEqual({ type: "thinking_delta", contentIndex: 0, delta: "hmm" });
	});

	it("toolcall_delta keeps only the streamed toolCall block's id and name at its index", () => {
		const slim = slimMessageUpdate(
			update(7, { type: "toolcall_delta", contentIndex: 2, delta: '"}', partial: snapshot(7) }),
		);
		expect(slim.message).toEqual({ role: "assistant", timestamp: 7, usage });
		const ame = slim.assistantMessageEvent;
		expect(ame).toMatchObject({ type: "toolcall_delta", contentIndex: 2, delta: '"}' });
		const content = ame.partial?.content;
		if (!Array.isArray(content)) throw new Error("toolCall block missing");
		expect(Object.keys(content)).toEqual(["2"]);
		expect(content[2]).toEqual({ type: "toolCall", id: "call-1", name: "write", arguments: {} });
		expect(Object.keys(ame.partial ?? {}).sort()).toEqual(["content", "role"]);
	});

	it("drops snapshot fields of stream events outside the declared union", () => {
		// text_end carries the finished block text; done carries the whole message.
		const textEnd = { type: "text_end", contentIndex: 1, content: "answer ".repeat(200), partial: snapshot(7) };
		const done = { type: "done", reason: "stop", message: snapshot(7) };
		for (const [wire, kept] of [
			[textEnd, { type: "text_end", contentIndex: 1 }],
			[done, { type: "done", reason: "stop" }],
		] as const) {
			const slim = slimMessageUpdate({
				type: "message_update",
				message: snapshot(7),
				assistantMessageEvent: wire as unknown as AssistantMessageEvent,
			});
			expect(slim.assistantMessageEvent).toEqual(kept);
		}
	});

	it("omits absent timestamp and usage instead of inventing them", () => {
		const slim = slimMessageUpdate({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "a" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b" },
		});
		expect(slim.message).toEqual({ role: "assistant" });
	});
});

describe("createMessageUpdateSlimmer", () => {
	it("forwards each message's first update in full and slims the rest", () => {
		const slimmer = createMessageUpdateSlimmer();
		const first = update(1, { type: "text_delta", contentIndex: 1, delta: "a", partial: snapshot(1) });
		const second = update(1, { type: "text_delta", contentIndex: 1, delta: "b", partial: snapshot(1) });
		const start: AgentSessionEvent = { type: "agent_start" };
		const batch = [start, first, second];
		const out = slimmer(batch);
		expect(out[0]).toBe(start);
		expect(out[1]).toBe(first);
		expect(out[2]).toEqual(slimMessageUpdate(second));
		// The shared batch is never mutated (the run-tracking listener reads it too).
		expect(batch[2]).toBe(second);

		const third = update(1, { type: "text_delta", contentIndex: 1, delta: "c", partial: snapshot(1) });
		expect(slimmer([third])[0]).toEqual(slimMessageUpdate(third));
		// A new message (new timestamp) opens with a full snapshot again.
		const next = update(2, { type: "text_delta", contentIndex: 1, delta: "d", partial: snapshot(2) });
		expect(slimmer([next])[0]).toBe(next);
	});

	it("returns the batch itself when nothing is slimmed", () => {
		const slimmer = createMessageUpdateSlimmer();
		const batch: AgentSessionEvent[] = [{ type: "agent_start" }, { type: "turn_start" }];
		expect(slimmer(batch)).toBe(batch);
	});

	it("a fresh slimmer (tab became visible) resends the full snapshot of an in-flight message", () => {
		const before = createMessageUpdateSlimmer();
		before([update(1, { type: "text_delta", contentIndex: 1, delta: "a", partial: snapshot(1) })]);
		const after = createMessageUpdateSlimmer();
		const resumed = update(1, { type: "text_delta", contentIndex: 1, delta: "b", partial: snapshot(1) });
		expect(after([resumed])[0]).toBe(resumed);
	});
});

describe("renderer stores on slimmed updates", () => {
	it("a tab that joins mid-message streams the same text and tool call as from full snapshots", () => {
		// Progressive snapshots of one reply: text "Hello world", then a write call.
		const at = (text: string, args?: string): AgentMessage => ({
			role: "assistant",
			timestamp: 5,
			usage,
			content: [
				{ type: "text", text },
				...(args === undefined
					? []
					: [{ type: "toolCall" as const, id: "call-9", name: "write", arguments: {}, partialArgs: args }]),
			],
		});
		// omp aliases the snapshot as both `message` and `partial`.
		const progressive = (ame: AssistantMessageEvent & { partial: AgentMessage }): MessageUpdate => ({
			type: "message_update",
			message: ame.partial,
			assistantMessageEvent: ame,
		});
		const wire: AgentSessionEvent[] = [
			// The tab became visible here: it never saw message_start.
			progressive({ type: "text_delta", contentIndex: 0, delta: "lo", partial: at("Hello") }),
			progressive({ type: "text_delta", contentIndex: 0, delta: " world", partial: at("Hello world") }),
			progressive({ type: "toolcall_delta", contentIndex: 1, delta: '{"pa', partial: at("Hello world", '{"pa') }),
			progressive({
				type: "toolcall_delta",
				contentIndex: 1,
				delta: 'th":"a"}',
				partial: at("Hello world", '{"path":"a"}'),
			}),
		];
		const slimmed = createMessageUpdateSlimmer()(wire);
		expect(slimmed.filter((event, index) => event !== wire[index])).toHaveLength(3);

		const full = createMessagesStore();
		const slim = createMessagesStore();
		full.getState().applyEvents(wire);
		slim.getState().applyEvents(slimmed);
		expect(slim.getState().streamingText).toBe("Hello world");
		expect(slim.getState().streamingText).toBe(full.getState().streamingText);
		const { liveChars, liveReportedTokens } = full.getState().turnMeter;
		expect(slim.getState().turnMeter).toMatchObject({ liveChars, liveReportedTokens });

		const fullTools = createToolsStore();
		const slimTools = createToolsStore();
		fullTools.getState().applyEvents(wire);
		slimTools.getState().applyEvents(slimmed);
		const entry = selectToolEntry(slimTools.getState(), "call-9");
		expect(entry).toMatchObject({ toolName: "write", status: "pending", streamingArgs: '{"path":"a"}' });
		expect({ ...entry, startTime: 0 }).toEqual({ ...selectToolEntry(fullTools.getState(), "call-9"), startTime: 0 });
	});
});
