import { describe, expect, it } from "vitest";
import { CHECKOUT_REFUSAL_PREFIX } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { AgentMessage } from "../../../../shared/rpc-types";
import type { ToolEntry } from "../../../stores/tools";
import { transcriptToolEntries } from "../../../stores/tools";
import { type BackgroundJobVerdict, backgroundJobVerdicts } from "../completion-events";
import {
	checkKind,
	checkKinds,
	commandOperation,
	commandProgram,
	firstErrorLine,
	type OperationCall,
	settleFailures,
	summarizeChecks,
	testCounts,
	unresolvedFailures,
} from "./work-checks";
import { stepOperations } from "./work-findings";
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

describe("checkKinds reads each command once (perf: the board re-reads every bash call per streamed event)", () => {
	it("answers a repeated command with the same list, plain and grouped kept apart", () => {
		const command = "(bunx vitest run src/a.test.ts) && bun run build";
		const grouped = checkKinds(command, true);
		expect(grouped).toEqual(["test", "build"]);
		expect(checkKinds(command, true)).toBe(grouped);
		expect(checkKinds(command)).toEqual(["build"]);
		expect(checkKinds(command)).toBe(checkKinds(command));
	});
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
	it("keeps a check that failed in one package failed when only another package's run passed after it", () => {
		const checks = summarizeChecks([
			{ command: "bunx vitest run", cwd: "packages/a", failed: true, exitCode: 1, text: " FAIL a.test.ts" },
			{ command: "bunx vitest run", cwd: "packages/b", failed: false, exitCode: 0, text: " Tests  4 passed (4)" },
		]);
		expect(checks.map(check => [check.kind, check.passed, check.cause])).toEqual([["test", false, "FAIL a.test.ts"]]);
	});
	it("reads a check rerun inside a chain of checks as the verdict does: passed", () => {
		const checks = summarizeChecks([
			{ command: "node scripts/lint-surfaces.mjs", failed: true, exitCode: 1, text: "✖ raw button" },
			{ command: "node scripts/lint-surfaces.mjs && bunx biome check src", failed: false, exitCode: 0 },
		]);
		expect(checks.map(check => [check.kind, check.passed])).toEqual([["lint", true]]);
	});
});

const bash = (command: string, exitCode: number, cwd?: string): OperationCall => ({
	toolName: "bash",
	args: { command, ...(cwd ? { cwd } : {}) },
	outcome: exitCode === 0 ? "passed" : "failed",
	exitCode,
});
const editOf = (path: string, failed: boolean): OperationCall => ({
	toolName: "edit",
	args: { path },
	outcome: failed ? "failed" : "passed",
});
const write = (path: string, content: string, failed: boolean): OperationCall => ({
	toolName: "write",
	args: { path, content },
	outcome: failed ? "failed" : "passed",
});

