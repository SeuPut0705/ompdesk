/**
 * What a relaunch's restore reads from the journal beyond stock `restoreSession`
 * (resources/gui-bridge/restart-core.ts): background bash jobs the last process
 * started and never finished, the subagents it revived for a session whose own turn
 * stays idle, a goal that was still active when it ended, and a turn its exit record
 * calls finished although the model never answered its last message.
 */
import { describe, expect, it } from "vitest";
import {
	goalActiveAtExit,
	interruptedJobs,
	type JournalEntry,
	journalEnd,
	RESTART_JOBS_MESSAGE,
	RESTART_SUBAGENTS_MESSAGE,
	RESTART_TURN_MESSAGE,
	requestCutAtExit,
	restartFollowUp,
	revivedSubagents,
	shutdownMarks,
	turnCutBehindNotes,
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
			content: restartFollowUp([{ id: "bg_7", command: "x", intent: "Watch" }], [])?.content,
		};
		expect(interruptedJobs(replaced(bashCall("c1", "x"), started("c1", "bg_7"), named), startedAt)).toEqual([]);
	});
});

describe("revivedSubagents", () => {
	const spawn = (tasks: Array<{ name: string; task: string }>): JournalEntry => ({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "task", arguments: { i: "Delegating", tasks } }],
		},
	});

	it("names each revived subagent with its assignment's Title: line, else its first line, from the latest task call", () => {
		const branch = [
			spawn([{ name: "Release", task: "Title: old title\nbody" }]),
			spawn([
				{ name: "Release", task: "Title: v0.38.0 배포\n\n1. Integrate the branch" },
				{ name: "Scout", task: "Find the flaky test\nthen report" },
			]),
		];
		expect(revivedSubagents(branch, ["Release", "Scout", "Nested"])).toEqual([
			{ id: "Release", intent: "v0.38.0 배포" },
			{ id: "Scout", intent: "Find the flaky test" },
			// A child of a subagent was not spawned by this session: its id alone.
			{ id: "Nested" },
		]);
	});

	it("keeps a long first line to one short list line", () => {
		const [agent] = revivedSubagents([spawn([{ name: "Long", task: "x".repeat(300) }])], ["Long"]);
		expect(agent?.intent).toHaveLength(120);
		expect(agent?.intent?.endsWith("…")).toBe(true);
	});
});

