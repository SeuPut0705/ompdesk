/**
 * The work verdict's invariants over generated runs (seeded, so a failure names its seed and repeats): calls built as
 * stock answers them (`ToolEntry`s) go through the card's own ledger (`workOutcomes`, `stepOperations`) and verdict
 * (`workVerdict`), the board's check row (`lastCheck`) and Autopilot's ledger (`ledgerCall`, `judgeVerify`).
 */
import { describe, expect, it } from "vitest";
import { commandStatus } from "../../../../../resources/gui-bridge/command-verdict-core";
import { isCheckCommand, judgeVerify, ledgerCall } from "../../../../../resources/gui-bridge/modes/autopilot-verify";
import { CHECKOUT_REFUSAL_PREFIX } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { ToolEntry } from "../../../stores/tools";
import { lastCheck } from "../../layout/work-board/session-board";
import { workVerdict } from "./work-checks";
import { stepOperations } from "./work-findings";
import { workOutcomes } from "./work-view";

/** How stock answered a command. */
type Shape =
	| "passed"
	| "exit1"
	| "exit2"
	| "quietFail"
	| "refused"
	| "held"
	| "lostExit"
	| "cutNoStop"
	| "timedOut"
	| "background";

const SHAPES: readonly Shape[] = [
	"passed",
	"exit1",
	"exit2",
	"quietFail",
	"refused",
	"held",
	"lostExit",
	"cutNoStop",
	"timedOut",
	"background",
];

const COMMANDS = [
	"bunx vitest run src/a.test.ts",
	"bunx vitest run src/a.test.ts | tail -5",
	"bunx vitest run",
	"bun run check:types",
	"bun run check:changed",
	"bunx biome check src",
	"bun run build",
	"git push origin main",
	"git add a.ts && git commit -qm x",
	"ls missing-dir",
	"which magick",
	"curl -sf http://localhost:5173/",
	"echo done",
] as const;

/** mulberry32: a small seeded generator, so every generated run can be named by its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function result(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details };
}

function outputOf(command: string, failing: boolean): string {
	if (command.startsWith("ls ")) return "ls: missing-dir: No such file or directory";
	if (command.includes("vitest") || command.includes("check:changed"))
		return failing ? " × adds\n Tests  2 failed | 3 passed (5)" : " Tests  5 passed (5)";
	if (command.includes("check:types")) return failing ? "src/a.ts(1,1): error TS2322: nope" : "";
	return failing ? "error: something broke" : "ok";
}

/** A finished bash call as stock answers it in `shape`. */
function bash(command: string, shape: Shape, at: number): ToolEntry {
	const base = { toolName: "bash", args: { command }, streamingArgs: "", startTime: at, endTime: at + 1 };
	const error = { ...base, status: "error" as const, isError: true };
	switch (shape) {
		case "passed":
			return { ...base, status: "done", isError: false, result: result(outputOf(command, false)) };
		case "exit1":
		case "exit2": {
			const code = shape === "exit1" ? 1 : 2;
			return {
				...error,
				result: result(`${outputOf(command, true)}\n\nCommand exited with code ${code}`, { exitCode: code }),
			};
		}
		case "quietFail":
			return { ...base, status: "done", isError: false, result: result(outputOf(command, true)) };
		case "refused":
			return { ...error, result: result("Working directory does not exist: /nope") };
		case "held":
			return { ...error, result: result(`${CHECKOUT_REFUSAL_PREFIX}: git stash would move another session's work`) };
		case "lostExit":
			return { ...error, result: result("partial output\n\nCommand failed: missing exit status") };
		case "cutNoStop":
			return { ...error, result: result("partial output\n\n[Command aborted]") };
		case "timedOut":
			return { ...error, result: result("partial output", { timedOut: true }) };
		case "background":
			return {
				...base,
				status: "done",
				isError: false,
				result: result("Backgrounded as job bg_1", { async: { state: "running", jobId: "bg_1", type: "bash" } }),
			};
	}
}