describe("settleFailures", () => {
	it.each<[string, OperationCall[]]>([
		["the same command rerun green", [bash("bun run check:types", 2), bash("bun run check:types", 0)]],
		[
			"the same command, its spacing changed",
			[bash("git push origin main", 1), bash("  git  push origin\nmain ", 0)],
		],
		[
			"the same command in the same folder",
			[bash("bunx tsc --noEmit", 2, "app"), bash("bunx tsc --noEmit", 0, "./app")],
		],
		["a rejected edit redone on the same path", [editOf("src/a.ts", true), editOf("./src/a.ts", false)]],
		[
			"a device write sent again with the same arguments, its intent reworded",
			[
				{
					toolName: "write",
					args: { path: "xd://ompdesk_report", content: "{}", i: "Reporting" },
					outcome: "failed",
				},
				{
					toolName: "write",
					args: { content: "{}", path: "xd://ompdesk_report", i: "Retrying" },
					outcome: "passed",
				},
			],
		],
		[
			"an eval run again with the same code, its intent reworded",
			[
				{ toolName: "eval", args: { language: "py", code: "1/0", intent: "Dividing" }, outcome: "failed" },
				{ toolName: "eval", args: { language: "py", code: "1/0", intent: "Retrying" }, outcome: "passed" },
			],
		],
		[
			"a subagent's check, then the main agent's same command",
			[{ ...bash("bun test", 1), agentName: "Worker" }, bash("bun test", 0)],
		],
		[
			"a check run with `cd <dir> &&`, then the same check with that folder as its cwd",
			[bash("cd packages/a && bun test", 1), bash("bun test", 0, "packages/a")],
		],
		[
			"a command with the session's folder as cwd, then without one",
			[bash("bun test", 1, "/repo"), bash("bun test", 0)],
		],
		[
			"a failure, then the same call started once it ended",
			[
				{ ...bash("bun test", 1), startTime: 0, endTime: 1_000 },
				{ ...bash("bun test", 0), startTime: 1_000, endTime: 2_000 },
			],
		],
		[
			"a lint, then that lint and another after &&",
			[bash("node scripts/lint-surfaces.mjs", 1), bash("node scripts/lint-surfaces.mjs && bunx biome check src", 0)],
		],
		[
			"a type check piped through filters, then the plain type check",
			[bash('bun run check:types 2>&1 | grep -v "attention" | tail -8', 2), bash("bun run check:types", 0)],
		],
		[
			"a subagent's test files failing, then its run of the folders holding them",
			[
				{
					...bash(
						"cd /repo && (bun run check:types 2>&1 | tail -30) ; OMP_VITEST_WORKERS=3 bunx vitest run src/chat/ExecutionGroup.chips.test.tsx src/chat/work/work-checks.test.ts 2>&1 | tail -80",
						0,
					),
					outcome: "failed",
					agentName: "Worker",
				},
				{
					...bash(
						"cd /repo && OMP_VITEST_WORKERS=3 bunx vitest run src/chat/ExecutionGroup src/chat/work 2>&1 | tail -40",
						0,
					),
					agentName: "Worker",
					text: " Test Files  54 passed (54)\n      Tests  861 passed (861)\n",
				},
			],
		],
		[
			"a test run of one file, then the whole suite",
			[bash("bunx vitest run src/a.test.ts", 1), bash("bunx vitest run", 0)],
		],
	])("is fixed by a later success of the same call: %s", (_, calls) => {
		expect(settleFailures(calls, "/repo")).toEqual({ unresolved: [], recovered: [calls[0]] });
	});

	it.each<[string, OperationCall[]]>([
		["a failed push, then a git status", [bash("git push origin main", 1), bash("git status", 0)]],
		[
			"a failed push, then a push of another branch",
			[bash("git push origin main", 1), bash("git push origin other", 0)],
		],
		["a failed push, then a dry run", [bash("git push origin main", 1), bash("git push --dry-run origin main", 0)]],
		["a failed publish, then a dry run", [bash("npm publish", 1), bash("npm publish --dry-run", 0)]],
		["a failed delete, then a push", [bash("git push --delete origin feat", 1), bash("git push origin feat", 0)]],
		["a squash merge, then auto-merge", [bash("gh pr merge 3 --squash", 1), bash("gh pr merge 3 --auto", 0)]],
		[
			"one repository, then another",
			[bash("gh pr merge 3 --squash --repo=acme/a", 1), bash("gh pr merge 3 --squash --repo=acme/b", 0)],
		],
		[
			"one cluster, then another",
			[bash("kubectl --context=prod apply -f d.yaml", 1), bash("kubectl --context=staging apply -f d.yaml", 0)],
		],
		[
			"one test selector, then another",
			[bash('bunx vitest run -t "login flow"', 1), bash('bunx vitest run -t "signup flow"', 0)],
		],
		["one script, then another of the same kind", [bash("bun run test:e2e", 1), bash("bun run test:platform", 0)]],
		["one test runner, then another", [bash("cargo test", 101), bash("bun test", 0)]],
		[
			"one package's tests, then another's",
			[bash("bunx vitest run", 1, "packages/a"), bash("bunx vitest run", 0, "packages/b")],
		],
		["one workspace filter, then another", [bash("pnpm --filter=a test", 1), bash("pnpm --filter=b test", 0)]],
		["tsc -p a, then tsc -p b", [bash("tsc -p a", 2), bash("tsc -p b", 0)]],
		[
			"a check, then the same check piped into tail with no output to read",
			[bash("bun run check:types", 2), bash("bun run check:types 2>&1 | tail -20", 0)],
		],
		[
			"a lint, then that lint before something else that decides the exit",
			[bash("node scripts/lint-surfaces.mjs", 1), bash("node scripts/lint-surfaces.mjs; ls", 0)],
		],
		[
			"a test run of some files, then one of fewer",
			[bash("bunx vitest run src/a.test.ts src/b.test.ts", 1), bash("bunx vitest run src/a.test.ts", 0)],
		],
		[
			"a test run, then the same run narrowed by name",
			[bash("bunx vitest run src/a.test.ts", 1), bash("bunx vitest run src/a.test.ts -t login", 0)],
		],
		["the whole suite, then one folder of it", [bash("bunx vitest run", 1), bash("bunx vitest run src/chat", 0)]],
		[
			"a test run beside a push, then the test run alone",
			[bash("bunx vitest run src/a.test.ts && git push origin main", 1), bash("bunx vitest run src/a.test.ts", 0)],
		],
		[
			"a test failure, then a passing type check",
			[bash("bunx vitest run src/a.test.ts", 1), bash("bunx tsc --noEmit", 0)],
		],
		[
			"one migration on stdin, then another",
			[bash('psql "$DB" < migrations/001.sql', 1), bash('psql "$DB" < migrations/002.sql', 0)],
		],
		[
			"a pipeline, then one with another last stage",
			[bash("cat m.sql | psql prod", 1), bash("cat m.sql | wc -l", 0)],
		],
		["one quoted path removed, then another", [bash('rm "build out/a.txt"', 1), bash('rm "tmp dir/b.txt"', 0)]],
		[
			"one environment, then another",
			[
				bash("AWS_PROFILE=prod aws s3 sync dist s3://site", 1),
				bash("AWS_PROFILE=dev aws s3 sync dist s3://site", 0),
			],
		],
		[
			"one script path, then another",
			[bash("packages/a/scripts/release.sh", 1), bash("packages/b/scripts/release.sh", 0)],
		],
		[
			"one inline command, then another",
			[bash('bash -lc "git push origin main"', 1), bash('bash -lc "git status"', 0)],
		],
		[
			"a commit with an escaped quote, then another commit",
			[bash('git commit -m "say \\"hi\\"" && git push origin main', 1), bash('git commit -m "another"', 0)],
		],
		["a rejected edit of a.ts, then a good edit of b.ts", [editOf("a.ts", true), editOf("b.ts", false)]],
		[
			"one site deployed, then another",
			[
				write("xd://mcp__higgsfield_deploy_website", '{"website_id":"A"}', true),
				write("xd://mcp__higgsfield_deploy_website", '{"website_id":"B"}', false),
			],
		],
		[
			"an edit with no path",
			[
				{ toolName: "edit", args: {}, outcome: "failed" },
				{ toolName: "edit", args: {}, outcome: "passed" },
			],
		],
		[
			"an eval with the same intent and other code",
			[
				{ toolName: "eval", args: { language: "py", code: "1/0", i: "Checking" }, outcome: "failed" },
				{ toolName: "eval", args: { language: "py", code: "1", i: "Checking" }, outcome: "passed" },
			],
		],
		[
			"the main agent's failure, then a subagent's same call",
			[bash("bun test", 1), { ...bash("bun test", 0), agentName: "Worker" }],
		],
		[
			"one subagent's failure, then another subagent's same call",
			[
				{ ...bash("bun test", 1), agentName: "A" },
				{ ...bash("bun test", 0), agentName: "B" },
			],
		],
		[
			"a failure, then the same call started before it ended",
			[
				{ ...bash("bun test", 1), startTime: 0, endTime: 5_000 },
				{ ...bash("bun test", 0), startTime: 1_000, endTime: 2_000 },
			],
		],
		[
			"a failure the transcript reports on its own (a backgrounded job), then the same call",
			[{ ...bash("bun test", 1), reported: true }, bash("bun test", 0)],
		],
		["a check in one folder by `cd`, then in another", [bash("cd a && bun test", 1), bash("bun test", 0, "b")]],
		[
			"a multi-file edit, then only one of its files redone",
			[
				{ toolName: "edit", args: { edits: [{ path: "a.ts" }, { path: "b.ts" }] }, outcome: "failed" },
				editOf("a.ts", false),
			],
		],
		["a failure after the success", [bash("bun run build", 0), bash("bun run build", 1)]],
	])("stays unresolved: %s", (_, calls) => {
		expect(unresolvedFailures(calls, "/repo")).toEqual(calls.filter(call => call.outcome === "failed"));
	});

	it.each([
		"command -v magick",
		"command -v magick >/dev/null 2>&1",
		"which gh",
		"type jq",
		"test -f dist/app.js",
		"[ -d out ]",
		"grep -q TODO src/a.ts",
		"rg needle src",
		'ps aux | grep -c "[v]ite"',
		"git status --porcelain | grep -q src/a.ts",
		'sleep 8; cat /tmp/vite.log | tail -10; ps aux | grep -c "[v]ite"',
		'bun run check:types; grep -rln "Check failed\\|checkFailed" e2e',
	])("never counts a whole probe's exit 1 as a failure: %s", command => {
		expect(settleFailures([bash(command, 1)])).toEqual({ unresolved: [], recovered: [] });
	});

	// 27 Oct 2026: a subagent started a dev server and asked it with curl before it listened; exit 7 turned the card red.
	it.each([
		'curl -s -o /dev/null -w "%{http_code}" http://localhost:5242/',
		"(bunx vite --port 5242 > /tmp/v.log 2>&1 &) ; sleep 6; curl -sf http://127.0.0.1:5242/health",
	])("never counts a server on this computer not listening yet as a failure: %s", command => {
		expect(settleFailures([bash(command, 7)])).toEqual({ unresolved: [], recovered: [] });
	});

	it.each<[string, number]>([
		["curl -sf https://api.example.com/health", 7],
		["curl -sf http://localhost:5242/health", 22],
		["curl -s http://localhost:5242/ && bun run deploy", 7],
		["find . -name '*.tmp' -delete | grep -q x", 1],
		["bun run release | grep -q published", 1],
	])("keeps a curl elsewhere, a server's error answer and an acting pipeline failures: %s", (command, exit) => {
		expect(unresolvedFailures([bash(command, exit)])).toHaveLength(1);
	});

	it.each([
		"git push origin main && grep -q needle file",
		"test -d . && false",
		"test -d . & false",
		"grep -q x file & wait",
		"test -f $(false)",
		"[ -d out ] || (exit 1)",
		"cd shots && (command -v magick || command -v montage) && magick a.png b.png c.png",
		"command -v gh >/dev/null && gh pr merge 3 --squash >/dev/null 2>&1",
		'bun run release 2>&1 | rg -q "published"',
		"ls src; grep -n needle src/a.ts | head",
	])("keeps an exit 1 of a command that does more than ask a failure: %s", command => {
		expect(unresolvedFailures([bash(command, 1)])).toHaveLength(1);
	});

	it("keeps a probe's other exit codes failures", () => {
		expect(unresolvedFailures([bash("grep -q x missing.txt", 2)])).toHaveLength(1);
	});

	// 27 Oct 2026: a subagent's lookups ended in `ls node_modules/@oh-my-pi` (no such folder in that checkout), GNU ls
	// answered 2, and the card closed red with "ls failed" when the person's next instruction sealed it.
	const listing = (command: string, exitCode: number, text: string): OperationCall => ({
		...bash(command, exitCode),
		text,
	});
	const gnuMissing = "ls: cannot access 'node_modules/@oh-my-pi': No such file or directory\n";
	it.each([
		["ls node_modules/@oh-my-pi", 2, gnuMissing],
		["ls node_modules/@oh-my-pi", 1, "ls: node_modules/@oh-my-pi: No such file or directory\n"],
		["ls -la dist src", 2, "ls: cannot access 'dist': No such file or directory\nsrc:\na.ts\n"],
		['grep -n "x" a.ts | head -50; cd ../..; ls node_modules/@oh-my-pi', 2, `12: x\n${gnuMissing}`],
	])("never counts a listing of a missing path as a failure: %s (exit %i)", (command, exit, text) => {
		expect(settleFailures([listing(command, exit, text)])).toEqual({ unresolved: [], recovered: [] });
	});

	it.each([
		["a path it may not read", "ls /root", 2, "ls: cannot open directory '/root': Permission denied\n"],
		["an unknown option", "ls -z", 2, "ls: invalid option -- 'z'\nTry 'ls --help' for more information.\n"],
		[
			"one missing path beside one it may not read",
			"ls gone /root",
			2,
			"ls: cannot access 'gone': No such file or directory\nls: cannot open directory '/root': Permission denied\n",
		],
		["a redirection that failed", "ls dist > /unwritable/report", 1, "bash: /unwritable/report: Permission denied\n"],
		["a redirection beside a missing path", "ls gone 2> /tmp/ls.err", 2, gnuMissing],
		["no output to tell why", "ls dist", 2, ""],
		["an exit past 2", "ls dist", 3, gnuMissing],
		["one piped on", "ls dist | xargs rm", 2, gnuMissing],
	])("keeps a listing that failed for another reason a failure: %s", (_, command, exit, text) => {
		expect(unresolvedFailures([listing(command, exit, text)])).toHaveLength(1);
	});

	it("skips inert calls and calls without an outcome", () => {
		const read: OperationCall = { toolName: "read", args: { path: "a.ts" }, outcome: "failed", inert: true };
		const cut: OperationCall = { toolName: "bash", args: { command: "bun run build" } };
		expect(settleFailures([read, cut])).toEqual({ unresolved: [], recovered: [] });
	});
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
		summarizeChecks(workOutcomes([{ entry: backgrounded, toolCallId: "c1" }], undefined, "", verdicts).commands);

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
		const [check] = summary(new Map([["c1", { failed: true, text }]]));
		expect(check).toMatchObject({ kind: "test", passed: false, exitCode: 1 });
		expect(check.cause).toBe("(fail) renders the card [1.20ms]");
	});
	it("reads a delivered passing job as passed with its test count", () => {
		const text = "bun test v1.2.0\n\n 31 pass\n 0 fail\n 52 expect() calls\nRan 31 tests across 4 files. [310.00ms]";
		expect(summary(new Map([["c1", { failed: false, text }]]))).toEqual([
			{ kind: "test", passed: true, runs: 1, exitCode: 0, tests: { passed: 31 }, toolCallId: "c1" },
		]);
	});
	it("reads the outcome the agent waited for, which stock does not deliver again", () => {
		const waited = [
			...opening("c1", "bg_1", command, 1),
			waitResult("bg_1", "failed", "(fail) math > adds [0.40ms]\n 0 pass\n 1 fail\nRan 1 test across 1 file.", 3),
		];
		const [check] = summary(backgroundJobVerdicts(waited));
		expect(check).toMatchObject({ kind: "test", passed: false, exitCode: 1, cause: "(fail) math > adds [0.40ms]" });
	});

	// Stock numbers jobs per omp process, so `bg_N` comes back after every restart and a result names only that id.
	// 27 Oct 2026: this session held 14 `bg_1` and 13 `bg_2`; every command that ever opened `bg_2` read the newest
	// result of `bg_2` ("release not found"), 12 passing ones as failed and 7 killed by a restart as passed.
	describe("when a job id comes back", () => {
		it("ties each result to the call that opened the id last before it", () => {
			const messages = [
				...opening("c1", "bg_2", "bun test src/a", 1),
				delivered("bg_2", "completed", " 4 pass\n 0 fail\nRan 4 tests across 1 file.", 3),
				...opening("c2", "bg_2", "bun test src/b", 4),
				delivered("bg_2", "failed", "(fail) b > x\n 1 fail\nCommand exited with code 1", 6),
			];
			const [first, second] = commandsOf(messages);
			expect(first).toMatchObject({ failed: false, exitCode: 0, text: expect.stringContaining("4 pass") });
			expect(second).toMatchObject({ failed: true, exitCode: 1, text: expect.stringContaining("(fail) b > x") });
			expect(summarizeChecks(commandsOf(messages))).toMatchObject([{ kind: "test", passed: false, runs: 2 }]);
			expect(summarizeChecks([first])).toMatchObject([{ kind: "test", passed: true }]);
		});

		it("ties a waited result the same way", () => {
			const messages = [
				...opening("c1", "bg_2", "bun test src/a", 1),
				waitResult("bg_2", "failed", "(fail) a > x\n 1 fail", 3),
				...opening("c2", "bg_2", "bun test src/b", 4),
				delivered("bg_2", "completed", " 2 pass\n 0 fail", 6),
			];
			const [first, second] = commandsOf(messages);
			expect(first).toMatchObject({ failed: true });
			expect(second).toMatchObject({ failed: false, exitCode: 0 });
		});

		it("reads a job a restart killed as cut off, never as the passing result of the job that reused its id", () => {
			const restarted: AgentMessage = {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Previous OMP process exited before completing the turn.",
				timestamp: 3,
			};
			const messages = [
				...opening("c1", "bg_1", "bun test src/a", 1),
				restarted,
				...opening("c2", "bg_1", "bun test src/b", 4),
				delivered("bg_1", "completed", " 3 pass\n 0 fail", 6),
			];
			const [killed, ran] = commandsOf(messages);
			expect(killed).toMatchObject({ interrupted: true, failed: false });
			expect(killed?.unknown).toBeUndefined();
			expect(summarizeChecks(killed ? [killed] : [])).toEqual([]);
			expect(ran).toMatchObject({ failed: false, exitCode: 0 });
		});

		it("reads a job whose id was opened again before it reported as cut off, with no restart notice between", () => {
			const messages = [
				...opening("c1", "bg_1", "bun test src/a", 1),
				...opening("c2", "bg_1", "bun test src/b", 4),
				delivered("bg_1", "completed", " 3 pass\n 0 fail", 6),
			];
			const [killed, ran] = commandsOf(messages);
			expect(killed).toMatchObject({ interrupted: true });
			expect(ran).toMatchObject({ exitCode: 0 });
		});

		it("leaves a job that has not reported unknown, whatever the other id holders said", () => {
			const messages = [
				...opening("c1", "bg_1", "bun test src/a", 1),
				delivered("bg_1", "completed", " 3 pass\n 0 fail", 3),
				...opening("c2", "bg_3", "bun test src/b", 4),
			];
			const [, running] = commandsOf(messages);
			expect(running).toMatchObject({ unknown: true });
		});

		// A subagent's calls reach the card as tool entries only: its `wait` entries carry what it waited for.
		it("reads a subagent's own wait entries, not another agent's job of the same id", () => {
			const asyncBash = (at: number): ToolEntry => ({ ...backgrounded, startTime: at, endTime: at + 1 });
			const waited = (status: string, errorText: string, at: number): ToolEntry => ({
				toolName: "wait",
				args: {},
				status: "done",
				streamingArgs: "",
				result: {
					content: [{ type: "text", text: `bg_1 ${status}` }],
					details: { op: "wait", jobs: [{ id: "bg_1", type: "bash", status, exitCode: 1, errorText }] },
				},
				isError: false,
				startTime: at,
				endTime: at + 1,
			});
			const failedRun = asyncBash(10);
			const passedRun = asyncBash(10);
			const { commands } = workOutcomes([
				{ entry: failedRun, agentName: "A" },
				{ entry: waited("failed", "(fail) a > x\n 1 fail", 20), agentName: "A" },
				{ entry: passedRun, agentName: "B" },
				{ entry: waited("completed", " 2 pass\n 0 fail", 25), agentName: "B" },
			]);
			expect(
				commands.map(entryCommand => [entryCommand.agentName, entryCommand.failed, entryCommand.unknown]),
			).toEqual([
				["A", true, undefined],
				["B", false, undefined],
			]);
		});
	});
});