describe("restartFollowUp", () => {
	it("says nothing when the restart left nothing to tell", () => {
		expect(restartFollowUp([], [])).toBeUndefined();
	});

	it("names each stopped job with its intent first, then its command, and asks for a quiet re-run of what is needed", () => {
		const followUp = restartFollowUp(
			[
				{ id: "bg_1", command: "npm test" },
				{ id: "bg_2", command: "gh run watch 1", intent: "Watch release CI" },
			],
			[],
		);
		expect(followUp?.customType).toBe(RESTART_JOBS_MESSAGE);
		const lines = followUp?.content.split("\n") ?? [];
		expect(lines[1]).toBe("- bg_1: `npm test`");
		expect(lines[2]).toBe("- bg_2: Watch release CI — `gh run watch 1`");
		expect(followUp?.content).toMatch(/only the jobs the work still needs/);
		expect(followUp?.content).toMatch(/Say nothing about the restart/);
	});

	it("gives the transcript only ids and intents, never a command", () => {
		const details = restartFollowUp(
			[
				{ id: "bg_1", command: "secret --token=abc" },
				{ id: "bg_2", command: "y", intent: "Watch release CI" },
			],
			[],
		)?.details;
		expect(details).toEqual({ jobs: [{ id: "bg_1" }, { id: "bg_2", intent: "Watch release CI" }] });
		expect(JSON.stringify(details)).not.toContain("secret");
	});

	it("tells an idle session which subagents work again: check them, tell the user briefly, keep supervising, no restart talk", () => {
		const followUp = restartFollowUp([], [{ id: "Release", intent: "v0.38.0 배포" }, { id: "Nested" }]);
		expect(followUp?.customType).toBe(RESTART_SUBAGENTS_MESSAGE);
		const lines = followUp?.content.split("\n") ?? [];
		expect(lines[1]).toBe("- Release: v0.38.0 배포");
		expect(lines[2]).toBe("- Nested");
		expect(followUp?.content).toMatch(/tell the user in a sentence or two what is still in progress/);
		expect(followUp?.content).toMatch(/keep supervising/);
		expect(followUp?.content).toMatch(/Say nothing about the restart/);
		expect(followUp?.details).toEqual({
			jobs: [],
			subagents: [{ id: "Release", intent: "v0.38.0 배포" }, { id: "Nested" }],
		});
	});

	it("folds stopped jobs and revived subagents into one follow-up, so the session gets one turn", () => {
		const followUp = restartFollowUp([{ id: "bg_1", command: "make" }], [{ id: "Scout" }]);
		expect(followUp?.customType).toBe(RESTART_JOBS_MESSAGE);
		expect(followUp?.content).toContain("- bg_1: `make`");
		expect(followUp?.content).toContain("- Scout");
		expect(followUp?.details).toEqual({ jobs: [{ id: "bg_1" }], subagents: [{ id: "Scout" }] });
	});

	it("continues a turn the restart cut off, alone or with jobs and subagents, in one message", () => {
		const turn = restartFollowUp([], [], true);
		expect(turn?.customType).toBe(RESTART_TURN_MESSAGE);
		expect(turn?.content).toMatch(/cut your turn off/);
		expect(turn?.content).toMatch(/Say nothing about the restart/);
		expect(turn?.details).toEqual({ jobs: [], turn: true });
		const all = restartFollowUp([{ id: "bg_1", command: "make" }], [{ id: "Scout" }], true);
		expect(all?.customType).toBe(RESTART_JOBS_MESSAGE);
		expect(all?.content).toMatch(/cut your turn off/);
		expect(all?.details).toEqual({ jobs: [{ id: "bg_1" }], subagents: [{ id: "Scout" }], turn: true });
	});
});

describe("turnCutBehindNotes", () => {
	/** The relaunch started at 05:31:52; the entries before were journaled by the 0.48.0 process the update quit. */
	const startedAt = Date.parse("2026-10-21T05:31:52.000Z");
	const at = (time: string) => `2026-10-21T${time}Z`;
	const wait: JournalEntry = {
		type: "message",
		timestamp: at("05:29:49.735"),
		message: { role: "assistant", stopReason: "toolUse" },
	};
	const exitPending: JournalEntry = {
		type: "custom",
		customType: "session_exit",
		timestamp: at("05:31:45.866"),
		data: { reason: "dispose", kind: "normal", pendingToolCalls: [{ toolName: "wait" }] },
	};
	const abortedResult: JournalEntry = {
		type: "message",
		timestamp: at("05:31:45.955"),
		message: { role: "toolResult" },
	};
	const aborted: JournalEntry = {
		type: "message",
		timestamp: at("05:31:45.979"),
		message: { role: "assistant", stopReason: "aborted" },
	};
	const evalState: JournalEntry = {
		type: "custom_message",
		customType: "eval-state-context",
		timestamp: at("05:31:53.031"),
	};
	// A report the bridge handed the session once the abort left it idle (the parent tab of the incident).
	const mail: JournalEntry = { type: "custom_message", customType: "ompdesk.mail", timestamp: at("05:31:46.016") };
	// A follow-up stock had queued since an earlier relaunch, journaled with its old timestamp at the abort (a child).
	const staleFollowUp: JournalEntry = {
		type: "custom_message",
		customType: "ompdesk-restart-jobs",
		timestamp: "2026-10-20T22:51:25.257Z",
	};
	const cut = [wait, exitPending, abortedResult, aborted];

	it("finds the v0.49.0 update's two journals: an aborted turn with a custom message after it", () => {
		expect(turnCutBehindNotes([...cut, mail, evalState], startedAt)).toBe(true);
		expect(turnCutBehindNotes([...cut, staleFollowUp], startedAt)).toBe(true);
	});

	it("leaves to stock's retry an aborted turn with only its startup eval snapshot after it", () => {
		expect(turnCutBehindNotes(cut, startedAt)).toBe(false);
		expect(turnCutBehindNotes([...cut, evalState], startedAt)).toBe(false);
	});

	it("leaves alone a turn that ended, one someone answered, and one this process aborted", () => {
		const answered: JournalEntry = { ...aborted, message: { role: "assistant", stopReason: "stop" } };
		expect(turnCutBehindNotes([wait, abortedResult, answered, mail], startedAt)).toBe(false);
		const typed: JournalEntry = { type: "message", timestamp: at("05:32:17.847"), message: { role: "user" } };
		expect(turnCutBehindNotes([...cut, mail, typed], startedAt)).toBe(false);
		const late: JournalEntry = { ...aborted, timestamp: at("05:32:00.000") };
		expect(turnCutBehindNotes([wait, abortedResult, late, mail], startedAt)).toBe(false);
	});

	it("counts a failed reply like an aborted one", () => {
		const failed: JournalEntry = { ...aborted, message: { role: "assistant", stopReason: "error" } };
		expect(turnCutBehindNotes([wait, abortedResult, failed, mail], startedAt)).toBe(true);
	});
});

