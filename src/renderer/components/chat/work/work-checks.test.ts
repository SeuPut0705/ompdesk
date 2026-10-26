import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import type { ToolEntry } from "../../../stores/tools";
import { type BackgroundJobVerdict, backgroundJobVerdicts } from "../completion-events";
import {
	checkKind,
	commandOperation,
	commandProgram,
	firstErrorLine,
	type OperationCall,
	settleFailures,
	summarizeChecks,
	testCounts,
	unresolvedFailures,
} from "./work-checks";
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
	it("keeps a check that failed in one package failed when only another package's run passed after it", () => {
		const checks = summarizeChecks([
			{ command: "bunx vitest run", cwd: "packages/a", failed: true, exitCode: 1, text: " FAIL a.test.ts" },
			{ command: "bunx vitest run", cwd: "packages/b", failed: false, exitCode: 0, text: " Tests  4 passed (4)" },
		]);
		expect(checks.map(check => [check.kind, check.passed, check.cause])).toEqual([["test", false, "FAIL a.test.ts"]]);
	});
	it("reads a check fixed by a compound command as the verdict does: still failed", () => {
		const checks = summarizeChecks([
			{ command: "node scripts/lint-surfaces.mjs", failed: true, exitCode: 1, text: "✖ raw button" },
			{ command: "node scripts/lint-surfaces.mjs && bunx biome check src", failed: false, exitCode: 0 },
		]);
		expect(checks.map(check => [check.kind, check.passed])).toEqual([["lint", false]]);
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
			"a check, then the same check piped into tail",
			[bash("bun run check:types", 2), bash("bun run check:types 2>&1 | tail -20", 0)],
		],
		[
			"a lint, then that lint and another after &&",
			[bash("node scripts/lint-surfaces.mjs", 1), bash("node scripts/lint-surfaces.mjs && bunx biome check src", 0)],
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
	])("never counts a whole probe's exit 1 as a failure: %s", command => {
		expect(settleFailures([bash(command, 1)])).toEqual({ unresolved: [], recovered: [] });
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
	it.each(["grep -q x a.txt; echo done && false", "grep x a | wc -l; ls | grep -q zz", "ls; grep a b || exit 1"])(
		"a list whose last segment is more than a lookup stays a failure: %s",
		command => {
			const call = bash(command, 1);
			expect(settleFailures([call], "/repo").unresolved).toEqual([call]);
		},
	);
});