// Stock's bash/task results that open a job, and what carries its outcome back (async-result, a `wait` result).
function opening(callId: string, jobId: string, command: string, at: number): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }],
			stopReason: "toolUse",
			timestamp: at,
		},
		{
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: `Backgrounded as job ${jobId}` }],
			details: { async: { state: "running", jobId, type: "bash" } },
			timestamp: at + 1,
		},
	];
}
function delivered(jobId: string, status: string, text: string, at: number): AgentMessage {
	return {
		role: "custom",
		customType: "async-result",
		content: `<system-notice>\nBackground job ${jobId} has ${status}.\n${text}\n</system-notice>`,
		display: true,
		details: { jobs: [{ jobId, type: "bash", status }] },
		timestamp: at,
	};
}
function waitResult(jobId: string, status: string, text: string, at: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `w${at}`,
		toolName: "wait",
		content: [{ type: "text", text: `${jobId} ${status}` }],
		details: {
			op: "wait",
			jobs: [
				{
					id: jobId,
					type: "bash",
					status,
					exitCode: status === "failed" ? 1 : 0,
					...(status === "failed" ? { errorText: text } : { resultText: text }),
				},
			],
		},
		isError: false,
		timestamp: at,
	} as unknown as AgentMessage;
}
/** The commands a card made of every call in `messages` shows, its results read as a finished card does. */
function commandsOf(messages: readonly AgentMessage[]) {
	const ids = messages.flatMap(message =>
		message.role === "assistant" && Array.isArray(message.content)
			? message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))
			: [],
	);
	const entries = transcriptToolEntries(messages, 0);
	return workOutcomes(
		entries.map((entry, index) => ({ entry, toolCallId: ids[index] })),
		undefined,
		"",
		backgroundJobVerdicts(messages),
	).commands;
}

