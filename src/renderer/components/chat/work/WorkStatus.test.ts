import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../../stores/tools";
import { isInterruptedError } from "./WorkStatus";
import { workOutcomes } from "./work-view";

// 27 Oct 2026: an app restart cut a `gh run watch` at the process's exit ("Command aborted"); the placeholder reply
// ("Previous OMP process exited before completing the turn.") was journaled 20.8 s later, outside the 1 s the stop
// window allows, and the card drew a failed command.
const watch = (text: string, endTime: number, details: Record<string, unknown> = {}): ToolEntry => ({
	toolName: "bash",
	args: { command: "gh run watch 1 --exit-status" },
	status: "error",
	streamingArgs: "",
	result: { content: [{ type: "text", text }], details },
	isError: true,
	startTime: 1_000,
	endTime,
});
const stoppedAt = 21_700;

describe("isInterruptedError", () => {
	it.each(["Command aborted", "partial output\n\n[Command aborted]", "[Command cancelled]\npartial output"])(
		"reads a command cut off by the stop as interrupted however long before the stop reply it ended: %s",
		text => {
			expect(isInterruptedError(watch(text, 1_000), stoppedAt)).toBe(true);
		},
	);

	it("does not read the same words as an interruption when nothing stopped the run", () => {
		expect(isInterruptedError(watch("Command aborted", 1_000))).toBe(false);
	});

	it.each([
		["a command that lost its exit status", "build output\n\nCommand failed: missing exit status", {}],
		["a command that exited non-zero", "tests failed\n\nCommand exited with code 1", { exitCode: 1 }],
		["a refusal", "Service mode does not accept async", {}],
	])("keeps %s a failure however long before the stop reply it ended", (_, text, details) => {
		expect(isInterruptedError(watch(text, 1_000, details), stoppedAt)).toBe(false);
	});

	it("reads a command the stop cut as cut off in the ledger, not failed", () => {
		const [command] = workOutcomes([watch("Command aborted", 2_000)], stoppedAt).commands;
		expect(command).toMatchObject({ interrupted: true, failed: false });
	});
});
