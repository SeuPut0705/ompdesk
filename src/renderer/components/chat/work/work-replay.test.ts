/**
 * The work card's check rules against real recorded output: stock's own rpc-ui frames
 * (e2e/fixtures/real-advisor-frames.json, recorded from omp 18.11) through the tools store and
 * `workOutcomes`, and stock bash result texts as stock's bash tool builds them
 * (pi-coding-agent tools/bash.ts `#buildCompletedResult`, pi-tui tools/bash.ts and output-meta.ts:
 * the `Command exited with code N` trailer, `Wall time:` notice, `[Showing lines …]` truncation
 * notice, `[raw output: artifact://N]` footer, `[Command timed out …]`/`[Command aborted]`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../../../shared/rpc-types";
import { createToolsStore } from "../../../stores/tools";
import {
	checkKind,
	commandOperation,
	firstErrorLine,
	type OperationCall,
	settleFailures,
	summarizeChecks,
	testCounts,
	unresolvedFailures,
} from "./work-checks";
import { operationLabel, stepOperations } from "./work-findings";
import { workOutcomes } from "./work-view";

const recording: { events: AgentSessionEvent[] } = JSON.parse(
	readFileSync("e2e/fixtures/real-advisor-frames.json", "utf8"),
);

/** The transcript stock committed over the recording's runs, each message once. */
function committedMessages(): AgentMessage[] {
	const seen = new Set<string>();
	const messages: AgentMessage[] = [];
	for (const event of recording.events) {
		if (event.type !== "agent_end") continue;
		for (const message of event.messages ?? []) {
			const key = `${message.role}|${message.timestamp}`;
			if (seen.has(key)) continue;
			seen.add(key);
			messages.push(message);
		}
	}
	return messages;
}

describe("the real advisor recording", () => {
	it("holds only message/turn/agent frames: no tool_execution events", () => {
		const types = new Set(recording.events.map(event => event.type));
		expect([...types].sort()).toEqual([
			"agent_end",
			"agent_start",
			"message_end",
			"message_start",
			"todo_reminder",
			"turn_end",
			"turn_start",
		]);
	});

	it("derives the run's shell commands from the committed transcript", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages(committedMessages());
		const entries = [...store.getState().finishedTools.values()];
		const outcome = workOutcomes(entries);
		expect(outcome.commands.map(command => command.command)).toEqual(["ls", "wc -l notes.txt", "exit 3"]);
		expect(outcome.commands.map(command => [command.exitCode, command.failed])).toEqual([
			[null, false],
			[null, false],
			// `exit 3` was backgrounded early: stock answered with the job notice, not an exit code.
			[null, false],
		]);
		expect(outcome.commands.every(command => !command.unknown && !command.interrupted)).toBe(true);
		// Nothing here is a check, and nothing failed in a way the card can see.
		expect(outcome.commands.map(command => checkKind(command.command))).toEqual([undefined, undefined, undefined]);
		expect(summarizeChecks(outcome.commands)).toEqual([]);
		expect(unresolvedFailures(outcome.commands.map(commandOperation))).toEqual([]);
		// Non-check, non-failed output is not carried at all.
		expect(outcome.commands.map(command => command.text)).toEqual([undefined, undefined, undefined]);
	});

	it("keeps calls with no tool_execution_end pending, and the outcome skips them", () => {
		const store = createToolsStore();
		for (const event of recording.events) {
			if (event.type !== "agent_end") store.getState().applyEvents([event]);
		}
		const state = store.getState();
		const bash = [...state.liveTools.values()].filter(entry => entry.toolName === "bash");
		expect(bash.map(entry => entry.args.command)).toEqual(["ls", "wc -l notes.txt", "exit 3"]);
		expect(bash.every(entry => entry.status === "pending")).toBe(true);
		const outcome = workOutcomes([...state.liveTools.values(), ...state.finishedTools.values()]);
		expect(outcome.commands).toEqual([]);
		expect(summarizeChecks(outcome.commands)).toEqual([]);
	});

	it("reads the backgrounded job's real completion without taking the exit trailer as its cause", () => {
		const completion = committedMessages().find(message => message.customType === "async-result");
		const body = String(completion?.content).replace(/<\/?system-notice>/g, "");
		expect(firstErrorLine(body)).toBe("(no output)");
		expect(firstErrorLine("(no output)\n\nCommand exited with code 3")).toBe("(no output)");
	});
});

