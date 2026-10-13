import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { buildHistoryRows } from "./chat-stream-utils";

// Shapes from a real omp 18.10 session: a detached agent the user stopped waiting for, whose
// result stock delivered after the stop (async-result) to wake a follow-up reply.
const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
const spawn: AgentMessage[] = [
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "task-1", name: "task", arguments: { tasks: [{ name: "Sleeper" }] } }],
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "task-1",
		toolName: "task",
		content: [{ type: "text", text: "Spawned agent `Sleeper` (job `Sleeper`)." }],
		details: { async: { state: "running", jobId: "Sleeper", type: "task" } },
		timestamp: 3,
	},
	{
		role: "assistant",
		content: [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 4,
	},
	{
		role: "toolResult",
		toolCallId: "wait-1",
		toolName: "wait",
		content: [{ type: "text", text: "Operation aborted" }],
		isError: true,
		timestamp: 5,
	},
	{ role: "assistant", content: [], stopReason: "aborted", timestamp: 6 },
];
const delivery: AgentMessage = {
	role: "custom",
	customType: "async-result",
	content: "<system-notice>\nBackground job Sleeper has completed.\n</system-notice>",
	display: true,
	details: { jobs: [{ jobId: "Sleeper", type: "task", status: "completed", agentId: "Sleeper", durationMs: 64_057 }] },
	timestamp: 60,
};
const reply: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Sleeper finished." }],
	stopReason: "stop",
	timestamp: 61,
};

describe("background job deliveries", () => {
	it("join the card of a run that stopped before replying", () => {
		const rows = buildHistoryRows([user("Start Sleeper", 1), ...spawn, delivery, reply], "compact");
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message"]);
		const work = rows[1];
		expect(work?.kind === "process" && work.notes).toEqual([delivery]);
	});

	it("keep their place after the run's reply or once the user started another turn", () => {
		for (const between of [reply, user("Next", 30)]) {
			const rows = buildHistoryRows([user("Start Sleeper", 1), ...spawn, between, delivery], "compact");
			expect(rows.at(-1)).toEqual({ kind: "message", message: delivery });
		}
	});
});
