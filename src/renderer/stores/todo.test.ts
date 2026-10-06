/**
 * Todo store snapshot archive: the first setPhases after a reset is session
 * hydration (never a change), later identical re-applies (every agent_end
 * re-pulls state) dedupe by semantic fingerprint, and only real edits append
 * transcript snapshots — capped so the archive keeps the newest entries.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TodoPhase } from "../../shared/rpc-types";
import { useTodoStore } from "./todo";

function phase(name: string, ...tasks: Array<[string, string]>): TodoPhase {
	return {
		name,
		tasks: tasks.map(([content, status]) => ({ content, status: status as TodoPhase["tasks"][number]["status"] })),
	};
}

afterEach(() => {
	useTodoStore.getState().reset();
});

describe("todo snapshot archive", () => {
	it("treats the first setPhases as hydration and records no snapshot", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		expect(useTodoStore.getState().history).toEqual([]);
		expect(useTodoStore.getState().historyHydrated).toBe(true);
	});

	it("appends a snapshot only when the phases semantically change", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "pending"])]);
		// Every agent_end re-pulls state with identical phases — no archive noise.
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		expect(useTodoStore.getState().history).toEqual([]);

		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["wire", "in_progress"])]);
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(1);
		expect(history[0]?.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	it("updates one snapshot while the same todo list progresses", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"], ["wire", "pending"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "in_progress"], ["wire", "pending"])]);
		const id = useTodoStore.getState().history[0]?.id;
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["wire", "completed"])]);

		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(1);
		expect(history[0]?.id).toBe(id);
		expect(history[0]?.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "completed"]);
	});

	it("records an explicit clear transition as an empty snapshot", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		useTodoStore.getState().setPhases([]);
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(1);
		expect(history[0]?.phases).toEqual([]);
	});

	it("caps the archive at the newest entries", () => {
		for (let i = 0; i < 35; i++) {
			useTodoStore.getState().setPhases([phase("Build", [`task-${i}`, "pending"])]);
		}
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(30);
		expect(history.at(-1)?.phases[0]?.tasks[0]?.content).toBe("task-34");
	});

	it("resets the archive with the session", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		expect(useTodoStore.getState().history).toHaveLength(1);
		useTodoStore.getState().reset();
		expect(useTodoStore.getState().history).toEqual([]);
		expect(useTodoStore.getState().historyHydrated).toBe(false);
	});
});