// 26 Oct 2026: stock's bash refused a named (service) build asked with `async` and `timeout` before running anything. A
// call stock throws on answers with an error and no exit report; a command that ran reports its exit in the details.
describe("a call the bash tool refused", () => {
	const refused: ToolEntry = {
		toolName: "bash",
		args: { command: "pnpm build 2>&1 | tail -40", name: "build-3d", async: true, timeout: 900 },
		status: "error",
		streamingArgs: "",
		result: {
			content: [
				{ type: "text", text: "Service mode does not accept async or timeout; use ready.timeout for readiness." },
			],
			details: {},
		},
		isError: true,
		startTime: 1_000,
		endTime: 1_000,
	};
	const commands = (entry: ToolEntry) => workOutcomes([{ entry }]).commands;
	const ran = (details: Record<string, unknown>, text: string): ToolEntry => ({
		...refused,
		result: { content: [{ type: "text", text }], details },
	});

	it("is no check and no failure: the command never ran", () => {
		expect(summarizeChecks(commands(refused))).toEqual([]);
		expect(unresolvedFailures(commands(refused).map(commandOperation))).toEqual([]);
	});

	it("keeps a build that ran and exited non-zero, or ran out of time, failed", () => {
		const exited = ran({ exitCode: 1, wallTimeMs: 6_000 }, "Type error\n\nCommand exited with code 1");
		const timedOut = ran({ timedOut: true, wallTimeMs: 900_000 }, "Creating an optimized build…");
		expect(summarizeChecks(commands(exited))).toMatchObject([{ kind: "build", passed: false }]);
		expect(summarizeChecks(commands(timedOut))).toMatchObject([{ kind: "build", passed: false }]);
		expect(unresolvedFailures(commands(exited).map(commandOperation))).toHaveLength(1);
	});

	// Stock also throws for a command that ran and reported no exit (tools/bash.ts `#throwIfUnfinished`, `execute`'s
	// cancelled branch), so its details are empty too: only the notice it ends or starts with says the command ran.
	it.each([
		["lost its exit status", "Creating an optimized build…\n\nCommand failed: missing exit status"],
		[
			"lost its exit status and its full output",
			"Creating an optimized build…\n\nCommand failed: missing exit status\n\n[Full output was not saved completely (artifact 3 failed)]",
		],
		["was cancelled by its shell", "[Command cancelled]\nCreating an optimized build…"],
		["was aborted with no stop", "Creating an optimized build…\n\n[Command aborted]"],
		["was aborted before it printed", "Command aborted"],
	])("keeps a build that ran and %s failed", (_, text) => {
		const build = commands(ran({}, text));
		expect(summarizeChecks(build)).toMatchObject([{ kind: "build", passed: false }]);
		expect(unresolvedFailures(build.map(commandOperation))).toHaveLength(1);
	});
});