/** A stock bash result as the tools store holds it: text content plus `details`. */
function stockBash(command: string, text: string, details: Record<string, unknown> | null, isError: boolean) {
	const store = createToolsStore();
	store.getState().hydrateMessages([
		{
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }],
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			timestamp: 2,
			content: [{ type: "text", text }],
			details: details ?? undefined,
			isError,
		},
	]);
	return workOutcomes([...store.getState().finishedTools.values()]).commands;
}

const R = "\u001b[31m";
const G = "\u001b[32m";
const D = "\u001b[2m";
const X = "\u001b[0m";
const exited = (code: number) => `\n\nCommand exited with code ${code}`;

interface StockRun {
	name: string;
	command: string;
	output: string;
	exitCode: number;
	kind: ReturnType<typeof checkKind>;
	tests?: { passed?: number; failed?: number };
	cause: string;
}

const RUNS: StockRun[] = [
	{
		name: "vitest failure with ANSI",
		command: "bunx vitest run src/a.test.ts",
		output: [
			`${D} RUN ${X} v3.2.4 /repo`,
			"",
			` ${R}❯${X} src/a.test.ts ${D}(3 tests | 1 failed)${X} 4ms`,
			`   ${R}×${X} adds numbers`,
			"",
			`${R}⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯${X}`,
			"",
			`${R} FAIL ${X} src/a.test.ts > adds numbers`,
			`${R}AssertionError${X}: expected 3 to be 4 // Object.is equality`,
			"",
			` ${D}Test Files${X}  ${R}1 failed${X}${D} (1)${X}`,
			`      ${D}Tests${X}  ${R}1 failed${X} | ${G}2 passed${X}${D} (3)${X}`,
		].join("\n"),
		exitCode: 1,
		kind: "test",
		tests: { passed: 2, failed: 1 },
		cause: "❯ src/a.test.ts (3 tests | 1 failed) 4ms",
	},
	{
		name: "bun test failure",
		command: "bun test",
		output: [
			"bun test v1.2.0",
			"",
			"a.test.ts:",
			"1 | test('x', () => expect(1).toBe(2));",
			"error: expect(received).toBe(expected)",
			"",
			"Expected: 2",
			"Received: 1",
			"(fail) x [0.5ms]",
			"",
			" 3 pass",
			" 1 fail",
			" 1 expect() calls",
			"Ran 4 tests across 1 file. [12.00ms]",
			'error: script "test" exited with code 1',
		].join("\n"),
		exitCode: 1,
		kind: "test",
		tests: { passed: 3, failed: 1 },
		cause: "error: expect(received).toBe(expected)",
	},
	{
		name: "tsc via bun run script",
		command: "bun run check:types",
		output: [
			"$ tsc --noEmit",
			"src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/b.ts(1,1): error TS2304: Cannot find name 'x'.",
			"",
			"Found 2 errors in 2 files.",
			'error: script "check:types" exited with code 2',
		].join("\n"),
		exitCode: 2,
		kind: "typecheck",
		cause: "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
	},
	{
		name: "tsc pretty output with ANSI",
		command: "npx tsc --noEmit",
		output: `${"\u001b[96m"}src/a.ts${X}:${"\u001b[93m"}3${X}:${"\u001b[93m"}7${X} - ${R}error${X}${D} TS2322: ${X}Type 'string' is not assignable to type 'number'.\n\nFound 1 error in src/a.ts${D}:3${X}`,
		exitCode: 2,
		kind: "typecheck",
		cause: "src/a.ts:3:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
	},
	{
		name: "biome check",
		command: "bunx biome check src/a.ts",
		output: [
			"src/a.ts:3:7 lint/style/useConst ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			"",
			"  ✖ This let declares a variable that is only assigned once.",
			"",
			"  > 3 │ let x = 1;",
			"      │     ^",
			"",
			"Checked 1 file in 4ms. No fixes applied.",
			"Found 1 error.",
			"check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			"",
			"  ✖ Some errors were emitted while running checks.",
		].join("\n"),
		exitCode: 1,
		kind: "lint",
		cause: "✖ This let declares a variable that is only assigned once.",
	},
	{
		name: "pytest failure",
		command: "python -m pytest -q",
		output: [
			"F.                                                                       [100%]",
			"=================================== FAILURES ===================================",
			"___________________________________ test_add ___________________________________",
			"",
			"    def test_add():",
			">       assert add(1, 2) == 4",
			"E       assert 3 == 4",
			"",
			"test_a.py:4: AssertionError",
			"=========================== short test summary info ============================",
			"FAILED test_a.py::test_add - assert 3 == 4",
			"========================= 1 failed, 1 passed in 0.03s ==========================",
		].join("\n"),
		exitCode: 1,
		kind: "test",
		tests: { passed: 1, failed: 1 },
		cause: "FAILED test_a.py::test_add - assert 3 == 4",
	},
	{
		name: "cargo test failure",
		command: "cargo test",
		output: [
			"   Compiling core v0.1.0",
			"running 2 tests",
			"test tests::ok ... ok",
			"test tests::bad ... FAILED",
			"",
			"failures:",
			"",
			"---- tests::bad stdout ----",
			"thread 'tests::bad' panicked at src/lib.rs:9:9:",
			"assertion `left == right` failed",
			"",
			"test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
			"",
			"error: test failed, to rerun pass `--lib`",
		].join("\n"),
		exitCode: 101,
		kind: "test",
		tests: { passed: 1, failed: 1 },
		cause: "test tests::bad ... FAILED",
	},
	{
		name: "go test failure",
		command: "go test ./...",
		output: [
			"--- FAIL: TestAdd (0.00s)",
			"    add_test.go:9: got 3, want 4",
			"FAIL",
			"FAIL\texample.com/m\t0.002s",
			"FAIL",
		].join("\n"),
		exitCode: 1,
		kind: "test",
		cause: "--- FAIL: TestAdd (0.00s)",
	},
	{
		name: "npm test failure",
		command: "npm test",
		output: [
			"> app@1.0.0 test",
			"> jest",
			"",
			"FAIL src/a.test.js",
			"  ● adds › works",
			"    expect(received).toBe(expected)",
			"Tests:       1 failed, 2 passed, 3 total",
			"npm ERR! Test failed.  See above for more details.",
		].join("\n"),
		exitCode: 1,
		kind: "test",
		tests: { passed: 2, failed: 1 },
		cause: "FAIL src/a.test.js",
	},
	{
		name: "build with stock's wall-time notice and exit trailer",
		command: "bun run build",
		output: [
			"$ vite build",
			"error during build:",
			"Could not resolve './x' from src/main.ts",
			"",
			"Wall time: 3.21 seconds",
		].join("\n"),
		exitCode: 1,
		kind: "build",
		cause: "error during build:",
	},
];

