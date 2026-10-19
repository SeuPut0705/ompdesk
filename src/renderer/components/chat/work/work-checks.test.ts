import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import type { ToolEntry } from "../../../stores/tools";
import { type BackgroundJobVerdict, backgroundJobVerdicts } from "../completion-events";
import { checkKind, firstErrorLine, firstFailure, summarizeChecks, testCounts } from "./work-checks";
import { workOutcomes } from "./work-view";

describe("checkKind", () => {
	it.each([
		["bunx vitest run src/foo.test.ts", "test"],
		["cd app && bun run test:platform", "test"],
		["cargo test -p core", "test"],
		["go test ./...", "test"],
		["python -m pytest -q", "test"],
		["bun run check:types", "typecheck"],
		["npx tsc --noEmit", "typecheck"],
		["bunx biome check src", "lint"],
		["ruff check .", "lint"],
		["bun run build", "build"],
		["cargo build --release", "build"],
		["git status", undefined],
		["ls tests", undefined],
		["grep vitest package.json", undefined],
		["echo 'npm test'", undefined],
		["cat build.log", undefined],
		["npm test && npm run build", undefined],
		["bun run build && bun run build:web", "build"],
		["bunx vitest run 2>&1 | tail -20", "test"],
		["CI=1 npx jest --ci", "test"],
		["node scripts/lint-surfaces.mjs", "lint"],
		["rg build src", undefined],
	])("%s → %s", (command, kind) => expect(checkKind(command)).toBe(kind));
});

describe("testCounts", () => {
	it("reads vitest's summary", () =>
		expect(testCounts(" Test Files  12 passed (12)\n      Tests  128 passed (128)\n")).toEqual({ passed: 128 }));
	it("reads jest with failures", () =>
		expect(testCounts("Tests:       2 failed, 40 passed, 42 total")).toEqual({ passed: 40, failed: 2 }));
	it("reads bun test", () => expect(testCounts(" 31 pass\n 0 fail\n")).toEqual({ passed: 31 }));
	it("reads cargo", () => expect(testCounts("test result: ok. 7 passed; 0 failed; 0 ignored")).toEqual({ passed: 7 }));
	it("does not take a number off the previous line (go's `want 4\\nFAIL`)", () =>
		expect(
			testCounts("--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3, want 4\nFAIL\nFAIL\texample.com/m\t0.002s"),
		).toEqual({}));
	it("reads pytest", () =>
		expect(testCounts("==== 1 failed, 9 passed in 0.31s ====")).toEqual({ passed: 9, failed: 1 }));
});

describe("firstErrorLine", () => {
	it("names the TypeScript error, not the script wrapper", () =>
		expect(
			firstErrorLine(
				"$ tsc --noEmit\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nerror: script \"check:types\" exited with code 2",
			),
		).toBe("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."));
	it("skips runner chrome and ANSI", () =>
		expect(firstErrorLine("\u001b[31m FAIL \u001b[0m src/x.test.ts > adds\n Tests  1 failed (3)")).toBe(
			"FAIL  src/x.test.ts > adds",
		));
	it("names biome's ✖ diagnostic, not its summary", () =>
		expect(
			firstErrorLine(
				"src/a.ts:3:7 lint/style/useConst ━━━━━━\n\n  ✖ This let is only assigned once.\n\nFound 1 error.",
			),
		).toBe("✖ This let is only assigned once."));
	it.each([
		"Wall time: 12.50 seconds",
		"[Showing lines 1-50 of 1000. Read artifact://7 for full output]",
		"[raw output: artifact://7]",
		"[Some lines truncated to 768 bytes. Use artifact://7:raw:3-3 to read line 3 whole]",
		"[Command aborted]",
	])("never takes stock's notice %s as the cause", notice =>
		expect(firstErrorLine(`compiling…\nout of memory\n\n${notice}\n\nCommand exited with code 2`)).toBe(
			"out of memory",
		),
	);
	it("falls back to the last line", () => expect(firstErrorLine("building…\nout of memory")).toBe("out of memory"));
	it("is undefined for empty output", () => expect(firstErrorLine("\n\n")).toBeUndefined());
});