describe("a call the shared-checkout guard refused", () => {
	const write = (text: string, at: number, failed = true): [string, ToolEntry] => [
		`w${at}`,
		{
			toolName: "write",
			args: { path: "src/a.ts", content: "x" },
			status: failed ? "error" : "done",
			streamingArgs: "",
			result: { content: [{ type: "text", text }] },
			isError: failed,
			startTime: at,
			endTime: at + 10,
		},
	];
	const refusal = `${CHECKOUT_REFUSAL_PREFIX}: writing src/a.ts whole would drop the other session's uncommitted changes to it.`;

	it("is protection: no failed step, and nothing to resolve", () => {
		expect(stepOperations([write(refusal, 1)])).toEqual([]);
		expect(settleFailures(stepOperations([write(refusal, 1)]))).toEqual({ unresolved: [], recovered: [] });
	});

	it("leaves a real failed write failed, beside it or after it, and never fixes it", () => {
		const calls = stepOperations([write("EACCES: permission denied", 1), write(refusal, 20)]);
		expect(calls.map(call => [call.toolCallId, call.outcome])).toEqual([["w1", "failed"]]);
		expect(settleFailures(calls).unresolved.map(call => call.toolCallId)).toEqual(["w1"]);
	});

	it("does not hide a later success's fix of a real failure", () => {
		const calls = stepOperations([write("EACCES", 1), write(refusal, 20), write("Wrote src/a.ts", 40, false)]);
		expect(settleFailures(calls).recovered.map(call => call.toolCallId)).toEqual(["w1"]);
	});
});

describe("commandProgram", () => {
	it.each([
		["git push origin main", "git push"],
		["cd src && git push", "git push"],
		["cd src; export A=1; cargo build --release", "cargo build"],
		["FOO=1 BAR=2 bun test src", "bun test"],
		["env NODE_ENV=test bun run build", "bun run"],
		["sudo -n systemctl restart nginx", "systemctl restart"],
		["npx -y tsc --noEmit", "tsc"],
		["bunx vitest run", "vitest run"],
		["pnpm dlx prettier --check .", "prettier"],
		["/usr/bin/make all", "make all"],
		["ls | head", "ls"],
		["tsc", "tsc"],
		["cd /tmp/board && (command -v magick || command -v montage) && magick a.png b.png +append c.png", "magick"],
		["test -f dist/app.js && ./scripts/deploy.sh", "test"],
		["{ ! grep -q x a.txt; } && rm a.txt", "grep"],
		["grep -rn foo src && echo ok", "grep"],
		["which gh", "gh"],
		["command -v /usr/local/bin/magick", "magick"],
		["test -f dist/app.js", "test"],
	])("names %s by what it runs: %s", (command, expected) => {
		expect(commandProgram(command)).toBe(expected);
	});
	it("has no name for an empty command or one that is only setup", () => {
		expect(commandProgram("")).toBeUndefined();
		expect(commandProgram("cd src && export A=1")).toBeUndefined();
	});
});