describe("stock bash results through the pipeline", () => {
	it.each(RUNS)("$name", run => {
		const text = `${run.output}${exited(run.exitCode)}`;
		const commands = stockBash(run.command, text, { exitCode: run.exitCode, wallTimeNoticeEmitted: false }, true);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({ command: run.command, exitCode: run.exitCode, failed: true });
		expect(checkKind(run.command)).toBe(run.kind);
		const [check] = summarizeChecks(commands);
		expect(check).toMatchObject({ kind: run.kind, passed: false, exitCode: run.exitCode, cause: run.cause });
		expect(check?.tests).toEqual(run.tests);
		expect(check?.cause).not.toMatch(/Command exited|script ".*" exited|Wall time|^\s*$/);
	});
});

describe("stock's bash envelope", () => {
	const failing = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";

	it("a quiet failing check names its exit, not the trailer", () => {
		const commands = stockBash("bunx biome check", `${exited(1).trim()}`, { exitCode: 1 }, true);
		expect(summarizeChecks(commands)[0]).toMatchObject({ kind: "lint", passed: false, exitCode: 1 });
		expect(summarizeChecks(commands)[0]?.cause).toBeUndefined();
	});

	it.each([
		["wall-time notice", `${failing}\n\nWall time: 12.50 seconds${exited(2)}`],
		[
			"truncation notice with artifact",
			`${failing}\n\n[Showing lines 1-50 and 900-950 of 1000; 850 middle lines (40KB) elided. Read artifact://7 for full output]${exited(2)}`,
		],
		["raw output footer", `${failing}\n[raw output: artifact://7]${exited(2)}`],
		[
			"column truncation notice",
			`${failing}\n\n[Some lines truncated to 768 bytes. Use artifact://7:raw:3-3 to read line 3 whole]${exited(2)}`,
		],
	])("keeps the cause above a %s", (_name, text) => {
		const [command] = stockBash("npx tsc --noEmit", text, { exitCode: 2 }, true);
		expect(summarizeChecks([command as NonNullable<typeof command>])[0]?.cause).toBe(failing);
	});

	it.each([
		["wall-time notice", "Wall time: 12.50 seconds"],
		["truncation notice", "[Showing lines 1-50 of 1000. Read artifact://7 for full output]"],
		["raw output footer", "[raw output: artifact://7]"],
	])("a trailing %s is no cause", (_name, notice) => {
		expect(firstErrorLine(`compiling…\nout of memory\n\n${notice}`)).toBe("out of memory");
	});

	it("reads a timeout as the cause when nothing else says why", () => {
		const [command] = stockBash(
			"bun run build",
			"building…\n\n[Command timed out after 300 seconds]",
			{ timedOut: true },
			true,
		);
		expect(summarizeChecks([command as NonNullable<typeof command>])[0]).toMatchObject({
			kind: "build",
			passed: false,
			cause: "[Command timed out after 300 seconds]",
		});
	});

	it("drops an aborted run: stock's abort annotation is output, not a verdict", () => {
		const aborted = stockBash("bunx vitest run", "RUN v3\n\n[Command aborted]", { __interrupted: true }, true);
		expect(summarizeChecks(aborted)).toEqual([]);
	});

	it("counts a passing run's summary and clears nothing the exit code did not fail", () => {
		const [command] = stockBash(
			"bunx vitest run",
			" Test Files  2 passed (2)\n      Tests  9 passed (9)\n   Duration  1.2s",
			{ wallTimeNoticeEmitted: false },
			false,
		);
		expect(summarizeChecks([command as NonNullable<typeof command>])).toEqual([
			{ kind: "test", passed: true, runs: 1, exitCode: null, tests: { passed: 9 } },
		]);
	});

	it("keeps only the tail of a long output, where the summary is", () => {
		const long = `${"noise line\n".repeat(2000)} Tests  1 failed | 3 passed (4)${exited(1)}`;
		const [command] = stockBash("bunx vitest run", long, { exitCode: 1 }, true);
		expect(command?.text?.length).toBeLessThanOrEqual(8000);
		expect(testCounts(command?.text ?? "")).toEqual({ passed: 3, failed: 1 });
	});
});