describe("summarizeChecks", () => {
	it("lets the last run decide and lists failures first", () => {
		const checks = summarizeChecks([
			{
				command: "bunx vitest run",
				failed: true,
				exitCode: 1,
				text: " FAIL a.test.ts\n Tests  1 failed | 3 passed",
			},
			{ command: "bun run build", failed: true, exitCode: 1, text: "error during build:\nCould not resolve './x'" },
			{ command: "bunx vitest run", failed: false, exitCode: 0, text: " Tests  4 passed (4)" },
			{ command: "git status", failed: false, exitCode: 0 },
		]);
		expect(checks).toEqual([
			{ kind: "build", passed: false, runs: 1, exitCode: 1, cause: "error during build:" },
			{ kind: "test", passed: true, runs: 2, exitCode: 0, tests: { passed: 4 } },
		]);
	});
	it("ignores interrupted and unknown runs", () =>
		expect(
			summarizeChecks([
				{ command: "bun run build", failed: false, exitCode: null, interrupted: true },
				{ command: "bunx vitest", failed: false, exitCode: null, unknown: true },
			]),
		).toEqual([]));
	it("treats a non-zero exit as failed even when stock did not flag it", () =>
		expect(
			summarizeChecks([{ command: "bunx biome check", failed: false, exitCode: 1, text: "x lint/style" }])[0]
				?.passed,
		).toBe(false));
});

describe("firstFailure", () => {
	it("returns the last failed non-check command", () =>
		expect(
			firstFailure([
				{ command: "git push", failed: true, exitCode: 1 },
				{ command: "bun run build", failed: true, exitCode: 1 },
			])?.command,
		).toBe("git push"));
});

describe("backgrounded checks", () => {
	const command = "bun test src/renderer";
	const backgrounded: ToolEntry = {
		toolName: "bash",
		args: { command },
		status: "done",
		streamingArgs: "",
		result: {
			content: [{ type: "text", text: "Backgrounded as job bg_1" }],
			details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
		},
		isError: false,
		startTime: 1,
		endTime: 2,
	};
	const summary = (verdicts?: ReadonlyMap<string, BackgroundJobVerdict>) =>
		summarizeChecks(workOutcomes([{ entry: backgrounded }], undefined, "", verdicts).commands);

	it("is not a passed check while the job has not delivered", () => {
		expect(summary()).toEqual([]);
		expect(summary(new Map())).toEqual([]);
	});
	it("reads a delivered failed job as failed with its cause", () => {
		const text = [
			"(fail) renders the card [1.20ms]",
			"error: expect(received).toBe(expected)",
			"",
			" 3 pass",
			" 1 fail",
			"Ran 4 tests across 1 file. [88.00ms]",
			"Command exited with code 1",
		].join("\n");
		const [check] = summary(new Map([["bg_1", { failed: true, text }]]));
		expect(check).toMatchObject({ kind: "test", passed: false, exitCode: 1 });
		expect(check.cause).toBe("(fail) renders the card [1.20ms]");
	});
	it("reads a delivered passing job as passed with its test count", () => {
		const text = "bun test v1.2.0\n\n 31 pass\n 0 fail\n 52 expect() calls\nRan 31 tests across 4 files. [310.00ms]";
		expect(summary(new Map([["bg_1", { failed: false, text }]]))).toEqual([
			{ kind: "test", passed: true, runs: 1, exitCode: 0, tests: { passed: 31 } },
		]);
	});
	it("reads the outcome the agent waited for, which stock does not deliver again", () => {
		const waited = {
			role: "toolResult",
			toolCallId: "w1",
			toolName: "wait",
			content: [{ type: "text", text: "bg_1 failed" }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "bg_1",
						type: "bash",
						status: "failed",
						exitCode: 1,
						errorText: "(fail) math > adds [0.40ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file.",
					},
				],
			},
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage;
		const [check] = summary(backgroundJobVerdicts([waited]));
		expect(check).toMatchObject({ kind: "test", passed: false, exitCode: 1, cause: "(fail) math > adds [0.40ms]" });
	});
});
