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
	RESTART_JOBS_MESSAGE,
	restartJobsDetails,
	restartJobsNotice,
} from "../../resources/gui-bridge/restart-core";

const exit: JournalEntry = { type: "custom", customType: "session_exit" };

function bashCall(id: string, command: string, intent?: string): JournalEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name: "bash",
					arguments: { command, async: true, ...(intent ? { i: intent } : {}) },
				},
			],
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
	/** This process started at 10:00:00; `before` stamps entries the replaced processes journaled. */
	const startedAt = Date.parse("2026-10-17T10:00:00.000Z");
	const replaced = (...entries: JournalEntry[]): JournalEntry[] =>
		entries.map(entry => ({ ...entry, timestamp: "2026-10-17T09:59:00.000Z" }));
	const now = (entry: JournalEntry): JournalEntry => ({ ...entry, timestamp: "2026-10-17T10:00:01.000Z" });

	it("names the background bash jobs the last process left unfinished, with their commands", () => {
		const branch = replaced(
			bashCall("c1", "sleep 40; echo a"),
			started("c1", "bg_1"),
			bashCall("c2", "make"),
			started("c2", "bg_2"),
			delivered("bg_2"),
			exit,
		);
		expect(interruptedJobs(branch, startedAt)).toEqual([{ id: "bg_1", command: "sleep 40; echo a" }]);
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
		expect(interruptedJobs(replaced(bashCall("c1", "x"), started("c1", "bg_1"), report, exit), startedAt)).toEqual(
			[],
		);
	});

	it("needs no session_exit: stock journals none for a SIGKILL, and not always when its stdin closes", () => {
		const aborted: JournalEntry = { type: "message", message: { role: "assistant" } };
		const branch = [...replaced(bashCall("c1", "sleep 60"), started("c1", "bg_1"), aborted), now(aborted)];
		expect(interruptedJobs(branch, startedAt)).toEqual([{ id: "bg_1", command: "sleep 60" }]);
		// This process's own jobs are not the restart's.
		expect(interruptedJobs([now(bashCall("c1", "x")), now(started("c1", "bg_1"))], startedAt)).toEqual([]);
	});

	it("leaves out an older life before the second-to-last exit, and a job an earlier relaunch already named", () => {
		const older = [bashCall("c1", "old"), started("c1", "bg_1"), exit];
		expect(
			interruptedJobs(replaced(...older, bashCall("c2", "new"), started("c2", "bg_1"), exit), startedAt),
		).toEqual([{ id: "bg_1", command: "new" }]);
		const named: JournalEntry = { type: "custom_message", customType: RESTART_JOBS_MESSAGE, content: "- bg_1: `x`" };
		expect(interruptedJobs(replaced(bashCall("c1", "x"), started("c1", "bg_1"), named), startedAt)).toEqual([]);
	});

	it("carries the intent the agent gave the call, so the agent can judge whether the job is still needed", () => {
		const branch = replaced(bashCall("c1", "gh run watch 1", "Watch release CI"), started("c1", "bg_1"), exit);
		expect(interruptedJobs(branch, startedAt)).toEqual([
			{ id: "bg_1", command: "gh run watch 1", intent: "Watch release CI" },
		]);
		// A blank intent is no intent.
		expect(interruptedJobs(replaced(bashCall("c1", "x", "  "), started("c1", "bg_1"), exit), startedAt)).toEqual([
			{ id: "bg_1", command: "x" },
		]);
	});

	it("counts a notice the new wording named as settled, so one restart never names a job twice", () => {
		const named: JournalEntry = {
			type: "custom_message",
			customType: RESTART_JOBS_MESSAGE,
			content: restartJobsNotice([{ id: "bg_7", command: "x", intent: "Watch" }]),
		};
		expect(interruptedJobs(replaced(bashCall("c1", "x"), started("c1", "bg_7"), named), startedAt)).toEqual([]);
	});
});

describe("restartJobsNotice", () => {
	it("names each stopped job with its intent first, then its command, and asks for a quiet re-run of what is needed", () => {
		const text = restartJobsNotice([
			{ id: "bg_1", command: "npm test" },
			{ id: "bg_2", command: "gh run watch 1", intent: "Watch release CI" },
		]);
		const lines = text.split("\n");
		expect(lines[1]).toBe("- bg_1: `npm test`");
		expect(lines[2]).toBe("- bg_2: Watch release CI — `gh run watch 1`");
		expect(text).toMatch(/only the jobs the work still needs/);
		expect(text).toMatch(/Say nothing about the restart/);
	});

	it("gives the transcript only ids and intents, never a command", () => {
		const details = restartJobsDetails([
			{ id: "bg_1", command: "secret --token=abc" },
			{ id: "bg_2", command: "y", intent: "Watch release CI" },
		]);
		expect(details).toEqual({ jobs: [{ id: "bg_1" }, { id: "bg_2", intent: "Watch release CI" }] });
		expect(JSON.stringify(details)).not.toContain("secret");
	});
});

describe("goalActiveAtExit", () => {
	/** This process started at 10:00:00; the entries before were journaled by the processes it replaced. */
	const startedAt = Date.parse("2026-10-17T10:00:00.000Z");
	const mode = (value: string, time: string): JournalEntry => ({
		type: "mode_change",
		mode: value,
		timestamp: `2026-10-17T${time}.000Z`,
	});
	const aborted: JournalEntry = {
		type: "message",
		message: { role: "assistant" },
		timestamp: "2026-10-17T09:59:58.000Z",
	};

	it("is true when the last mode the earlier processes journaled was an active goal", () => {
		expect(goalActiveAtExit([mode("goal", "09:59:50"), exit], startedAt)).toBe(true);
		expect(goalActiveAtExit([mode("goal", "09:59:50"), mode("goal_paused", "09:59:55"), exit], startedAt)).toBe(
			false,
		);
		// This process's startup pause does not count.
		expect(goalActiveAtExit([mode("goal", "09:59:50"), exit, mode("goal_paused", "10:00:01")], startedAt)).toBe(true);
	});

	it("needs no session_exit: stock journals only the aborted turn when its client closes stdin, nothing on SIGKILL", () => {
		expect(goalActiveAtExit([mode("goal", "09:59:50"), aborted, mode("goal_paused", "10:00:01")], startedAt)).toBe(
			true,
		);
		expect(goalActiveAtExit([mode("goal_paused", "09:59:50"), aborted], startedAt)).toBe(false);
		expect(goalActiveAtExit([mode("goal", "10:00:02")], startedAt)).toBe(false);
	});
});