interface Step {
	name: string;
	args: Record<string, unknown>;
	text?: string;
	isError?: boolean;
	details?: Record<string, unknown>;
}

function verdict(steps: readonly Step[]) {
	const store = createToolsStore();
	store.getState().hydrateMessages(
		steps.flatMap((step, index): AgentMessage[] => [
			{
				role: "assistant",
				timestamp: index * 10 + 1,
				content: [{ type: "toolCall", id: `call-${index}`, name: step.name, arguments: step.args }],
			},
			{
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: step.name,
				timestamp: index * 10 + 2,
				content: [{ type: "text", text: step.text ?? "ok" }],
				details: step.details,
				isError: step.isError ?? false,
			},
		]),
	);
	const entries = [...store.getState().finishedTools];
	const commands = workOutcomes(entries.map(([toolCallId, entry]) => ({ entry, toolCallId }))).commands.map(
		commandOperation,
	);
	const settled: { unresolved: OperationCall[]; recovered: OperationCall[] }[] = [
		settleFailures(commands, "/repo"),
		settleFailures(stepOperations(entries), "/repo"),
	];
	const label = (call: OperationCall) => operationLabel(call, "/repo");
	return {
		unresolved: settled.flatMap(({ unresolved }) => unresolved.map(label)),
		recovered: settled.flatMap(({ recovered }) => recovered.map(label)),
	};
}

const run = (command: string, exitCode = 0, text = "ok", cwd?: string): Step => ({
	name: "bash",
	args: { command, ...(cwd ? { cwd } : {}) },
	text: exitCode ? `${text}${exited(exitCode)}` : text,
	isError: exitCode !== 0,
	details: { exitCode },
});
const editing = (path: string, rejected = false): Step => ({
	name: "edit",
	args: { path, edits: [{ old_text: "a", new_text: "b" }] },
	text: rejected ? "Edit rejected: old text not found" : "Updated",
	isError: rejected,
	details: rejected ? undefined : { diff: "-a\n+b" },
});

