import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";

export const TODO_SUMMARY_THRESHOLD = 10;
export const TODO_COMPLETED_PREVIEW = 3;

export interface TodoDockSummary {
	phases: UiTodoPhase[];
	hiddenCount: number;
	totalCount: number;
}

/**
 * Above ten todos, keep every actionable task visible and add only the three
 * most recent completed tasks. Abandoned work is available in focused mode.
 */
export function buildTodoDockSummary(phases: UiTodoPhase[]): TodoDockSummary {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length <= TODO_SUMMARY_THRESHOLD) {
		return { phases, hiddenCount: 0, totalCount: tasks.length };
	}

	const visibleIds = new Set(
		tasks.filter(task => task.status !== "completed" && task.status !== "abandoned").map(task => task.id),
	);
	for (const task of tasks.filter(task => task.status === "completed").slice(-TODO_COMPLETED_PREVIEW)) {
		visibleIds.add(task.id);
	}

	const summaryPhases = phases
		.map(phase => ({ ...phase, tasks: phase.tasks.filter(task => visibleIds.has(task.id)) }))
		.filter(phase => phase.tasks.length > 0);
	return {
		phases: summaryPhases,
		hiddenCount: tasks.length - visibleIds.size,
		totalCount: tasks.length,
	};
}

export interface TodoDockPeek {
	done: number;
	/** Abandoned tasks never complete, so they stay out of the denominator. */
	total: number;
	/** The task being worked, else the next open one; absent once nothing is left. */
	current?: UiTodoTask;
}

/** What the collapsed todo card shows at a glance: progress and the current task. */
export function buildTodoDockPeek(phases: UiTodoPhase[]): TodoDockPeek {
	const tasks = phases.flatMap(phase => phase.tasks).filter(task => task.status !== "abandoned");
	return {
		done: tasks.filter(task => task.status === "completed").length,
		total: tasks.length,
		current:
			tasks.find(task => task.status === "in_progress") ??
			tasks.find(task => task.status === "pending" || task.status === "blocked"),
	};
}
