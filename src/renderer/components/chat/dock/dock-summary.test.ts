import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";
import { buildAgentDockPeek, buildTodoDockPeek, buildTodoDockSummary } from "./dock-summary";

function task(id: string, status: UiTodoTask["status"]): UiTodoTask {
	return { id, content: id, status };
}

function agent(id: string, status: string, lastUpdate: number, parentSubagentId?: string): SubagentSnapshot {
	return {
		id,
		index: Number(id.replace(/\D/g, "")) || 0,
		agent: id,
		status,
		lastUpdate,
		parentSubagentId,
	};
}

describe("dock summaries", () => {
	it("keeps every actionable todo and only the three newest completed tasks above ten items", () => {
		const phases: UiTodoPhase[] = [
			{
				id: "phase-1",
				name: "work",
				tasks: [
					task("pending", "pending"),
					task("running", "in_progress"),
					task("blocked", "blocked"),
					task("done-1", "completed"),
					task("done-2", "completed"),
					task("done-3", "completed"),
					task("done-4", "completed"),
					task("done-5", "completed"),
					task("done-6", "completed"),
					task("abandoned-1", "abandoned"),
					task("abandoned-2", "abandoned"),
				],
			},
		];

		const summary = buildTodoDockSummary(phases);
		const ids = summary.phases.flatMap(phase => phase.tasks.map(item => item.id));
		expect(ids).toEqual(["pending", "running", "blocked", "done-4", "done-5", "done-6"]);
		expect(summary).toMatchObject({ totalCount: 11, hiddenCount: 5 });
	});

	it("peeks todo progress without abandoned work and names the task being worked", () => {
		const phase = (tasks: UiTodoTask[]): UiTodoPhase[] => [{ id: "phase-1", name: "work", tasks }];
		expect(
			buildTodoDockPeek(
				phase([
					task("done", "completed"),
					task("next", "pending"),
					task("running", "in_progress"),
					task("dropped", "abandoned"),
				]),
			),
		).toMatchObject({ done: 1, total: 3, current: { id: "running" } });
		// Nothing in progress: the next open task (blocked counts) stands in.
		expect(buildTodoDockPeek(phase([task("done", "completed"), task("stuck", "blocked")])).current?.id).toBe("stuck");
		expect(buildTodoDockPeek(phase([task("done", "completed")]))).toEqual({ done: 1, total: 1, current: undefined });
	});

	it("peeks agent status counts", () => {
		const agents = [
			agent("a1", "running", 5),
			agent("a2", "parked", 9),
			agent("a3", "completed", 20),
			agent("a4", "failed", 3),
			agent("a5", "cancelled", 4),
		];
		expect(buildAgentDockPeek(agents)).toEqual({ running: 2, done: 1, failed: 1 });
	});
});
