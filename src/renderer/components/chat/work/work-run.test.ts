import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import type { SubagentNode } from "../../../stores/subagents";
import {
	agentConclusion,
	finishedHeadline,
	mergeRunAgents,
	projectPath,
	resumedAgents,
	runSpan,
	runTranscript,
} from "./work-run";

// Shapes recorded from real omp 18.10 (the real-work-map audit): a detached task
// returns pending progress rows; the plain-text final message arrives in an async-result.
const spawn: AgentMessage = {
	role: "assistant",
	timestamp: 1_000,
	content: [{ type: "toolCall", id: "task-1", name: "task", arguments: {} }],
};
const taskResult: AgentMessage = {
	role: "toolResult",
	toolCallId: "task-1",
	toolName: "task",
	timestamp: 1_100,
	content: [{ type: "text", text: "Started 1 agent" }],
	details: {
		async: { state: "running", jobId: "Reader", type: "task" },
		progress: [{ id: "Reader", index: 0, agent: "task", status: "pending", description: "Count alpha lines" }],
	},
};
const completion = (body: string, status = "completed"): AgentMessage => ({
	role: "custom",
	customType: "async-result",
	timestamp: 9_000,
	content: `<system-notice>\nBackground job Reader has completed. Resume your work using the result below.\n<task-result id="Reader" agent="task" status="${status}" duration="7.8s">\n${body}\n</task-result>\n</system-notice>`,
	details: { jobs: [{ jobId: "Reader", agentId: "Reader", type: "task", durationMs: 7_812 }] },
});
const owns = (id: string) => id === "task-1";