describe("shutdownMarks", () => {
	/** The relaunch started at 14:50:00; the parent's dispose journaled its exit at 14:48:11.385 (the 24 Oct 2026 repro). */
	const startedAt = Date.parse("2026-10-24T14:50:00.000Z");
	const at = (time: string) => `2026-10-24T${time}Z`;
	const parentExit: JournalEntry = {
		type: "custom",
		customType: "session_exit",
		timestamp: at("14:48:11.385"),
		data: { reason: "dispose", kind: "normal", pendingToolCalls: [{ toolName: "wait" }] },
	};
	const parentReply: JournalEntry = {
		type: "message",
		timestamp: at("14:47:51.481"),
		message: { role: "assistant" },
	};
	const parent = [parentReply, parentExit];
	const call: JournalEntry = {
		type: "message",
		timestamp: at("14:48:07.384"),
		message: { role: "assistant", stopReason: "toolUse" },
	};
	const abortedResult: JournalEntry = {
		type: "message",
		timestamp: at("14:48:11.396"),
		message: { role: "toolResult" },
	};
	const aborted: JournalEntry = {
		type: "message",
		timestamp: at("14:48:11.442"),
		message: { role: "assistant", stopReason: "aborted" },
	};
	const ownExit: JournalEntry = {
		type: "custom",
		customType: "session_exit",
		timestamp: at("14:48:11.445"),
		data: { reason: "dispose", kind: "normal" },
	};
	/** What a relaunch builds stock's record from: the transcript without the stop's marks. */
	const withoutMarks = (entries: JournalEntry[], journal = parent) => {
		const marks = shutdownMarks(entries, journal, startedAt);
		return marks.length === 0 ? undefined : entries.filter((_, index) => !marks.includes(index));
	};

	it("finds the transcript a graceful stop parked: an aborted reply after the parent's exit, then its own exit", () => {
		expect(withoutMarks([call, abortedResult, aborted, ownExit])).toEqual([call, abortedResult]);
		expect(withoutMarks([call, abortedResult, aborted])).toEqual([call, abortedResult]);
	});

	// 26 Oct 2026, v0.75.2 → v0.75.3: the app went away under omp, whose stdout-disconnect quit journaled each
	// subagent's exit as `manual` from a few ms before the parent's, while each waited for its model's answer.
	it("finds a subagent the app's going away cut while it waited for its model: its own exit, an abort after or none", () => {
		const parentQuit: JournalEntry = {
			...parentExit,
			data: { reason: "manual", kind: "normal", pendingToolCalls: [{ toolName: "wait" }] },
		};
		const result: JournalEntry = { type: "message", timestamp: at("14:46:07.000"), message: { role: "toolResult" } };
		const quit: JournalEntry = {
			...ownExit,
			timestamp: at("14:48:11.362"),
			data: { reason: "manual", kind: "normal" },
		};
		const lateAbort: JournalEntry = { ...aborted, timestamp: at("14:48:11.400") };
		expect(withoutMarks([call, result, quit], [parentReply, parentQuit])).toEqual([call, result]);
		expect(withoutMarks([call, result, quit, lateAbort], [parentReply, parentQuit])).toEqual([call, result]);
	});

	it("leaves an exit of an earlier stop: the subagent sat cut since a relaunch that did not revive it", () => {
		const earlierQuit: JournalEntry = {
			...ownExit,
			timestamp: at("12:00:00.000"),
			data: { reason: "manual", kind: "normal" },
		};
		expect(withoutMarks([call, abortedResult, earlierQuit])).toBeUndefined();
	});

	it("leaves a reply that is not an abort: a finished turn, a failure, a cut tool call", () => {
		const finished: JournalEntry = { ...aborted, message: { role: "assistant", stopReason: "stop" } };
		const failed: JournalEntry = { ...aborted, message: { role: "assistant", stopReason: "error" } };
		expect(withoutMarks([call, abortedResult, finished, ownExit])).toEqual([call, abortedResult, finished]);
		expect(withoutMarks([call, abortedResult, failed])).toBeUndefined();
		expect(withoutMarks([call, abortedResult])).toBeUndefined();
		expect(withoutMarks([])).toBeUndefined();
	});

	it("leaves an abort that came before the parent's exit: the parent cancelled the job, or a limit ran out", () => {
		const cancelled: JournalEntry = { ...aborted, timestamp: at("14:31:02.000") };
		expect(withoutMarks([call, abortedResult, cancelled])).toBeUndefined();
	});

	it("leaves an abort this process made, and a parent that journaled no exit of the processes it replaced", () => {
		const late: JournalEntry = { ...aborted, timestamp: at("14:51:00.000") };
		expect(withoutMarks([call, abortedResult, late])).toBeUndefined();
		expect(withoutMarks([call, abortedResult, aborted], [parentReply])).toBeUndefined();
		const ownLife: JournalEntry = { ...parentExit, timestamp: at("14:51:30.000") };
		expect(withoutMarks([call, abortedResult, aborted], [ownLife])).toBeUndefined();
	});

	it("reads the parent's last exit before this process: an earlier relaunch's exit does not date a newer abort", () => {
		const earlier: JournalEntry = { ...parentExit, timestamp: at("12:00:00.000") };
		expect(withoutMarks([call, abortedResult, aborted], [earlier, ...parent])).toEqual([call, abortedResult]);
		const next: JournalEntry = { ...parentExit, timestamp: at("14:49:00.000") };
		expect(withoutMarks([call, abortedResult, aborted], [...parent, next])).toBeUndefined();
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

describe("requestCutAtExit", () => {
	/** This process started at 10:00:00; entries stamped before it were journaled by the process it replaced. */
	const startedAt = Date.parse("2026-10-19T11:04:33.000Z");
	const at = (time: string) => `2026-10-19T${time}Z`;
	const user: JournalEntry = { type: "message", timestamp: at("11:03:21.851"), message: { role: "user" } };
	const call: JournalEntry = {
		type: "message",
		timestamp: at("11:04:29.649"),
		message: { role: "assistant", stopReason: "toolUse" },
	};
	const result: JournalEntry = { type: "message", timestamp: at("11:04:30.737"), message: { role: "toolResult" } };
	const cleanExit = (pendingToolCalls?: unknown[], time = "11:04:30.877"): JournalEntry => ({
		type: "custom",
		customType: "session_exit",
		timestamp: at(time),
		data: { reason: "dispose", kind: "normal", ...(pendingToolCalls ? { pendingToolCalls } : {}) },
	});

	it("finds the v0.41.0 update restart's journal: a bash result, a clean exit record, nothing after", () => {
		const exitRecord = cleanExit();
		expect(requestCutAtExit([user, call, result, exitRecord], startedAt)).toBe(exitRecord);
		// What this process journals at startup (a prompt origin, a model change) is no answer.
		const digest: JournalEntry = {
			type: "custom",
			customType: "system-prompt-digest",
			timestamp: at("11:05:23.000"),
		};
		expect(requestCutAtExit([user, call, result, exitRecord, digest], startedAt)).toBe(exitRecord);
	});

	it("finds a prompt the model never answered before a clean exit record", () => {
		const exitRecord = cleanExit();
		expect(requestCutAtExit([user, exitRecord], startedAt)).toBe(exitRecord);
	});

	it("leaves to stock what stock's own restore or retry already continues", () => {
		// A tool still running: stock records it and reruns it.
		expect(requestCutAtExit([user, call, cleanExit([{ toolName: "bash" }])], startedAt)).toBeUndefined();
		// Its abort record reached the journal after the exit: stock's retry replays it.
		const aborted: JournalEntry = {
			type: "message",
			timestamp: at("11:04:30.980"),
			message: { role: "assistant", stopReason: "aborted" },
		};
		expect(requestCutAtExit([user, call, result, cleanExit(), aborted], startedAt)).toBeUndefined();
		// A prompt journaled as its process ended, after the exit record: stock's restore sees it.
		expect(requestCutAtExit([call, result, cleanExit(), user], startedAt)).toBeUndefined();
		// A signal or crash exit: stock reads it as abnormal itself.
		const signal: JournalEntry = { ...cleanExit(), data: { reason: "SIGTERM", kind: "signal" } };
		expect(requestCutAtExit([user, call, result, signal], startedAt)).toBeUndefined();
		// No exit record at all (SIGKILL): stock assumes one.
		expect(requestCutAtExit([user, call, result], startedAt)).toBeUndefined();
	});

	it("leaves a turn that really ended alone", () => {
		const answered: JournalEntry = {
			type: "message",
			timestamp: at("11:04:30.800"),
			message: { role: "assistant", stopReason: "stop" },
		};
		expect(requestCutAtExit([user, call, result, answered, cleanExit()], startedAt)).toBeUndefined();
		// Tool results that close a failed or stopped reply end its turn (stock's rule).
		const failed: JournalEntry = { ...call, message: { role: "assistant", stopReason: "aborted" } };
		expect(requestCutAtExit([user, failed, result, cleanExit()], startedAt)).toBeUndefined();
	});

	it("counts only an exit of the process this one replaced", () => {
		expect(requestCutAtExit([user, call, result, cleanExit(undefined, "11:04:40.000")], startedAt)).toBeUndefined();
	});
});

describe("journalEnd", () => {
	it("names the last message and the exit record after it", () => {
		const exitRecord: JournalEntry = { type: "custom", customType: "session_exit", data: { kind: "normal" } };
		const pending: JournalEntry = { ...exitRecord, data: { kind: "normal", pendingToolCalls: [{}] } };
		const answer: JournalEntry = { type: "message", message: { role: "assistant", stopReason: "stop" } };
		const result: JournalEntry = { type: "message", message: { role: "toolResult" } };
		expect(journalEnd([result, exitRecord])).toBe("toolResult, exit normal");
		expect(journalEnd([result, pending])).toBe("toolResult, exit normal+pending");
		expect(journalEnd([exitRecord, answer])).toBe("assistant/stop, no exit");
		expect(journalEnd([])).toBe("no message, no exit");
	});
});
