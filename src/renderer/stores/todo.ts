import { createStore } from "zustand/vanilla";
import type { TodoPhase, TodoTask } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export interface UiTodoTask extends TodoTask {
	id: string;
}

export interface UiTodoPhase extends Omit<TodoPhase, "tasks"> {
	id: string;
	tasks: UiTodoTask[];
}

/**
 * One archived todo state: appended whenever the phases actually change after
 * the session's first hydration, rendered as a transcript snapshot row. The
 * first setPhases after a reset is hydration (get_state pull), never a
 * change; later identical re-applies (every agent_end re-pulls state) are
 * deduped by semantic fingerprint so the archive only carries real edits.
 */
export interface TodoSnapshot {
	id: string;
	ts: number;
	phases: TodoPhase[];
	/** Captured at the edit: idle changes must never rewrite a finished run. */
	duringTurn?: boolean;
	/** Separates runs and idle periods when coalescing progress updates. */
	epoch?: number;
}

/** Archive cap — the transcript keeps the newest snapshots, drops the oldest. */
const HISTORY_LIMIT = 30;

export interface TodoStore {
	phases: UiTodoPhase[];
	reminderVisible: boolean;
	reminderTodos: TodoTask[];
	/** Change archive since the session's first hydration (transcript rows). */
	history: TodoSnapshot[];
	/** False until the first post-reset setPhases — that one is hydration, not a change. */
	historyHydrated: boolean;
	/** Mirrors the session's agent run (agent_start → agent_end, or a get_state snapshot). */
	turnActive: boolean;
	historyEpoch: number;
	/**
	 * Keep an all-closed list on the dock: set when the running turn finishes it
	 * (released when that turn ends) or when the user reopens it explicitly.
	 */
	keepClosedVisible: boolean;
	setPhases: (phases: TodoPhase[]) => void;
	setTurnActive: (active: boolean) => void;
	revealClosed: () => void;
	autoClearCompleted: () => void;
	showReminder: (todos: TodoTask[]) => void;
	clearReminder: () => void;
	reset: () => void;
}

const initialState = {
	phases: [] as UiTodoPhase[],
	reminderVisible: false,
	reminderTodos: [] as TodoTask[],
	history: [] as TodoSnapshot[],
	historyHydrated: false,
	turnActive: false,
	historyEpoch: 0,
	keepClosedVisible: false,
};

function normalizePhases(phases: TodoPhase[]): UiTodoPhase[] {
	return phases.map((phase, phaseIndex) => {
		const existingPhaseId = "id" in phase && typeof phase.id === "string" ? phase.id : null;
		const phaseId = existingPhaseId ?? `phase:${phaseIndex}:${phase.name}`;
		return {
			...phase,
			id: phaseId,
			tasks: phase.tasks.map((task, taskIndex) => ({
				...task,
				id: "id" in task && typeof task.id === "string" ? task.id : `${phaseId}:task:${taskIndex}`,
			})),
		};
	});
}

/** Semantic identity of a phase list — ids are UI-assigned and must not count as change. */
function fingerprintPhases(
	phases: readonly { name: string; tasks: readonly { content: string; status: string }[] }[],
): string {
	return JSON.stringify(phases.map(phase => [phase.name, phase.tasks.map(task => [task.content, task.status])]));
}

/** Todo identity without progress — status-only changes update one transcript row. */
function fingerprintTodo(phases: readonly { name: string; tasks: readonly { content: string }[] }[]): string {
	return JSON.stringify(phases.map(phase => [phase.name, phase.tasks.map(task => task.content)]));
}

/** Pending, running, or blocked work keeps the dock card up; completed/abandoned tasks are closed. */
function hasOpenTask(phases: readonly { tasks: readonly { status: TodoTask["status"] }[] }[]): boolean {
	return phases.some(phase =>
		phase.tasks.some(task => task.status === "pending" || task.status === "in_progress" || task.status === "blocked"),
	);
}

export const createTodoStore = () =>
	createStore<TodoStore>()((set, get) => ({
		...initialState,
		setPhases: phases => {
			const state = get();
			const next = normalizePhases(phases);
			const changed = state.historyHydrated && fingerprintPhases(next) !== fingerprintPhases(state.phases);
			const live = {
				phases: next,
				historyHydrated: true,
				// A list the running turn just finished stays up until that turn ends;
				// hydrating an already-finished list (restore, turn start) does not.
				keepClosedVisible:
					next.some(phase => phase.tasks.length > 0) && (state.keepClosedVisible || (state.turnActive && changed)),
				// Progress answers the reminder, and a list without open work has nothing left to remind about.
				...(changed || !hasOpenTask(next) ? { reminderVisible: false, reminderTodos: [] } : {}),
			};
			if (!changed) {
				set(live);
				return;
			}
			const archivedPhases = next.map(phase => ({
				name: phase.name,
				tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
			}));
			const previous = state.history.at(-1);
			const snapshot: TodoSnapshot =
				previous &&
				previous.epoch === state.historyEpoch &&
				fingerprintTodo(previous.phases) === fingerprintTodo(archivedPhases)
					? { ...previous, phases: archivedPhases }
					: {
							id: `todo-snapshot-${Date.now()}-${state.history.length}`,
							ts: Date.now(),
							phases: archivedPhases,
							duringTurn: state.turnActive,
							epoch: state.historyEpoch,
						};
			const history =
				previous?.id === snapshot.id ? [...state.history.slice(0, -1), snapshot] : [...state.history, snapshot];
			if (history.length > HISTORY_LIMIT) history.shift();
			set({ ...live, history });
		},
		setTurnActive: active =>
			set(state => ({
				turnActive: active,
				historyEpoch: state.historyEpoch + Number(active !== state.turnActive),
				// The end of a turn releases the finished list it held; an idle reveal survives idle re-syncs.
				keepClosedVisible: state.keepClosedVisible && (active || !state.turnActive),
			})),
		revealClosed: () => set(state => ({ keepClosedVisible: state.phases.some(phase => phase.tasks.length > 0) })),
		autoClearCompleted: () =>
			set({
				phases: [],
				keepClosedVisible: false,
				reminderVisible: false,
				reminderTodos: [],
				historyHydrated: true,
			}),
		showReminder: todos => set({ reminderVisible: true, reminderTodos: todos }),
		clearReminder: () => set({ reminderVisible: false, reminderTodos: [] }),
		reset: () => set(initialState),
	}));

/** Whether the dock shows the todo card: open work, a list the running turn just finished, or a reminder. */
export function selectTodoCardVisible(state: TodoStore): boolean {
	return state.reminderVisible || state.keepClosedVisible || hasOpenTask(state.phases);
}

const defaultTodoStore = createTodoStore();
export const useTodoStore = createScopedStoreHook("todo", defaultTodoStore);