describe("run transcript", () => {
	it("reads a plain-text (no yield) completion as the lane conclusion with stock's job duration", () => {
		const run = runTranscript(
			[spawn, taskResult, completion("<output>\nalpha.txt has 3 lines.\nDetails follow.\n</output>")],
			owns,
		);
		expect(run.agents.map(agent => agent.id)).toEqual(["Reader"]);
		expect(run.completions.get("Reader")).toEqual({
			status: "completed",
			summary: "alpha.txt has 3 lines.",
			durationMs: 7_812,
		});
	});

	it("rebuilds lanes after a reload from the transcript alone, with the settled status", () => {
		const run = runTranscript(
			[
				spawn,
				taskResult,
				completion("<error>\nboom\n</error>\n<output>\n(no output)\n</output>", "failed (exit 1)"),
			],
			owns,
		);
		const lanes = mergeRunAgents([], run);
		expect(lanes).toMatchObject([{ id: "Reader", status: "failed", parentToolCallId: "task-1" }]);
		expect(run.completions.get("Reader")?.summary).toBe("boom");
		// An agent that never settled and is no longer live was cut off with its run.
		expect(mergeRunAgents([], runTranscript([spawn, taskResult], owns))[0]?.status).toBe("aborted");
	});

	it("reads a blocking spawn's SingleResult and its plain output", () => {
		const run = runTranscript([], owns, [
			{
				toolCallId: "task-1",
				timestamp: 5,
				result: {
					details: {
						results: [{ id: "Reader", index: 0, exitCode: 0, output: "Two lines.\nMore", durationMs: 4_200 }],
					},
				},
			},
		]);
		expect(run.completions.get("Reader")).toEqual({ status: "completed", summary: "Two lines.", durationMs: 4_200 });
	});

	it("falls back to the finished progress tail (newest line first) before the completion lands", () => {
		const node = {
			id: "Reader",
			progress: { recentOutput: ["Second line.", "First line of the reply."] },
		} as unknown as SubagentNode;
		expect(agentConclusion(node, undefined)).toBe("First line of the reply.");
	});

	it("keeps live registry rows ahead of transcript rows", () => {
		const live = {
			id: "Reader",
			index: 0,
			agent: "task",
			status: "running",
			lastUpdate: 2,
			parentToolCallId: "task-1",
		} as SubagentNode;
		expect(mergeRunAgents([live], runTranscript([spawn, taskResult], owns))).toEqual([live]);
	});

	it("settles only from records after its spawn, and reuses one index per transcript", () => {
		const early = { ...completion("<output>\nstale\n</output>"), timestamp: 500 };
		const transcript = [early, spawn, taskResult, completion("<output>\nfresh\n</output>")];
		expect(runTranscript(transcript, owns).completions.get("Reader")?.summary).toBe("fresh");
		// Same list, another card that owns nothing: no agents, nothing settled.
		expect(runTranscript(transcript, () => false).agents).toEqual([]);
	});

	it("restores an unanswered call's agents from its arguments, named as stock names them", () => {
		const calls = [
			{
				toolCallId: "task-1",
				result: null,
				timestamp: 3,
				args: { context: "c", tasks: [{ name: " Scout ", task: "Map the code" }, { task: "Review" }] },
			},
			{ toolCallId: "task-2", result: null, timestamp: 4, args: { name: "Solo", agent: "explore", task: "Look" } },
		];
		const transcript = runTranscript([], () => true, calls);
		expect(
			transcript.agents.map(({ id, agent, status, parentToolCallId, assignment }) => ({
				id,
				agent,
				status,
				parentToolCallId,
				assignment,
			})),
		).toEqual([
			{ id: "Scout", agent: "task", status: "aborted", parentToolCallId: "task-1", assignment: "Map the code" },
			{ id: "#2", agent: "task", status: "aborted", parentToolCallId: "task-1", assignment: "Review" },
			{ id: "Solo", agent: "explore", status: "aborted", parentToolCallId: "task-2", assignment: "Look" },
		]);
		// Stock's later record of the same agent (a restored run's delivery) still settles its lane.
		const delivered = {
			...completion("<output>\nmapped\n</output>"),
			content: `<task-result id="Scout" agent="task" status="completed" duration="2s">\n<output>\nmapped\n</output>\n</task-result>`,
		};
		const settled = runTranscript([delivered], () => true, calls);
		expect(mergeRunAgents([], settled).find(node => node.id === "Scout")?.status).toBe("completed");
		// A call stock answered keeps the rows stock recorded; its arguments add nothing.
		expect(
			runTranscript([spawn, taskResult], owns, [
				{ ...calls[0], toolCallId: "task-1", result: taskResult },
			]).agents.map(node => node.id),
		).toEqual(["Reader"]);
	});

	it("measures the run from stock message timestamps, live and hydrated alike", () => {
		expect(runSpan([[spawn, taskResult], []], ["task-1"])).toEqual({ startedAt: 1_000, spanMs: 100 });
		// The live result lands in the second list; calls the run does not own never count.
		expect(runSpan([[spawn], [taskResult]], ["task-1"])).toEqual({ startedAt: 1_000, spanMs: 100 });
		expect(runSpan([[spawn, taskResult]], ["task-2"])).toEqual({ spanMs: 0 });
	});

	// 27 Oct 2026: a restart's restore revived the run's agents; omp's registry lists them without the spawning call
	// (this omp never saw it), and their lanes said "Work interrupted" for the minutes their first requests took.
	it("puts a revived agent's live row in the lane its spawn named, and leaves other unowned rows out", () => {
		const revived = { id: "Reader", index: 4, agent: "task", status: "running", lastUpdate: 2 } as SubagentNode;
		const elsewhere = { id: "Other", index: 0, agent: "task", status: "running", lastUpdate: 2 } as SubagentNode;
		const lanes = mergeRunAgents([revived, elsewhere], runTranscript([spawn, taskResult], owns));
		expect(lanes).toEqual([
			expect.objectContaining({
				id: "Reader",
				status: "running",
				index: 0,
				parentToolCallId: "task-1",
				description: "Count alpha lines",
			}),
		]);
		// A parked row (an earlier run's agent waiting for a message) leaves the lane to the transcript.
		const parked = { ...revived, status: "parked" } as SubagentNode;
		expect(mergeRunAgents([parked], runTranscript([spawn, taskResult], owns))[0]?.status).toBe("aborted");
	});

	it("names the agents the newest restart note says resumed, until each one reports back", () => {
		const note = (ids: string[], timestamp: number): AgentMessage => ({
			role: "custom",
			customType: "ompdesk-restart-subagents",
			timestamp,
			display: true,
			content: "These background agents you started are working again",
			details: { jobs: [], subagents: ids.map(id => ({ id })) },
		});
		expect([...resumedAgents([spawn, taskResult, note(["Reader", "Scout"], 2_000)])]).toEqual(["Reader", "Scout"]);
		expect([...resumedAgents([spawn, taskResult, note(["Reader", "Scout"], 2_000), completion("done")])]).toEqual([
			"Scout",
		]);
		// A delivery before the restart settled the run that was cut; the note names the run that goes on.
		expect([...resumedAgents([completion("done"), note(["Reader"], 10_000)])]).toEqual(["Reader"]);
		expect([...resumedAgents([spawn, taskResult])]).toEqual([]);
	});
});

describe("finished head and paths", () => {
	it("names the run's goal or todo title, never a lone agent's task or the reply", () => {
		expect(finishedHeadline({ goal: "Ship v2" })).toBe("Ship v2");
		expect(
			finishedHeadline({
				todo: { id: "t", ts: 0, phases: [{ name: "Audit", tasks: [{ content: "a", status: "completed" }] }] },
			}),
		).toBe("Audit");
		expect(finishedHeadline({})).toBeUndefined();
	});

	it("shows outcome paths relative to the session cwd, across the macOS /private firmlink", () => {
		expect(projectPath("/var/folders/x/project/src/app.js", "/private/var/folders/x/project")).toBe("src/app.js");
		expect(projectPath("src/app.js", "/project")).toBe("src/app.js");
		expect(projectPath("/elsewhere/a.ts", "/project")).toBe("/elsewhere/a.ts");
	});
});