describe("audit fixes", () => {
	const hashEdit = (header: string, outcome: "passed" | "failed"): OperationCall => ({
		toolName: "edit",
		args: { input: `${header}\nPUT 1:\n+x` },
		outcome,
	});
	it.each(["[a.gd#?]", "[a.gd#ANY]", "[a.gd#]", "[a.gd#PLACEHOLDER]", "[a.gd#*]", "[a.gd#__TAG__]", "[a.gd#2C FB]"])(
		"a rejected edit with the malformed tag %s is fixed by the good edit of the file",
		header => {
			const calls = [hashEdit(header, "failed"), hashEdit("[a.gd#A1B2]", "passed")];
			expect(settleFailures(calls, "/repo")).toEqual({ unresolved: [], recovered: [calls[0]] });
		},
	);

	it("fails a test run whose own output shows failures though a pipe hid the exit code", () => {
		const run = {
			command: "bunx vitest run | tail -5",
			failed: false,
			exitCode: 0,
			text: " Tests  1 failed | 20 passed (21)",
		};
		expect(summarizeChecks([run])[0]).toMatchObject({ kind: "test", passed: false });
		expect(commandOperation(run).outcome).toBe("failed");
	});
	it("fails a type check whose output has a TS error though a pipe hid the exit code", () => {
		const run = {
			command: "bunx tsc --noEmit | head -20",
			failed: false,
			exitCode: 0,
			text: "src/a.ts(3,1): error TS2551: Property 'x' does not exist.",
		};
		expect(summarizeChecks([run])[0]).toMatchObject({ kind: "typecheck", passed: false });
	});
	it("keeps a clean piped test run passed", () =>
		expect(
			summarizeChecks([
				{ command: "bunx vitest run | tail", failed: false, exitCode: 0, text: "Tests  20 passed (20)" },
			])[0]?.passed,
		).toBe(true));

	it.each([
		["git log --oneline -5; gh run list", "gh run"],
		["gh run list; ls", "ls"],
		["timeout 60 bun test", "bun test"],
		["timeout -k 5 30 gh run watch", "gh run"],
		["time bun run build", "bun run"],
		["cd app; export A=1", undefined],
		["for f in *.ts; do echo $f; done", undefined],
		["while true; do sleep 1; done", undefined],
		["if [ -f a ]; then ls; fi", undefined],
		["*.sh", undefined],
		["A=1", undefined],
	])("names the last unconditional command: %s", (command, expected) => {
		expect(commandProgram(command)).toBe(expected);
	});

	it.each([
		"git status; grep -q foo a.txt",
		"echo start\ngrep -rn needle src",
		"cd app; test -f dist/app.js",
		"ls; [ -d build ]",
	])("a lookup closing a list exiting 1 is no failure: %s", command => {
		expect(settleFailures([bash(command, 1)], "/repo")).toEqual({ unresolved: [], recovered: [] });
	});
	it.each([
		"grep -q x a.txt; echo done && false",
		"grep x a | wc -l; bun run build | grep -q zz",
		"ls; grep a b || exit 1",
	])("a list whose last segment is more than a lookup stays a failure: %s", command => {
		const call = bash(command, 1);
		expect(settleFailures([call], "/repo").unresolved).toEqual([call]);
	});
});

// The red-card audit of 27 Oct 2026: 153 real cards replayed, 33 of 58 red ones false. Each case below is the shape of a
// real command and its output from those journals; `op` builds the call the card settles from its command's result.
const op = (command: string, exitCode: number, text = ""): OperationCall & { command: string; text: string } => ({
	...commandOperation({ command, failed: exitCode !== 0, exitCode, text }),
	text,
});

describe("a failed check fixed by a run that mixes check kinds", () => {
	const failing = op("bunx vitest run src/a.test.ts", 1, " FAIL src/a.test.ts > x\n Tests  1 failed | 4 passed (5)");

	it("is fixed by the passing run of a list that also lints and type checks", () => {
		const mixed = op(
			'bunx biome check src; bun run check:types 2>&1 | grep -E "a.ts"; bunx vitest run src/a.test.ts src/b.test.ts 2>&1 | grep -E "Tests "',
			0,
			" Tests  80 passed (80)",
		);
		expect(settleFailures([failing, mixed], "/repo")).toEqual({ unresolved: [], recovered: [failing] });
	});

	it("is fixed by a chain of kinds whose exit is the checks' own", () => {
		const chain = op("bunx biome check src && bunx vitest run src/a.test.ts", 0, " Tests  5 passed (5)");
		expect(settleFailures([failing, chain], "/repo")).toEqual({ unresolved: [], recovered: [failing] });
	});

	it("is not fixed by a mixed run that has no step of the failed kind", () => {
		const other = op("bunx biome check src; bun run check:types 2>&1 | tail -3", 0, "$ tsc --noEmit");
		expect(unresolvedFailures([failing, other], "/repo")).toEqual([failing]);
	});

	it("is not fixed by a mixed run whose output shows the failed kind's failure", () => {
		const mixed = op(
			"bunx biome check src; bunx vitest run src/a.test.ts | tail -5",
			0,
			" Tests  1 failed | 4 passed (5)",
		);
		expect(unresolvedFailures([failing, mixed], "/repo")).toEqual([failing]);
	});
});

describe("a failing test written first, then the check", () => {
	const heredoc =
		'cd /repo && cat >> src/a.test.ts <<\'EOF\'\n\ndescribe("a", () => {\n\tit("keeps the agent\'s note (kept)", () => {\n\t\texpect(1).toBe(2);\n\t});\n});\nEOF\nbunx vitest run src/a.test.ts 2>&1 | grep -E "FAIL|Tests "';
	const red = op(heredoc, 0, " FAIL src/a.test.ts > a\n Tests  1 failed | 4 passed (5)");

	it("is judged by its check on the failure side: a later clean run of that check fixes it", () => {
		const green = op("bunx vitest run src/a.test.ts", 0, " Tests  5 passed (5)");
		expect(red.outcome).toBe("failed");
		expect(settleFailures([red, green], "/repo")).toEqual({ unresolved: [], recovered: [red] });
	});

	it("is judged by its check on the fix side: a setup step before a clean run of the check", () => {
		const failed = op("bunx vitest run src/a.test.ts", 1, " Tests  1 failed | 4 passed (5)");
		for (const command of [
			"sed -i '' 's/toBe(2)/toBe(1)/' src/a.test.ts && bunx vitest run src/a.test.ts 2>&1 | tail -5",
			"git show HEAD:src/a.ts > src/a.ts && bunx vitest run src/a.test.ts",
		]) {
			const green = op(command, 0, " Tests  5 passed (5)");
			expect(settleFailures([failed, green], "/repo")).toEqual({ unresolved: [], recovered: [failed] });
		}
	});

	it("does not let a setup step vouch for a check whose output shows no pass", () => {
		const failed = op("bunx vitest run src/a.test.ts", 1, " Tests  1 failed | 4 passed (5)");
		for (const text of ["", " Tests  1 failed | 4 passed (5)"]) {
			const run = op("sed -i '' 's/a/b/' src/a.ts && bunx vitest run src/a.test.ts | tail -5", 0, text);
			expect(unresolvedFailures([failed, run], "/repo")).toContain(failed);
		}
	});

	it("does not read a command ending in something else than a check as that check", () => {
		const closing = op(
			"bunx vitest run src/a.test.ts 2>&1 | tail -3; git push origin main",
			0,
			" Tests  5 passed (5)",
		);
		expect(
			unresolvedFailures([op("bunx vitest run src/a.test.ts", 1, " Tests  1 failed (5)"), closing], "/repo"),
		).toHaveLength(1);
	});
});

