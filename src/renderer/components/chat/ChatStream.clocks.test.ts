import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { repeatedClockRows } from "./ChatStream";
import type { HistoryRow } from "./chat-stream-utils";

const today = new Date();
today.setHours(14, 5, 10, 0);
const at = (minute: number, dayOffset = 0) => today.getTime() + dayOffset * 86_400_000 + (minute - 5) * 60_000;

const prompt = (timestamp: number): HistoryRow => ({
	kind: "message",
	message: { role: "user", content: "fix it", timestamp } as AgentMessage,
});
const reply = (timestamp: number): HistoryRow => ({
	kind: "message",
	message: { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp } as unknown as AgentMessage,
});
const toolOnly = (timestamp: number): HistoryRow => ({
	kind: "message",
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
		timestamp,
	} as unknown as AgentMessage,
});

describe("repeated clocks", () => {
	it("hides a clock that repeats the one above and shows a new minute", () => {
		const rows = [prompt(at(5)), reply(at(5)), prompt(at(6))];
		const repeated = repeatedClockRows(rows);
		expect(rows.map(row => repeated.has(row))).toEqual([false, true, false]);
	});

	it("compares with the last clock drawn, past a row that draws none", () => {
		const rows = [prompt(at(5)), toolOnly(at(6)), reply(at(6))];
		const repeated = repeatedClockRows(rows);
		expect(repeated.has(rows[2] as HistoryRow)).toBe(false);
	});

	it("shows the same minute on another day", () => {
		const rows = [prompt(at(5, -1)), reply(at(5))];
		expect(repeatedClockRows(rows).size).toBe(0);
	});
});
