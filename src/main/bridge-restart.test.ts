/**
 * What a relaunch's restore reads from the journal beyond stock `restoreSession`
 * (resources/gui-bridge/restart-core.ts): background bash jobs the last process
 * started and never finished, and a goal that was still active when it ended.
 */
import { describe, expect, it } from "vitest";
import {
	goalActiveAtExit,
	interruptedJobs,
	type JournalEntry,
	restartJobsNotice,
} from "../../resources/gui-bridge/restart-core";

const exit: JournalEntry = { type: "custom", customType: "session_exit" };

function bashCall(id: string, command: string): JournalEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command, async: true } }],
		},
	};
}

function started(callId: string, jobId: string): JournalEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: callId,
			content: [{ type: "text", text: `Backgrounded as job ${jobId}` }],
			details: { async: { state: "running", jobId, type: "bash" } },
		},
	};
}

function delivered(jobId: string): JournalEntry {
	return { type: "custom_message", customType: "async-result", details: { jobs: [{ jobId }] } };
}

describe("interruptedJobs", () => {
	it("names the background bash jobs the last process left unfinished, with their commands", () => {
		const branch = [
			bashCall("c1", "sleep 40; echo a"),
			started("c1", "bg_1"),
			bashCall("c2", "make"),
			started("c2", "bg_2"),
		];
		expect(interruptedJobs([...branch, delivered("bg_2"), exit])).toEqual([
			{ id: "bg_1", command: "sleep 40; echo a" },
		]);
	});

	it("treats a job a wait report settled as finished", () => {
		const report: JournalEntry = {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "w",
				content: [{ type: "text", text: "### bg_1 [bash] — completed" }],
			},
		};
		expect(interruptedJobs([bashCall("c1", "x"), started("c1", "bg_1"), report, exit])).toEqual([]);
	});

	it("reads only the life of the process the latest exit ended, and nothing without an exit", () => {
		const earlier = [bashCall("c1", "old"), started("c1", "bg_1"), exit];
		expect(interruptedJobs([...earlier, bashCall("c2", "new"), started("c2", "bg_1"), exit])).toEqual([
			{ id: "bg_1", command: "new" },
		]);
		expect(interruptedJobs([bashCall("c1", "x"), started("c1", "bg_1")])).toEqual([]);
	});

	it("tells the agent which jobs stopped and to go on", () => {
		expect(restartJobsNotice([{ id: "bg_1", command: "npm test" }])).toContain("- bg_1: `npm test`");
	});
});

describe("goalActiveAtExit", () => {
	it("is true only when the last mode before the exit was an active goal", () => {
		expect(goalActiveAtExit([{ type: "mode_change", mode: "goal" }, exit])).toBe(true);
		expect(
			goalActiveAtExit([{ type: "mode_change", mode: "goal" }, { type: "mode_change", mode: "goal_paused" }, exit]),
		).toBe(false);
		// The startup pause after the exit does not count.
		expect(
			goalActiveAtExit([{ type: "mode_change", mode: "goal" }, exit, { type: "mode_change", mode: "goal_paused" }]),
		).toBe(true);
		expect(goalActiveAtExit([{ type: "mode_change", mode: "goal" }])).toBe(false);
	});
});
