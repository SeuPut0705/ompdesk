import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { buildHistoryRows } from "./chat-stream-utils";

// 25 Oct 2026, 15:07: the person sent a follow-up while a run was working. Stock's stopped reply carried one blank text
// block ("Request was aborted"), the card read it as no stop and drew the cut call as a failure.
const call: AgentMessage = {
	role: "assistant",
	content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 600" } }],
	stopReason: "toolUse",
	timestamp: 2,
};
const cutResult: AgentMessage = {
	role: "toolResult",
	toolCallId: "t1",
	toolName: "bash",
	content: [{ type: "text", text: "Aborted: Cancelled" }],
	isError: true,
	timestamp: 9_000,
};
const stopped = (content: AgentMessage["content"]): AgentMessage => ({
	role: "assistant",
	content,
	stopReason: "aborted",
	errorMessage: "Request was aborted",
	timestamp: 9_100,
});

describe("a stopped reply", () => {
	it.each([
		["empty", []],
		["one blank text block", [{ type: "text", text: "" }]],
		[
			"blank text and blank thinking",
			[
				{ type: "thinking", thinking: "  " },
				{ type: "text", text: "\n" },
			],
		],
	] as const)("with %s content ends the card as stopped and leaves no row of its own", (_, content) => {
		const rows = buildHistoryRows(
			[{ role: "user", content: "Go", timestamp: 1 }, call, cutResult, stopped([...content])],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["message", "process"]);
		const work = rows[1];
		expect(work?.kind === "process" && work.stoppedAt).toBe(9_100);
	});

	it("keeps a reply that said something as its own row, and the card is not stopped by it", () => {
		const rows = buildHistoryRows(
			[
				{ role: "user", content: "Go", timestamp: 1 },
				call,
				cutResult,
				stopped([{ type: "text", text: "Partial answer so far" }]),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message"]);
		const work = rows[1];
		expect(work?.kind === "process" && work.stoppedAt).toBeUndefined();
	});
});