const rejectedEdit = (path: string, at: number): ToolEntry => ({
	toolName: "edit",
	args: { path },
	status: "error",
	isError: true,
	streamingArgs: "",
	result: result("Edit rejected: old text not found"),
	startTime: at,
	endTime: at + 1,
});
const heldEdit = (path: string, at: number): ToolEntry => ({
	...rejectedEdit(path, at),
	result: result(`${CHECKOUT_REFUSAL_PREFIX}: ${path} is another session's`),
});
const failedRead = (path: string, at: number): ToolEntry => ({
	...rejectedEdit(path, at),
	toolName: "read",
	result: result("ENOENT"),
});

interface Run {
	seed: number;
	calls: { key: string; entry: ToolEntry; shape?: Shape }[];
}

function generate(seed: number): Run {
	const next = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const length = 1 + Math.floor(next() * 7);
	const calls: Run["calls"] = [];
	for (let index = 0; index < length; index++) {
		const at = index * 10;
		const key = `c${index}`;
		const roll = next();
		if (roll < 0.08) calls.push({ key, entry: rejectedEdit(pick(["a.ts", "b.ts"]), at) });
		else if (roll < 0.12) calls.push({ key, entry: heldEdit("a.ts", at) });
		else if (roll < 0.16) calls.push({ key, entry: failedRead("missing.ts", at) });
		else {
			const shape = pick(SHAPES);
			calls.push({ key, entry: bash(pick(COMMANDS), shape, at), shape });
		}
	}
	return { seed, calls };
}

function verdictOf(calls: Run["calls"]) {
	const outcome = workOutcomes(
		calls.map(({ key, entry }) => ({ entry, toolCallId: key })),
		undefined,
		"/repo",
	);
	const steps = stepOperations(calls.map(({ key, entry }) => [key, entry] as const));
	return { outcome, verdict: workVerdict(outcome.commands, "/repo", steps) };
}

const RUNS = Array.from({ length: 4000 }, (_, seed) => generate(seed + 1));
const STATUS_OF: Record<Shape, string> = {
	passed: "passed",
	exit1: "failed",
	exit2: "failed",
	quietFail: "failed",
	refused: "refused",
	held: "refused",
	lostExit: "failed",
	cutNoStop: "failed",
	timedOut: "failed",
	background: "unknown",
};

