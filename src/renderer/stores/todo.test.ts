/**
 * Todo store snapshot archive: the first setPhases after a reset is session
 * hydration (never a change), later identical re-applies (every agent_end
 * re-pulls state) dedupe by semantic fingerprint, and only real edits append
 * transcript snapshots — capped so the archive keeps the newest entries.
 * Dock card visibility: open work shows; a finished list lingers only until
 * the turn that finished it ends.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TodoPhase } from "../../shared/rpc-types";
import { selectTodoCardVisible, useTodoStore } from "./todo";

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
	it("never coalesces idle progress into the preceding run's final snapshot", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "pending"], ["wire", "pending"])]);
		store.setTurnActive(true);
		store.setPhases([phase("Build", ["scaffold", "completed"], ["wire", "pending"])]);
		store.setTurnActive(false);
		const final = useTodoStore.getState().history.at(-1);
		store.setPhases([phase("Build", ["scaffold", "completed"], ["wire", "completed"])]);
		const history = useTodoStore.getState().history;
		expect(history).toHaveLength(2);
		expect(history[0]).toBe(final);
		expect(history[0]?.duringTurn).toBe(true);
		expect(history[1]?.duringTurn).toBe(false);
		expect(history[0]?.phases[0]?.tasks[1]?.status).toBe("pending");
	});
	it("starts a new archive group on the next run even with the same task list", () => {
		const store = useTodoStore.getState();
		store.setPhases([phase("Build", ["scaffold", "pending"])]);
		store.setTurnActive(true);
		store.setPhases([phase("Build", ["scaffold", "in_progress"])]);
		store.setTurnActive(false);
		store.setTurnActive(true);
		store.setPhases([phase("Build", ["scaffold", "completed"])]);
		expect(useTodoStore.getState().history).toHaveLength(2);
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

describe("todo dock card visibility", () => {
	const visible = () => selectTodoCardVisible(useTodoStore.getState());

	it("shows while any task is pending, in progress, or blocked", () => {
		for (const status of ["pending", "in_progress", "blocked"]) {
			useTodoStore.getState().reset();
			useTodoStore.getState().setPhases([phase("Build", ["done", "completed"], ["open", status])]);
			expect(visible()).toBe(true);
		}
	});

	it("hides a cleared list and a list without tasks", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		useTodoStore.getState().setPhases([]);
		expect(visible()).toBe(false);
		useTodoStore.getState().setPhases([phase("Empty")]);
		expect(visible()).toBe(false);
	});

	it("holds a list the running turn finished until that turn ends", () => {
		useTodoStore.getState().setTurnActive(true);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "in_progress"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["idea", "abandoned"])]);
		expect(visible()).toBe(true);
		useTodoStore.getState().setTurnActive(false);
		expect(visible()).toBe(false);
		// agent_end re-pulls the same finished list — it stays gone.
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["idea", "abandoned"])]);
		expect(visible()).toBe(false);
	});

	it("hides immediately when an idle edit closes the last open task", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		expect(visible()).toBe(false);
	});

	it("does not hold a finished list a new turn merely re-hydrates", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		useTodoStore.getState().setTurnActive(true);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		expect(visible()).toBe(false);
	});

	it("reveals a finished list on request until the next turn ends", () => {
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		useTodoStore.getState().revealClosed();
		expect(visible()).toBe(true);
		// Idle state snapshots do not take it away again.
		useTodoStore.getState().setTurnActive(false);
		expect(visible()).toBe(true);
		useTodoStore.getState().setTurnActive(true);
		useTodoStore.getState().setTurnActive(false);
		expect(visible()).toBe(false);
	});

	it("clears the reminder once the list progresses or has no open work", () => {
		const open = phase("Build", ["scaffold", "pending"], ["wire", "pending"]);
		useTodoStore.getState().setPhases([open]);
		useTodoStore.getState().showReminder(open.tasks);
		// Re-pulling the unchanged list keeps the reminder up.
		useTodoStore.getState().setPhases([open]);
		expect(useTodoStore.getState().reminderVisible).toBe(true);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"], ["wire", "pending"])]);
		expect(useTodoStore.getState()).toMatchObject({ reminderVisible: false, reminderTodos: [] });

		useTodoStore.getState().showReminder(open.tasks);
		useTodoStore.getState().setPhases([]);
		expect(useTodoStore.getState().reminderVisible).toBe(false);
		expect(visible()).toBe(false);
	});

	it("drops the turn and any held list on reset", () => {
		useTodoStore.getState().setTurnActive(true);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "pending"])]);
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		useTodoStore.getState().reset();
		expect(useTodoStore.getState()).toMatchObject({ turnActive: false, keepClosedVisible: false });
		useTodoStore.getState().setPhases([phase("Build", ["scaffold", "completed"])]);
		expect(visible()).toBe(false);
	});
});
