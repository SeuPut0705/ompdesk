import { AlertTriangle, X } from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";
import type { TodoPhase } from "../../../../shared/rpc-types";
import { lazyChunk } from "../../../lib/chunk-load";
import { useT } from "../../../lib/i18n";
import { type OptimisticTarget, optimisticWrite } from "../../../lib/optimistic";
import { useTabRpc } from "../../../lib/tab-rpc";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toastError } from "../../../stores/toast";
import { type TodoStore, type UiTodoPhase, type UiTodoTask, useTodoStore } from "../../../stores/todo";
import { Button, IconButton } from "../../common";
import { buildTodoDockSummary } from "./dock-summary";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

function todoPayload(phases: UiTodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
	}));
}

const TodoSortableList = lazyChunk(() => import("./TodoSortableList").then(m => ({ default: m.TodoSortableList })));

/** The session's todo counts in one phrase ("1 running · 3 pending"). */
export function useTodoTaskSummary(): string {
	const t = useT();
	const phases = useTodoStore(state => state.phases) ?? [];
	const counts = useMemo(() => {
		const tasks = phases.flatMap(phase => phase.tasks);
		return {
			running: tasks.filter(task => task.status === "in_progress").length,
			pending: tasks.filter(task => task.status === "pending" || task.status === "blocked").length,
			completed: tasks.filter(task => task.status === "completed").length,
		};
	}, [phases]);
	return counts.running > 0 && counts.pending > 0
		? t("dock.todo.runningAndPending", counts)
		: counts.running > 0
			? t("dock.todo.running", counts)
			: counts.pending > 0
				? t("dock.todo.pending", counts)
				: t("dock.todo.completed", counts);
}

/**
 * The editable todo list: reminder, phases with drag reorder and status
 * cycling, persisted through set_todos. Shared by the dock card and the live
 * work card, so both edit the same list the same way.
 */
export function TodoListEditor() {
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const todoStore = sessionRuntimeStore<TodoStore>(tabId, "todo") ?? useTodoStore;
	const t = useT();
	const { managed, focusedCard, focusCard } = useWorkspaceDockFocus();
	const focused = focusedCard === "todo";
	const showFull = !managed || focused;
	const phases = useTodoStore(state => state.phases) ?? [];
	const reminderVisible = useTodoStore(state => state.reminderVisible) ?? false;
	const reminderTodos = useTodoStore(state => state.reminderTodos) ?? [];
	const clearReminder = useTodoStore(state => state.clearReminder);
	const setPhases = useTodoStore(state => state.setPhases);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	/* Edits go through setPhases, which archives each change as a transcript
	   snapshot — so both the optimistic value and its rollback go through it
	   instead of assigning `phases` behind the archive's back. */
	const writes = useMemo<OptimisticTarget<TodoStore>>(
		() => ({
			getState: () => todoStore.getState(),
			setState: partial => {
				if (partial.phases) setPhases(partial.phases);
				else todoStore.setState(partial);
			},
		}),
		[setPhases, todoStore],
	);

	const applyPhases = useCallback(
		(next: UiTodoPhase[]) => {
			void optimisticWrite({
				store: writes,
				mutate: () => ({ phases: next }),
				persist: () => rpc.setTodos(todoPayload(next)),
				onFailure: failure => toastError({ title: t("todoPanel.updateFailed"), error: failure }),
			});
		},
		[rpc, t, writes],
	);

	const patchTask = useCallback(
		(phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => {
			applyPhases(
				phases.map(phase =>
					phase.id !== phaseId
						? phase
						: { ...phase, tasks: phase.tasks.map(task => (task.id === taskId ? { ...task, ...patch } : task)) },
				),
			);
		},
		[phases, applyPhases],
	);

	const togglePhase = useCallback((id: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const summary = useMemo(() => buildTodoDockSummary(phases), [phases]);
	const displayedPhases = showFull ? phases : summary.phases;

	return (
		<>
			{reminderVisible && (
				<div className="mb-1.5 flex items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-warning-soft) py-1 pr-1 pl-2.5">
					<AlertTriangle aria-hidden="true" className="shrink-0 text-(--sc-warning)" size={14} />
					<div className="min-w-0 flex-1 text-sc-sm leading-snug text-(--sc-text)">
						<span className="font-medium">{t("todoPanel.reminder")}</span>
						<span className="text-(--sc-text-muted)">
							{` — ${t("todoPanel.reminderCount", { count: reminderTodos.length })}`}
						</span>
					</div>
					<IconButton icon={<X />} label={t("todoPanel.dismissReminder")} onClick={clearReminder} size="sm" />
				</div>
			)}
			{/* Lazy-chunk fallback: the header and summary already show; rows follow in a frame. */}
			<Suspense fallback={null}>
				<TodoSortableList
					collapsed={collapsed}
					displayedPhases={displayedPhases}
					onPatch={patchTask}
					onReorder={applyPhases}
					onToggle={togglePhase}
					phases={phases}
				/>
			</Suspense>
			{managed && !focused && summary.hiddenCount > 0 && (
				<Button className="mt-1 w-full" onClick={() => focusCard("todo")} size="sm" variant="ghost">
					{t("dock.viewAllTodos", { hidden: summary.hiddenCount, total: summary.totalCount })}
				</Button>
			)}
		</>
	);
}