describe("work verdict invariants over generated runs", () => {
	it("reads every command's end by its documented rule", () => {
		for (const { seed, calls } of RUNS) {
			const { outcome } = verdictOf(calls);
			const byKey = new Map(outcome.commands.map(command => [command.toolCallId, command]));
			for (const { key, entry, shape } of calls) {
				if (!shape) continue;
				const command = String(entry.args.command);
				// A quiet failure is a failure only where the command's own check reads its output; else it passed.
				const quiet = shape === "quietFail" && !/vitest|check:types|check:changed/.test(command);
				expect(byKey.get(key)?.status, `seed ${seed} ${key} ${shape} ${command}`).toBe(
					quiet ? "passed" : STATUS_OF[shape],
				);
			}
		}
	});

	it("never turns a card red for a denied call, a successful command or an ls of a missing path alone", () => {
		for (const { seed, calls } of RUNS) {
			const harmless = calls.filter(
				({ entry, shape }) =>
					shape === "passed" ||
					shape === "refused" ||
					shape === "held" ||
					entry.toolName === "read" ||
					(entry.toolName === "edit" && String(resultText(entry)).startsWith(CHECKOUT_REFUSAL_PREFIX)) ||
					(String(entry.args.command).startsWith("ls ") && (shape === "exit1" || shape === "exit2")),
			);
			const { verdict } = verdictOf(harmless);
			expect(verdict.error, `seed ${seed}`).toBeUndefined();
			expect(verdict.failedCalls, `seed ${seed}`).toBe(0);
		}
	});

	it("is red exactly when a failure still stands, and the head counts only standing failures stock flagged", () => {
		for (const { seed, calls } of RUNS) {
			const { outcome, verdict } = verdictOf(calls);
			const standing = verdict.failedCommands.length + verdict.failedSteps.length;
			expect(verdict.error !== undefined, `seed ${seed}`).toBe(standing > 0);
			expect(verdict.failedCalls, `seed ${seed}`).toBeLessThanOrEqual(standing);
			for (const failed of verdict.failedCommands)
				expect(outcome.commands.find(command => command.toolCallId === failed.toolCallId)?.status).toBe("failed");
		}
	});

	it("goes green once every failed command and edit is run again and passes, unless a background job reported it", () => {
		for (const { seed, calls } of RUNS) {
			const { verdict } = verdictOf(calls);
			const end = calls.length * 10 + 100;
			const reruns: Run["calls"] = [
				...verdict.failedCommands.map((call, index) => ({
					key: `again-c${index}`,
					entry: bash(call.command, "passed", end + index * 10),
					shape: "passed" as const,
				})),
				...verdict.failedSteps.map((step, index) => ({
					key: `again-s${index}`,
					entry: {
						...rejectedEdit(String(step.args.path), end + 500 + index * 10),
						status: "done" as const,
						isError: false,
						result: result("ok"),
					},
				})),
			];
			expect(verdictOf([...calls, ...reruns]).verdict.error, `seed ${seed}`).toBeUndefined();
		}
	});

	it("says the same of a command on the card, on the board and in Autopilot's ledger", () => {
		for (const { seed, calls } of RUNS) {
			const { outcome, verdict } = verdictOf(calls);
			for (const { key, entry } of calls) {
				if (entry.toolName !== "bash") continue;
				const card = outcome.commands.find(command => command.toolCallId === key)?.status;
				expect(ledgerCall("bash", entry.args, entry.result, entry.isError)?.status, `seed ${seed} ${key}`).toBe(
					card,
				);
			}
			const board = lastCheck(
				calls.map(({ key, entry }) => [key, entry] as const),
				outcome.commands,
				"/repo",
				new Map(),
			);
			// The board names a newest check still without its result first (`running`); otherwise it fails exactly when
			// the card's verdict holds a failed check.
			const cardCheckFailed = verdict.checks.some(check => !check.passed);
			if (board?.state !== "running")
				expect(board?.state === "failed", `seed ${seed}: board ${board?.state} ${board?.command}`).toBe(
					cardCheckFailed,
				);
			// Autopilot's green needs the last check that ran to have passed after the last edit: never green over a last
			// check the card reads as failed, and a refused one is no check run.
			const ledger = calls.flatMap(({ entry }) => {
				const call = ledgerCall(entry.toolName, entry.args, entry.result, entry.isError);
				return call ? [call] : [];
			});
			const ran = ledger.filter(
				call =>
					call.tool === "bash" &&
					call.status !== "refused" &&
					call.status !== "interrupted" &&
					isCheckCommand(call.command ?? ""),
			);
			if (judgeVerify({ claimed: "green", changed: true, calls: ledger }).verify === "green")
				expect(ran.at(-1)?.status, `seed ${seed}`).not.toBe("failed");
		}
	});

	it("keeps a command's verdict when only its unrelated facts move", () => {
		const facts = {
			command: "bunx vitest run",
			cut: false,
			pending: false,
			errored: false,
			exitCode: 0,
			resultText: " Tests  5 passed (5)",
			output: " Tests  5 passed (5)",
		};
		expect(commandStatus(facts)).toBe("passed");
		expect(commandStatus({ ...facts, cut: true, errored: true, exitCode: 1 })).toBe("interrupted");
		expect(commandStatus({ ...facts, pending: true, exitCode: 1 })).toBe("unknown");
		expect(commandStatus({ ...facts, delivered: true, errored: true, exitCode: null })).toBe("failed");
	});
});

function resultText(entry: ToolEntry): string {
	const content = (entry.result as { content?: { text?: string }[] } | null)?.content;
	return content?.map(block => block.text ?? "").join("") ?? "";
}
