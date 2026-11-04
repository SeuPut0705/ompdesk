import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pace, paceLine, paceShort, readPace, unionSeconds, waste } from "./session-pace";

const T0 = 1_700_000_000_000;
const user = (atS: number) =>
	JSON.stringify({ type: "message", message: { role: "user", timestamp: T0 + atS * 1000 } });
const assistant = (atS: number, calls: (string | { id: string; name: string; path?: string })[]) =>
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			timestamp: T0 + atS * 1000,
			usage: { output: 10 },
			content: calls.map(call =>
				typeof call === "string"
					? { type: "toolCall", id: call, name: "bash" }
					: { type: "toolCall", id: call.id, name: call.name, arguments: { path: call.path } },
			),
		},
	});
const start = (atS: number, id: string) =>
	JSON.stringify({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(T0 + atS * 1000).toISOString(),
		data: { toolCallId: id },
	});
const result = (atS: number, id: string, toolName = "bash", isError = false) =>
	JSON.stringify({
		type: "message",
		message: { role: "toolResult", timestamp: T0 + atS * 1000, toolCallId: id, toolName, isError },
	});

/** One model call per tool call, each tool 10 s, each generation 5 s. */
function steady(calls: number, name = "bash", path?: string): string[] {
	const lines = [user(0)];
	for (let i = 0; i < calls; i++) {
		const at = i * 15;
		const id = `c${i}`;
		lines.push(assistant(at + 5, [{ id, name, path }]), start(at + 5, id), result(at + 15, id, name));
	}
	return lines;
}

describe("session-pace", () => {
	it("counts two parallel tools once: wall 15 = model 5 + tools 10", () => {
		const lines = [user(0), assistant(5, ["a", "b"]), start(5, "a"), start(5, "b"), result(15, "a"), result(15, "b")];
		const p = pace(lines);
		expect(p.wallS).toBe(15);
		expect(p.toolS).toBe(10);
		expect(p.modelS).toBe(5);
		expect(p.idleS).toBe(0);
		// Per-tool rows still sum each call's own duration.
		expect(p.tools.bash).toEqual({ seconds: 20, calls: 2, errors: 0 });
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

	it("names the file read ten times as waste, ranges and all; nine reads are none", () => {
		const nine = pace(steady(9, "read", "src/x.ts"));
		expect(nine.repeatRead).toEqual({ path: "src/x.ts", count: 9 });
		expect(waste(nine)).toBeUndefined();
		const lines = steady(10, "read", "src/x.ts:50-80");
		lines.push(
			assistant(200, [{ id: "r", name: "read", path: "C:\\work\\y.ts" }]),
			start(200, "r"),
			result(210, "r", "read"),
		);
		const p = pace(lines);
		expect(p.repeatRead).toEqual({ path: "src/x.ts", count: 10 });
		expect(waste(p)).toBe("read src/x.ts ×10");
		expect(paceLine(p)).toBe(
			"Pace: wall 4 min · model+between-calls 2 min (11 calls, median 5.0 s) · tools 2 min · errors 0 · waste: read src/x.ts ×10",
		);
	});

	it("names model calls far above tool calls as waste past ten tool calls; one per tool call, or a short session, is none", () => {
		const steadyPace = pace(steady(12));
		expect(waste(steadyPace)).toBeUndefined();
		expect(paceShort(steadyPace)).toBe("pace 3 min, 12 calls, median 5.0 s");
		// Two thinking-only calls before each of ten tool calls: 30 model calls over 10 tool calls.
		const lines = [user(0)];
		for (let i = 0; i < 10; i++) {
			const at = i * 30;
			lines.push(assistant(at + 5, []), assistant(at + 10, []));
			lines.push(assistant(at + 20, [`c${i}`]), start(at + 20, `c${i}`), result(at + 30, `c${i}`, "bash", i === 9));
		}
		const p = pace(lines);
		expect(waste(p)).toBe("3.0 model calls per tool call");
		expect(paceLine(p)).toBe(
			"Pace: wall 5 min · model+between-calls 3 min (30 calls, median 5.0 s) · tools 2 min · errors 1 · waste: 3.0 model calls per tool call",
		);
		// A two-call child reads 2.0 by shape alone (its answer past the last tool call), never waste.
		expect(waste(pace([...steady(1), assistant(20, [])]))).toBeUndefined();
	});

	it("reads a session file once per change and answers undefined for a missing one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pace-"));
		const file = join(dir, "s.jsonl");
		await writeFile(file, steady(2).join("\n"));
		expect((await readPace(file))?.modelCalls).toBe(2);
		expect(await readPace(file)).toBe(await readPace(file));
		await writeFile(file, steady(3).join("\n"));
		expect((await readPace(file))?.modelCalls).toBe(3);
		expect(await readPace(join(dir, "missing.jsonl"))).toBeUndefined();
	});
});