describe("each failure shape of the replayed turns", () => {
	it.each<[string, Step[], { unresolved: string[]; recovered: string[] }]>([
		[
			"a rejected edit, redone on the same file",
			[editing("src/a.ts", true), editing("/repo/src/a.ts")],
			{ unresolved: [], recovered: ["edit src/a.ts"] },
		],
		[
			"a rejected edit, then only another file edited",
			[editing("src/a.ts", true), editing("src/b.ts")],
			{ unresolved: ["edit src/a.ts"], recovered: [] },
		],
		[
			"a failed push, then a git status",
			[run("git push origin main", 1, "rejected"), run("git status")],
			{ unresolved: ["git push origin main"], recovered: [] },
		],
		[
			"a failed push, then a push of another branch",
			[run("git push origin main", 1, "rejected"), run("git push origin other")],
			{ unresolved: ["git push origin main"], recovered: [] },
		],
		[
			"a failed push, retried",
			[run("git push origin main", 1, "rejected"), run("git push origin main")],
			{ unresolved: [], recovered: ["git push origin main"] },
		],
		[
			"a whole probe's exit 1, a probe closing a list, and a probe followed by more",
			[run("command -v magick", 1, ""), run("ls; grep -n needle src/a.ts", 1, ""), run("grep -n x a; ls", 1, "")],
			{ unresolved: ["grep -n x a; ls"], recovered: [] },
		],
		[
			"a read and a search that found nothing",
			[
				{ name: "read", args: { path: "missing.ts" }, text: "ENOENT", isError: true },
				{ name: "grep", args: { pattern: "x" }, text: "no matches", isError: true },
			],
			{ unresolved: [], recovered: [] },
		],
		[
			"a wait whose job failed",
			[{ name: "wait", args: {}, text: "bg_1 failed", isError: true }],
			{ unresolved: [], recovered: [] },
		],
		[
			"a failed eval, run again",
			[
				{ name: "eval", args: { code: "1/0" }, text: "ZeroDivisionError", isError: true },
				{ name: "eval", args: { code: "1" } },
			],
			{ unresolved: ["eval"], recovered: [] },
		],
		[
			"a lint that failed and was never rerun",
			[run("bunx biome check src", 1, "✖ This let is only assigned once.")],
			{ unresolved: ["bunx biome check src"], recovered: [] },
		],
		[
			"a lint that failed and passed on its rerun",
			[run("bunx biome check src", 1, "✖ This let is only assigned once."), run("bunx biome check src")],
			{ unresolved: [], recovered: ["bunx biome check src"] },
		],
		[
			"a type check that failed in one folder and passed in another",
			[run("cd a && bun run check:types", 2, "error TS2322"), run("cd b && bun run check:types")],
			{ unresolved: ["cd a && bun run check:types"], recovered: [] },
		],
		[
			"a vitest that failed in packages/a, then passed in packages/b",
			[run("bunx vitest run", 1, " FAIL a.test.ts", "packages/a"), run("bunx vitest run", 0, "ok", "packages/b")],
			{ unresolved: ["bunx vitest run"], recovered: [] },
		],
		[
			"tsc -p a failed, then tsc -p b passed",
			[run("tsc -p a", 2, "error TS2322"), run("tsc -p b")],
			{ unresolved: ["tsc -p a"], recovered: [] },
		],
		[
			"check:types failed, then passed in the same folder",
			[run("bun run check:types", 2, "error TS2322", "app"), run("cd app && bun run check:types")],
			{ unresolved: [], recovered: ["bun run check:types"] },
		],
		[
			"an edit without a path, rejected, then another edit without one",
			[
				{ name: "edit", args: { input: "garbled" }, text: "Edit rejected: no file", isError: true },
				{ name: "edit", args: { input: "garbled again" } },
			],
			{ unresolved: ["edit"], recovered: [] },
		],
		[
			"a multi-file edit rejected, then only one of its files redone",
			[
				{
					name: "edit",
					args: {
						edits: [
							{ path: "src/a.ts", old_text: "a", new_text: "b" },
							{ path: "src/b.ts", old_text: "a", new_text: "b" },
						],
					},
					text: "Edit rejected: old text not found in src/b.ts",
					isError: true,
				},
				editing("src/a.ts"),
			],
			{ unresolved: ["edit src/a.ts, src/b.ts"], recovered: [] },
		],
		[
			"a failed todo call",
			[{ name: "todo", args: { op: "done" }, text: "unknown task", isError: true }],
			{ unresolved: ["todo"], recovered: [] },
		],
		[
			"a device write rejected, then sent again unchanged",
			[
				{
					name: "write",
					args: { path: "xd://ompdesk_report", content: '{"kind":"done"}' },
					text: "busy",
					isError: true,
				},
				{ name: "write", args: { path: "xd://ompdesk_report", content: '{"kind":"done"}' } },
			],
			{ unresolved: [], recovered: ["xd://ompdesk_report"] },
		],
		[
			"a device write rejected, then another write to it",
			[
				{
					name: "write",
					args: { path: "xd://ompdesk_report", content: '{"kind":"done"}' },
					text: "invalid",
					isError: true,
				},
				{ name: "write", args: { path: "xd://ompdesk_report", content: '{"kind":"done","text":"ok"}' } },
			],
			{ unresolved: ["xd://ompdesk_report"], recovered: [] },
		],
	])("%s", (_, steps, expected) => {
		expect(verdict(steps)).toEqual(expected);
	});
});
