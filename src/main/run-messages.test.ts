import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../shared/rpc-types";
import { completeRunMessages } from "./run-messages";

const user: AgentMessage = { role: "user", content: "Use your todo tool", timestamp: 100 };
const call: AgentMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c1", name: "todo", arguments: {} }],
	timestamp: 101,
};
const result: AgentMessage = { role: "toolResult", toolCallId: "c1", toolName: "todo", content: [], timestamp: 102 };
const reminder: AgentMessage = { role: "custom", customType: "todo-reminder", content: "finish", timestamp: 103 };
const reply: AgentMessage = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 104 };

describe("completeRunMessages", () => {
	it("returns a terminal frame that already covers the run unchanged", () => {
		const terminal = [user, call, result];
		expect(completeRunMessages([user, call, result], terminal)).toBe(terminal);
		expect(completeRunMessages([], terminal)).toBe(terminal);
	});

	it("restores the run a deferred continuation agent_end replaced", () => {
		expect(completeRunMessages([user, call, result, reminder, reply], [reminder, reply])).toEqual([
			user,
			call,
			result,
			reminder,
			reply,
		]);
	});

	it("restores the prefix an oversized frame dropped, and everything for an overflowed frame", () => {
		expect(completeRunMessages([user, call, result, reply], [result, reply])).toEqual([user, call, result, reply]);
		expect(completeRunMessages([user, call, result], [])).toEqual([user, call, result]);
	});

	it("prefers the terminal copy and keeps delivery order around messages stock never delivered", () => {
		const touched = { ...result, details: { saved: true } };
		const undelivered: AgentMessage = { role: "custom", customType: "note", content: "n", timestamp: 105 };
		const completed = completeRunMessages([user, call, result, reply], [touched, undelivered, reply]);
		expect(completed).toEqual([user, call, touched, undelivered, reply]);
		expect(completed[2]).toBe(touched);
	});
});
