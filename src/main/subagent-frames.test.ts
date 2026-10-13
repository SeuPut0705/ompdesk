import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, SubagentFrame } from "../shared/rpc-types";
import { BATCH_INTERVAL_MS } from "./event-batcher";
import { createSubagentFrameBatcher } from "./subagent-frames";

const reply = (text: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: 7,
	usage: { input: 1, output: 9, totalTokens: 10 },
});

const delta = (text: string): SubagentFrame => ({
	type: "subagent_event",
	payload: {
		id: "scout",
		event: {
			type: "message_update",
			message: reply(text),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!", partial: reply(text) },
		},
	},
});

const progress: SubagentFrame = {
	type: "subagent_progress",
	payload: { index: 0, agent: "scout", agentSource: "bundled", task: "Read", progress: { id: "scout" } },
} as SubagentFrame;

describe("createSubagentFrameBatcher", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("sends a presentation frame's subagent frames as one ordered batch", () => {
		const sent: SubagentFrame[][] = [];
		const batcher = createSubagentFrameBatcher(frames => sent.push(frames));
		batcher.push(progress);
		batcher.push(delta("a"));
		batcher.push(progress);
		expect(sent).toEqual([]);
		vi.advanceTimersByTime(BATCH_INTERVAL_MS);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.map(frame => frame.type)).toEqual(["subagent_progress", "subagent_event", "subagent_progress"]);
		vi.advanceTimersByTime(BATCH_INTERVAL_MS * 4);
		expect(sent).toHaveLength(1);
	});

	it("flush sends pending frames at once and cancels the timer", () => {
		const sent: SubagentFrame[][] = [];
		const batcher = createSubagentFrameBatcher(frames => sent.push(frames));
		batcher.flush();
		expect(sent).toEqual([]);
		batcher.push(progress);
		batcher.flush();
		expect(sent).toEqual([[progress]]);
		vi.advanceTimersByTime(BATCH_INTERVAL_MS);
		expect(sent).toHaveLength(1);
	});

	it("drops the accumulated reply from message updates but keeps what the surface reads", () => {
		const sent: SubagentFrame[][] = [];
		const batcher = createSubagentFrameBatcher(frames => sent.push(frames));
		const frame = delta("x".repeat(10_000));
		batcher.push(frame);
		batcher.flush();
		const forwarded = sent[0]?.[0];
		if (forwarded?.type !== "subagent_event" || forwarded.payload.event.type !== "message_update")
			throw new Error("expected a message update");
		expect(forwarded.payload.id).toBe("scout");
		expect(forwarded.payload.event.message).toEqual({
			role: "assistant",
			timestamp: 7,
			usage: { input: 1, output: 9, totalTokens: 10 },
		});
		expect(forwarded.payload.event.assistantMessageEvent).toEqual({
			type: "text_delta",
			contentIndex: 0,
			delta: "!",
		});
		expect(JSON.stringify(forwarded).length).toBeLessThan(400);
		// The sidecar's frame (shared with other listeners) is never mutated.
		expect(frame.type === "subagent_event" && frame.payload.event.type === "message_update").toBe(true);
		if (frame.type === "subagent_event" && frame.payload.event.type === "message_update")
			expect(frame.payload.event.assistantMessageEvent.partial).toBeDefined();
	});
});
