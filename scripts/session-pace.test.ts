import { describe, expect, it } from "vitest";
import { pace, unionSeconds } from "./session-pace";

const T0 = 1_700_000_000_000;
const user = (atS: number) =>
	JSON.stringify({ type: "message", message: { role: "user", timestamp: T0 + atS * 1000 } });
const assistant = (atS: number, calls: string[]) =>
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			timestamp: T0 + atS * 1000,
			usage: { output: 10 },
			content: calls.map(id => ({ type: "toolCall", id, name: "bash" })),
		},
	});
const start = (atS: number, id: string) =>
	JSON.stringify({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(T0 + atS * 1000).toISOString(),
		data: { toolCallId: id },
	});
const result = (atS: number, id: string, toolName = "bash") =>
	JSON.stringify({
		type: "message",
		message: { role: "toolResult", timestamp: T0 + atS * 1000, toolCallId: id, toolName },
	});

describe("session-pace", () => {
	it("counts two parallel tools once: wall 15 = model 5 + tools 10", () => {
		const lines = [user(0), assistant(5, ["a", "b"]), start(5, "a"), start(5, "b"), result(15, "a"), result(15, "b")];
		const p = pace(lines);
		expect(p.wallS).toBe(15);
		expect(p.toolS).toBe(10);
		expect(p.modelS).toBe(5);
		expect(p.idleS).toBe(0);
		// Per-tool rows still sum each call's own duration.
		expect(p.tools.get("bash")).toEqual({ seconds: 20, calls: 2, errors: 0 });
	});

	it("a long gap a tool ran through is that tool's time, not idle; one without a tool is idle", () => {
		const lines = [
			user(0),
			assistant(5, ["w"]),
			start(5, "w"),
			result(1205, "w", "wait"), // 20 min inside `wait`
			assistant(1210, []),
			user(2500), // 21.5 min with nothing running: the person was away
			assistant(2505, []),
		];
		const p = pace(lines);
		expect(p.toolS).toBe(1200);
		expect(p.idleS).toBe(2500 - 1210);
		expect(p.modelS).toBe(2505 - 1200 - (2500 - 1210));
	});

	it("unions overlapping, touching and disjoint intervals", () => {
		expect(unionSeconds([])).toBe(0);
		expect(
			unionSeconds([
				[0, 10],
				[5, 15],
				[15, 20],
				[30, 35],
			]),
		).toBe(25);
	});
});
