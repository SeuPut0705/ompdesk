/**
 * A subagent's row keeps the `Title:` line of its ORIGINAL assignment, whatever later runs report. Frames below have
 * the shapes stock emits (`task/executor.ts`, `modes/rpc/rpc-subagents.ts`):
 * - first run: `task` is the assignment wrapped in "Complete assignment thoroughly:", `assignment` is the bare text;
 * - a follow-up to an idle subagent (`attachIrcWakeTurnMonitor`): `task` is the follow-up message, no `assignment`;
 * - the revival after a restart (`restoreSession` → `runSubagentFollowUpTurn`): `task` is `session_init.task`, the wrapped
 *   original again, no `assignment`;
 * - a snapshot taken after a follow-up (`get_subagents`): `assignment` is cleared, `task` is the follow-up.
 */
import { describe, expect, it } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress, RpcCommand, RpcResponse, SubagentProgressFrame } from "../../shared/rpc-types";
import { subagentPrimaryLabel } from "../components/panels/subagent-graph";
import { createSubagentsStore, type SubagentsStore } from "./subagents";

const ASSIGNMENT = "Title: 맥에서 7e3ec34a 확인\n\n# Target\nCheck the mac build of 7e3ec34a.";
const WRAPPED = `Complete assignment thoroughly:\n\n${ASSIGNMENT}`;
const FOLLOW_UP = "Your mac check in 7e3ec34a looked fine; now also try the arm64 build.";
const ID = "0-MacCheck";

function progress(task: string, assignment: string | undefined, status: AgentProgress["status"] = "running") {
	const body: AgentProgress = {
		index: 0,
		id: ID,
		agent: "task",
		agentSource: "bundled",
		status,
		task,
		assignment,
		description: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
	return {
		type: "subagent_progress",
		payload: {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task,
			assignment,
			detached: true,
			progress: body,
			sessionFile: "/tmp/sessions/0-MacCheck.jsonl",
		},
	} satisfies SubagentProgressFrame;
}

function lifecycle(status: "started" | "completed") {
	return {
		type: "subagent_lifecycle",
		payload: { id: ID, index: 0, agent: "task", agentSource: "bundled", status, detached: true },
	} as const;
}

const NO_TRANSCRIPT = async (command: RpcCommand): Promise<RpcResponse> => ({
	type: "response",
	command: command.type,
	success: false,
	error: "unavailable",
});

function labelOf(store: StoreApi<SubagentsStore>): string {
	const row = store.getState().subagents.get(ID);
	if (!row) throw new Error("no row");
	return subagentPrimaryLabel(row);
}

describe("a subagent row's title", () => {
	it("(a) survives a follow-up message to an idle subagent", () => {
		const store = createSubagentsStore(NO_TRANSCRIPT);
		const { applyFrame } = store.getState();
		applyFrame(lifecycle("started"));
		applyFrame(progress(WRAPPED, ASSIGNMENT));
		expect(labelOf(store)).toBe("맥에서 7e3ec34a 확인");

		applyFrame(progress(WRAPPED, ASSIGNMENT, "completed"));
		applyFrame(lifecycle("completed"));
		// The follow-up wakes it: a started frame, then progress with the message as `task` and no assignment.
		applyFrame(lifecycle("started"));
		applyFrame(progress(FOLLOW_UP, undefined));
		expect(labelOf(store)).toBe("맥에서 7e3ec34a 확인");
		expect(store.getState().subagents.get(ID)?.task).toBe(FOLLOW_UP);
	});

	it("(a) never becomes the follow-up's first line when the original is unknown", () => {
		const store = createSubagentsStore(NO_TRANSCRIPT);
		store.getState().applyFrame(progress(FOLLOW_UP, undefined));
		expect(labelOf(store)).toBe("task");
	});

	it("(b) a subagent revived after a restart reads its Title: from the wrapped original, not stock's wrapper line", () => {
		const store = createSubagentsStore(NO_TRANSCRIPT);
		const { applyFrame } = store.getState();
		// A fresh process: the first frame the GUI sees is the revival's progress, `task` the wrapped original.
		applyFrame(progress(WRAPPED, undefined));
		expect(labelOf(store)).toBe("맥에서 7e3ec34a 확인");
		expect(store.getState().subagents.get(ID)?.assignment).toBe(ASSIGNMENT);

		// A follow-up after the revival keeps it too.
		applyFrame(progress(FOLLOW_UP, undefined));
		expect(labelOf(store)).toBe("맥에서 7e3ec34a 확인");
	});

	it("(b) a revived subagent whose assignment has no Title: line reads its first line, never 'Complete assignment…'", () => {
		const store = createSubagentsStore(NO_TRANSCRIPT);
		store.getState().applyFrame(progress("Complete assignment thoroughly:\n\nList the failing tests.", undefined));
		expect(labelOf(store)).toBe("List the failing tests.");
	});

	it("(b) a roster snapshot of a revived agent reads the same", () => {
		const store = createSubagentsStore(NO_TRANSCRIPT);
		store.getState().setSnapshots([
			{
				id: ID,
				index: 0,
				agent: "task",
				status: "running",
				task: WRAPPED,
				lastUpdate: Date.now(),
			},
		]);
		expect(labelOf(store)).toBe("맥에서 7e3ec34a 확인");
	});

	it("(a) a snapshot taken after a follow-up recovers the original from the transcript's first message", async () => {
		const asked: string[] = [];
		const store = createSubagentsStore(async command => {
			asked.push(command.type);
			// Only the first prompt is read, not the whole transcript.
			expect(command).toMatchObject({ firstPrompt: true });
			if (command.type !== "get_subagent_messages") return NO_TRANSCRIPT(command);
			return {
				type: "response",
				command: command.type,
				success: true,
				data: {
					messages: [
						{ role: "user", content: [{ type: "text", text: WRAPPED }], timestamp: 1 },
						{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
						{ role: "user", content: [{ type: "text", text: FOLLOW_UP }], timestamp: 3 },
					],
				},
			};
		});
		store
			.getState()
			.setSnapshots([
				{ id: ID, index: 0, agent: "task", status: "running", task: FOLLOW_UP, lastUpdate: Date.now() },
			]);
		expect(labelOf(store)).toBe("task");
		await store.getState().recoverAssignment(ID);
		expect(labelOf(store)).toBe("맥에서 7e3ec34a 확인");
		// Once per id, found or not.
		await store.getState().recoverAssignment(ID);
		expect(asked).toEqual(["get_subagent_messages"]);
	});

	it("keeps stock's own label when the assignment has no Title: line, follow-up or not", () => {
		const store = createSubagentsStore(NO_TRANSCRIPT);
		const { applyFrame } = store.getState();
		const frame = progress(
			"Complete assignment thoroughly:\n\nInspect session switching",
			"Inspect session switching",
		);
		frame.payload.progress.description = "Inspect the session switching code";
		applyFrame(frame);
		applyFrame(progress(FOLLOW_UP, undefined));
		expect(labelOf(store)).toBe("Inspect the session switching code");
	});
});
