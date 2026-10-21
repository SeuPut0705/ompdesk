import { describe, expect, it } from "vitest";
import { withoutFrameBookkeeping } from "./frame-bookkeeping";

const reply = {
	role: "assistant",
	timestamp: 1,
	content: [{ type: "text", text: "done" }],
	usage: { input: 1 },
	inputTransformations: [{ type: "thinking_dropped", path: "messages.0.content.1" }],
	requestControls: { messageIndex: 2 },
	contextSnapshot: { promptTokens: 10 },
};
const kept = { role: "assistant", timestamp: 1, content: reply.content, usage: reply.usage };

describe("withoutFrameBookkeeping", () => {
	it("leaves the request bookkeeping out of every message a live frame carries, and keeps the rest", () => {
		expect(withoutFrameBookkeeping({ type: "message_end", message: reply })).toEqual({
			type: "message_end",
			message: kept,
		});
		expect(withoutFrameBookkeeping({ type: "turn_end", message: reply, toolResults: [] })).toEqual({
			type: "turn_end",
			message: kept,
			toolResults: [],
		});
		const user = { role: "user", content: "hi", timestamp: 0 };
		const end = withoutFrameBookkeeping({ type: "agent_end", messages: [user, reply] });
		expect(end.messages).toEqual([user, kept]);
		expect((end.messages as unknown[])[0]).toBe(user);
		const update = withoutFrameBookkeeping({
			type: "message_update",
			message: reply,
			assistantMessageEvent: { type: "done", partial: reply },
		});
		expect(update).toEqual({
			type: "message_update",
			message: kept,
			assistantMessageEvent: { type: "done", partial: kept },
		});
		expect(reply.inputTransformations).toHaveLength(1);
	});

	it("hands a frame with nothing to leave out back as it is", () => {
		const frame = { type: "message_end", message: kept };
		expect(withoutFrameBookkeeping(frame)).toBe(frame);
		const status = { type: "agent_start" };
		expect(withoutFrameBookkeeping(status)).toBe(status);
	});
});