describe("a type check cut by a filter", () => {
	const broken = op(
		"bun run check:types",
		2,
		"src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\nerror: script \"check:types\" exited with code 2",
	);

	it.each([
		'bun run check:types 2>&1 | grep "src/b.ts"',
		'bun run check:types 2>&1 | grep -v "src/a.ts"',
		"bun run check:types 2>&1 | rg src/b.ts",
		"bun run check:types 2>&1 | head -20",
		"bun run check:types 2>&1 | tail -3",
		"bun run check:types 2>&1 | sed -n 1,5p",
		"bun run check:types 2>&1 | awk '/src\\/b/'",
	])("proves no pass, so it fixes nothing and is no passed check: %s", command => {
		const filtered = op(command, 0, "(no output)");
		expect(settleFailures([broken, filtered], "/repo")).toEqual({ unresolved: [broken], recovered: [] });
		expect(summarizeChecks([{ command, failed: false, exitCode: 0, text: "(no output)" }])).toEqual([]);
	});

	it("keeps the failure standing in the summary", () => {
		const checks = summarizeChecks([
			{ command: "bun run check:types", failed: true, exitCode: 2, text: broken.text },
			{ command: 'bun run check:types 2>&1 | grep "src/b.ts"', failed: false, exitCode: 0, text: "(no output)" },
		]);
		expect(checks).toMatchObject([{ kind: "typecheck", passed: false }]);
	});

	it.each([
		['error: script "check:types" exited with code 2'],
		["src/a.ts(1,1): error TS2322: x\nFound 2 errors in 1 file."],
		["Found 1 error in src/a.ts:1"],
	])("reads stock's own failure notice as a failure though the pipe hid the exit code: %s", text => {
		const run = { command: "bun run check:types 2>&1 | tail -1", failed: false, exitCode: 0, text };
		expect(commandOperation(run).outcome).toBe("failed");
		expect(summarizeChecks([run])).toMatchObject([{ kind: "typecheck", passed: false }]);
	});

	it("still lets the plain type check fix it", () => {
		expect(settleFailures([broken, op("bun run check:types", 0, "$ tsc --noEmit")], "/repo").recovered).toEqual([
			broken,
		]);
	});
});

describe("lookups are no failure", () => {
	const lookup = (command: string, exitCode: number, text = "") =>
		settleFailures([op(command, exitCode, text)], "/repo");
	const none = { unresolved: [], recovered: [] };

	it("reads quotes as text: a `(` or `;` inside a quoted pattern splits nothing", () => {
		expect(
			lookup(
				'grep -n "async function run(user" -A3 e2e/fixture/checkout-peers.ts; grep -n "const cwd = process.cwd();" e2e/fixture/checkout-peers.ts; grep -n "fs.appendFileSync(\\"/tmp/fixture-debug.log\\"" e2e/fixture/checkout-peers.ts',
				1,
				"(no output)",
			),
		).toEqual(none);
		expect(commandProgram('echo "(" ; git push origin main')).toBe("git push");
		expect(commandProgram('git commit -m "fix; run bun test" && git push')).toBe("git commit");
	});

	it.each([
		['git show origin/r3/one-step-list:src/components.css | grep -n ":empty\\|:has(" | grep -i "process\\|body"'],
		['grep -n "interface IpcTabInfo" -A25 src/shared/ipc-types.ts | grep -n "title\\|task"'],
		["sed -n 1,40p src/a.ts | grep -n needle"],
		["rg -n needle src | rg -v test"],
		["awk '/needle/ {print FILENAME}' src/a.ts | grep -q needle"],
		["git worktree list | grep -q omgdesk-r3"],
		["git ls-tree -r HEAD --name-only | grep -q src/a.ts"],
		["cd /repo && grep -rn needle src | head -2; sed -n 1,40p src/a.ts | grep -n needle"],
	])("never counts a read piped into a grep that found nothing: %s", command => {
		expect(lookup(command, 1, "(no output)")).toEqual(none);
	});

	it.each([
		"sed -i '' 's/a/b/' src/a.ts | grep -q b",
		"git push origin main | grep -q done",
		"awk '{print}' a.txt > b.txt | grep -q x",
	])("keeps a pipeline whose first stage acts a failure: %s", command => {
		expect(unresolvedFailures([op(command, 1)], "/repo")).toHaveLength(1);
	});

	it("reads an `ls` whose stderr joined its output as it reads the plain one", () => {
		const missing = "ls: cannot access '/Users/me/.omp/browser-relay': No such file or directory\n";
		expect(lookup("ls /Users/me/.omp/browser-relay 2>&1", 2, missing)).toEqual(none);
		expect(lookup("ls /Users/me/.omp/browser-relay 2>&1 | head -3", 2, missing)).not.toEqual(none);
		expect(
			unresolvedFailures([op("ls /root 2>&1", 2, "ls: cannot open directory '/root': Permission denied\n")]),
		).toHaveLength(1);
		expect(unresolvedFailures([op("ls gone 2> /tmp/ls.err", 2, missing)])).toHaveLength(1);
	});
});

