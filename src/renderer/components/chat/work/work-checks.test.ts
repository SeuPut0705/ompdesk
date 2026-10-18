import { describe, expect, it } from "vitest";
import { checkKind, firstErrorLine, firstFailure, summarizeChecks, testCounts } from "./work-checks";

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
		["rg build src", undefined],
		["ls tests", undefined],
	])("%s → %s", (command, kind) => expect(checkKind(command)).toBe(kind));
});

describe("testCounts", () => {
	it("reads vitest's summary", () =>
		expect(testCounts(" Test Files  12 passed (12)\n      Tests  128 passed (128)\n")).toEqual({ passed: 128 }));
	it("reads jest with failures", () =>
		expect(testCounts("Tests:       2 failed, 40 passed, 42 total")).toEqual({ passed: 40, failed: 2 }));
	it("reads bun test", () => expect(testCounts(" 31 pass\n 0 fail\n")).toEqual({ passed: 31 }));
	it("reads cargo", () => expect(testCounts("test result: ok. 7 passed; 0 failed; 0 ignored")).toEqual({ passed: 7 }));
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
