import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../../stores/tools";
import { type WorkEvidence, workOutcomes } from "../../chat/work/work-view";
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

/** The board's inputs: the session's main-agent calls, and the newest turn's ledger as its card builds it. */
function check(session: [string, ToolEntry][], turn: WorkEvidence[]) {
	return lastCheck(session, workOutcomes(turn, undefined, "/repo").commands, "/repo", new Map());
}
const main = (key: string, entry: ToolEntry): WorkEvidence => ({ entry, toolCallId: key });

describe("lastCheck", () => {
	it("names the newest turn's failed check no later run of the same call fixed, as its card does", () => {
		const a = bash("bunx vitest run", " Tests  1 failed (3)", 1, 0, "packages/a");
		const b = bash("bunx vitest run", " Tests  4 passed (4)", 0, 2_000, "packages/b");
		expect(
			check(
				[
					["a", a],
					["b", b],
				],
				[main("a", a), main("b", b)],
			),
		).toMatchObject({ key: "a", state: "failed", count: 1 });
	});

	it("names the newest run once the same call passed", () => {
		const failed = bash("bunx vitest run", " Tests  1 failed (3)", 1, 0);
		const passed = bash("bunx vitest run", " Tests  4 passed (4)", 0, 2_000);
		expect(
			check(
				[
					["a", failed],
					["b", passed],
				],
				[main("a", failed), main("b", passed)],
			),
		).toMatchObject({ key: "b", state: "passed", count: 4 });
	});

	it("lets an earlier turn's failure go once a later turn is green", () => {
		const earlier = bash("bun run check:types", "error TS2322", 2, 0);
		const later = bash("bunx vitest run", " Tests  4 passed (4)", 0, 60_000);
		expect(
			check(
				[
					["t1", earlier],
					["t2", later],
				],
				[main("t2", later)],
			),
		).toMatchObject({ key: "t2", state: "passed" });
	});

	it("reads a subagent's calls as the card does: a main rerun fixes the subagent's failure", () => {
		const child = bash("bun run check:types", "error TS2322", 2, 0);
		const rerun = bash("bun run check:types", "ok", 0, 5_000);
		expect(check([["m", rerun]], [{ entry: child, agentName: "Worker" }, main("m", rerun)])).toMatchObject({
			key: "m",
			state: "passed",
		});
	});

	it("names a subagent's unfixed check failure, which has no call of the main agent to open", () => {
		const child = bash("bun run check:types", "error TS2322", 2, 0);
		const result = check([], [{ entry: child, agentName: "Worker" }]);
		expect(result).toMatchObject({ kind: "typecheck", state: "failed" });
		expect(result?.key).toBeUndefined();
	});

	it("names a check still running, whatever failed before it", () => {
		const failed = bash("bun run check:types", "error TS2322", 2, 0);
		const running: ToolEntry = { ...bash("bun run build", "", 0, 3_000), status: "running", endTime: null };
		expect(
			check(
				[
					["a", failed],
					["b", running],
				],
				[main("a", failed), main("b", running)],
			),
		).toMatchObject({ key: "b", state: "running" });
	});

	// 26 Oct 2026: a subagent asked for a named (service) build with `async` and `timeout`; stock's bash refused the call
	// before running anything, and the board said "Check · build failed · 0ms" for the rest of the turn.
	it("never names a build the bash tool refused before running it, and names the build that did run", () => {
		const refused: ToolEntry = {
			...bash(
				"pnpm build 2>&1 | tail -40",
				"Service mode does not accept async or timeout; use ready.timeout for readiness.",
				1,
				5_000,
			),
			result: {
				content: [
					{
						type: "text",
						text: "Service mode does not accept async or timeout; use ready.timeout for readiness.",
					},
				],
				details: {},
			},
			endTime: 5_000,
		};
		expect(check([], [{ entry: refused, agentName: "HP3D" }])).toBeNull();
		const built = bash("pnpm build", "✓ Compiled successfully", 0, 0);
		expect(check([["b", built]], [main("b", built), { entry: refused, agentName: "HP3D" }])).toMatchObject({
			key: "b",
			state: "passed",
		});
	});
});