describe("a failed chain retried with its steps from the failing one on", () => {
	const failedAdd = op(
		"cd /repo && git add src .omp/rules && git commit -qm 'feat: x' && git push -q origin main",
		1,
		'hint: Use -f if you really want to add them.\nhint: Disable this message with "git config set advice.addIgnoredFile false"',
	);

	it("is fixed by a later passing chain that redoes the failing step and runs the same steps after it", () => {
		const redo = op("cd /repo && git add src && git commit -qm 'feat: x' && git push -q origin main", 0);
		expect(settleFailures([failedAdd, redo], "/repo")).toEqual({ unresolved: [], recovered: [failedAdd] });
	});

	it.each([
		["a chain that stops short of the steps after", "git add src && git status"],
		["the last step alone", "git push -q origin main"],
		["a chain whose steps after the redone one differ", "git rm src && git commit -qm 'feat: y' && git status"],
		[
			"a chain that goes on past the last step",
			"git add src && git commit -qm 'feat: x' && git push -q origin main && git status",
		],
	])("is not fixed by %s", (_, command) => {
		expect(unresolvedFailures([failedAdd, op(`cd /repo && ${command}`, 0)], "/repo")).toEqual([failedAdd]);
	});

	it("is not fixed by a retry in another folder or by a later failure", () => {
		const elsewhere = op("git add src && git commit -qm 'feat: x' && git push -q origin main", 0);
		expect(
			unresolvedFailures([failedAdd, { ...elsewhere, args: { ...elsewhere.args, cwd: "/other" } }], "/repo"),
		).toEqual([failedAdd]);
		expect(
			unresolvedFailures(
				[failedAdd, op("cd /repo && git add src && git commit -qm 'feat: x' && git push -q origin main", 1)],
				"/repo",
			),
		).toHaveLength(2);
	});
});

describe("wrappers and gates that are checks", () => {
	it.each([
		["timeout 100 bunx vitest run src/a.test.ts", "test"],
		["timeout -k 5 100 bun run check:types", "typecheck"],
		["timeout 2m bun run build", "build"],
		["cd /repo && OMP_VITEST_WORKERS=3 timeout 300 bunx vitest run src", "test"],
		["bun run check:changed", "test"],
		["bun run check:changed 2>&1 | tail -20", "test"],
		["timeout 60 sleep 5", undefined],
	])("reads %s as %s", (command, kind) => expect(checkKind(command)).toBe(kind));

	it("reads the failed count a timeout-wrapped run printed (BoardR2: 2 failed | 844 passed)", () => {
		const run = {
			command: "timeout 100 bunx vitest run 2>&1 | tail -5",
			failed: false,
			exitCode: 0,
			text: " Tests  2 failed | 844 passed (846)",
		};
		expect(summarizeChecks([run])).toMatchObject([
			{ kind: "test", passed: false, tests: { passed: 844, failed: 2 } },
		]);
	});

	it("reads the gate's own counts through a pipe (`1 failed`, `FAILED: playwright`)", () => {
		const run = {
			command: "bun run check:changed 2>&1 | tail -20",
			failed: false,
			exitCode: 0,
			text: "FAILED: playwright\n 1 failed | 12 passed",
		};
		expect(summarizeChecks([run])).toMatchObject([{ kind: "test", passed: false, tests: { passed: 12, failed: 1 } }]);
	});
});

describe("a failed script's notice names the check it fails", () => {
	it("reads the gate's own failure line through a grep that kept nothing else", () => {
		const run = {
			command: 'bun run check:changed 2>&1 | grep -E "FAILED"',
			failed: false,
			exitCode: 0,
			text: "[check:changed] FAILED: vitest",
		};
		expect(summarizeChecks([run])).toMatchObject([{ kind: "test", passed: false }]);
	});

	it('reads `error: script "check:changed" exited with code 1` as the gate failing', () => {
		const run = {
			command: "bun run check:changed 2>&1 | tail -25",
			failed: false,
			exitCode: 0,
			text: 'The first screen loads 3,340,445 bytes (budget 3,340,400).\nerror: script "build" exited with code 1\nerror: script "check:changed" exited with code 1',
		};
		expect(commandOperation(run).outcome).toBe("failed");
	});

	it("never reads another script's failure as the lint's: only a script that runs the kind's check counts", () => {
		const lint = {
			command:
				"bunx biome check --write e2e/a.e2e.ts | tail -3; bun run locked -- bunx playwright test e2e/a.e2e.ts | tail -30",
			failed: false,
			exitCode: 0,
			text: 'Checked 1 file in 3ms.\n1 failed\nerror: script "locked" exited with code 1',
		};
		expect(summarizeChecks([lint])).toMatchObject([{ kind: "lint", passed: true }]);
		expect(
			summarizeChecks([
				{
					command: "bunx biome check src | tail -3",
					failed: false,
					exitCode: 0,
					text: 'error: script "locked" exited with code 1',
				},
			]),
		).toMatchObject([{ kind: "lint", passed: true }]);
	});
});

// Stock runs a leading `cd <dir> &&` as the call's folder, so a lookup after it is still a whole lookup.
describe("a lookup after a leading cd", () => {
	it.each([
		'cd /repo && grep -n "interface IpcTabInfo" -A25 src/shared/ipc-types.ts | grep -n "title\\|task"',
		"cd /repo && grep -n needle src/a.ts",
		"cd /repo && git status --short | grep -q src/a.ts",
		"cd /repo && grep -rn needle src | head -2; sed -n 1,40p src/a.ts | grep -n needle",
	])("exiting 1 is no failure: %s", command => {
		expect(settleFailures([op(command, 1, "(no output)")], "/repo")).toEqual({ unresolved: [], recovered: [] });
	});

	it.each([
		"cd /repo && git push origin main && grep -q needle src/a.ts",
		"cd /repo && bun run build | grep -q built",
	])("keeps a lookup that follows a real step a failure: %s", command => {
		expect(unresolvedFailures([op(command, 1)], "/repo")).toHaveLength(1);
	});
});

describe("the repo's gate through a filter", () => {
	it("is fixed by a later run of the gate whose own PASSED line shows it passed", () => {
		const failed = op(
			"bun run check:changed 2>&1 | tail -25",
			1,
			"[check:changed] ✗ biome (exit 1)\n[check:changed] FAILED: biome",
		);
		const passed = op(
			"bun run check:changed 2>&1 | grep -vE '^$'",
			0,
			"[check:changed] ✓ biome 0.1s\n[check:changed] PASSED in 45.6s",
		);
		expect(settleFailures([failed, passed], "/repo")).toEqual({ unresolved: [], recovered: [failed] });
	});

	it("is not fixed by a filtered run that printed nothing of the gate's verdict", () => {
		const failed = op("bun run check:changed 2>&1 | tail -25", 1, "[check:changed] FAILED: biome");
		const silent = op("bun run check:changed 2>&1 | grep -vE '^$'", 0, "(no output)");
		expect(unresolvedFailures([failed, silent], "/repo")).toEqual([failed]);
	});
});
