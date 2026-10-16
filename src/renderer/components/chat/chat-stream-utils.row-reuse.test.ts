import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { buildHistoryRowKeys, buildHistoryRows, type HistoryRow, reuseTranscriptRows } from "./chat-stream-utils";

// Scroll performance guard: the transcript's row components are memoized on row
// identity, so a history page prepend (which rebuilds every row) must hand the
// rows already on screen back as the same objects. Rebuilt objects re-render and
// re-derive every mounted work card inside the page's task.

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function turn(index: number): AgentMessage[] {
	const at = 1_000 * index;
	const call = `call-${index}`;
	return [
		user(`Prompt ${index}`, at),
		{
			role: "assistant",
			content: [{ type: "toolCall", id: call, name: "read", arguments: { path: `src/${index}.ts` } }],
			timestamp: at + 1,
		},
		{
			role: "toolResult",
			toolCallId: call,
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			timestamp: at + 2,
		},
		{ role: "assistant", content: [{ type: "text", text: `Answer ${index}` }], timestamp: at + 3 },
	];
}

function rebuild(previous: readonly HistoryRow[], messages: AgentMessage[]): HistoryRow[] {
	const previousKeys = buildHistoryRowKeys(previous);
	const rows = buildHistoryRows(messages, "compact");
	return reuseTranscriptRows(
		new Map(previous.map((row, index) => [previousKeys[index] ?? "", row])),
		rows,
		buildHistoryRowKeys(rows),
	);
}

describe("transcript row reuse", () => {
	it("hands the rows on screen back unchanged when an older page is prepended", () => {
		const loaded = [...turn(3), ...turn(4)];
		const shown = buildHistoryRows(loaded, "compact");
		const rebuilt = rebuild(shown, [...turn(1), ...turn(2), ...loaded]);

		expect(rebuilt.length).toBe(shown.length * 2);
		expect(rebuilt.slice(shown.length)).toEqual(shown);
		for (const [index, row] of rebuilt.slice(shown.length).entries()) expect(row).toBe(shown[index]);
	});

	it("rebuilds a row whose content changed", () => {
		const messages = turn(1);
		const shown = buildHistoryRows(messages, "compact");
		const [prompt, , result, answer] = messages;
		if (!prompt || !result || !answer) throw new Error("turn fixture changed");
		const reread: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/other.ts" } }],
			timestamp: 1_001,
		};
		const rebuilt = rebuild(shown, [prompt, reread, result, answer]);

		expect(rebuilt[0]).toBe(shown[0]);
		expect(rebuilt[1]).not.toBe(shown[1]);
		expect(rebuilt[1]?.kind).toBe("process");
	});
});
