import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../../stores/tools";
import { lastCheck } from "./session-board";

function bash(command: string, text: string, exitCode: number, at: number, cwd?: string): ToolEntry {
	return {
		toolName: "bash",
		args: { command, ...(cwd ? { cwd } : {}) },
		status: exitCode ? "error" : "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text }], details: { exitCode } },
		isError: exitCode !== 0,
		startTime: at,
		endTime: at + 1_000,
	};
}

const check = (entries: [string, ToolEntry][]) => lastCheck(entries, "/repo", new Map());

describe("lastCheck", () => {
	it("names a failed check no later run of the same command fixed, as the work card does", () => {
		expect(
			check([
				["a", bash("bunx vitest run", " Tests  1 failed (3)", 1, 0, "packages/a")],
				["b", bash("bunx vitest run", " Tests  4 passed (4)", 0, 2_000, "packages/b")],
			]),
		).toMatchObject({ key: "a", state: "failed", count: 1 });
	});

	it("names the newest run once the same command passed", () => {
		expect(
			check([
				["a", bash("bunx vitest run", " Tests  1 failed (3)", 1, 0)],
				["b", bash("bunx vitest run", " Tests  4 passed (4)", 0, 2_000)],
			]),
		).toMatchObject({ key: "b", state: "passed", count: 4 });
	});

	it("names a check still running, whatever failed before it", () => {
		const running: ToolEntry = { ...bash("bun run build", "", 0, 3_000), status: "running", endTime: null };
		expect(
			check([
				["a", bash("bun run check:types", "error TS2322", 2, 0)],
				["b", running],
			]),
		).toMatchObject({ key: "b", state: "running" });
	});
});
