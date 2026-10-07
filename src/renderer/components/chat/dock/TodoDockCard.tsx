/**
 * Todo dock card: the live todo list rendered in the center dock above the
 * composer (previously the workspace drawer's todo tab). Phases as
 * collapsible sections, status badges, inline edit on double-click, drag
 * reorder via @dnd-kit, persisted through the set_todos RPC. Renders nothing
 * when the session has no todos and no reminder pending. The list itself
 * (TodoSortableList, which carries @dnd-kit) is fetched on the first render
 * that has todos, not at app startup.
 */

import { AlertTriangle, ListTodo, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { TodoPhase } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { type OptimisticTarget, optimisticWrite } from "../../../lib/optimistic";
import { useTabRpc } from "../../../lib/tab-rpc";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toastError } from "../../../stores/toast";
import {
	selectTodoCardVisible,
	type TodoStore,
	type UiTodoPhase,
	type UiTodoTask,
	useTodoStore,
} from "../../../stores/todo";
import { Button, IconButton } from "../../common";
import { DockCard } from "./DockCard";
import { buildTodoDockPeek, buildTodoDockSummary } from "./dock-summary";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

function todoPayload(phases: UiTodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
	}));
}

const TodoSortableList = lazy(() => import("./TodoSortableList").then(m => ({ default: m.TodoSortableList })));

export function TodoDockCard() {
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const todoStore = sessionRuntimeStore<TodoStore>(tabId, "todo") ?? useTodoStore;
	const t = useT();
	const { managed, focusedCard, focusCard, clearFocus } = useWorkspaceDockFocus();
	const focused = focusedCard === "todo";
	const showFull = !managed || focused;
	const phases = useTodoStore(state => state.phases) ?? [];
	const visible = useTodoStore(selectTodoCardVisible);
	const reminderVisible = useTodoStore(state => state.reminderVisible) ?? false;
	const reminderTodos = useTodoStore(state => state.reminderTodos) ?? [];
	const clearReminder = useTodoStore(state => state.clearReminder);
	const setPhases = useTodoStore(state => state.setPhases);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	/* The dock edits through setPhases, which archives each change as a
	   transcript snapshot — so both the optimistic value and its rollback go
	   through it instead of assigning `phases` behind the archive's back. */
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
			const next = phases.map(phase =>
				phase.id !== phaseId
					? phase
					: {
							...phase,
							tasks: phase.tasks.map(task => (task.id === taskId ? { ...task, ...patch } : task)),
						},
			);
			applyPhases(next);
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

	const taskCounts = useMemo(() => {
		const tasks = phases.flatMap(phase => phase.tasks);
		return {
			running: tasks.filter(task => task.status === "in_progress").length,
			pending: tasks.filter(task => task.status === "pending" || task.status === "blocked").length,
			completed: tasks.filter(task => task.status === "completed").length,
		};
	}, [phases]);
	const taskSummary =
		taskCounts.running > 0 && taskCounts.pending > 0
			? t("dock.todo.runningAndPending", taskCounts)
			: taskCounts.running > 0
				? t("dock.todo.running", taskCounts)
				: taskCounts.pending > 0
					? t("dock.todo.pending", taskCounts)
					: t("dock.todo.completed", taskCounts);
	const summary = useMemo(() => buildTodoDockSummary(phases), [phases]);
	const peek = useMemo(() => buildTodoDockPeek(phases), [phases]);
	const displayedPhases = showFull ? phases : summary.phases;

	useEffect(() => {
		if (focused && !visible) clearFocus();
	}, [clearFocus, focused, visible]);

	if (!visible) return null;

	return (
		<DockCard
			badge={<span className="min-w-0 truncate tabular-nums">{taskSummary}</span>}
			icon={ListTodo}
			id="todo"
			peek={
				peek.total > 0 ? (
					<>
						<span
							aria-hidden="true"
							className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-(--sc-radius-full) bg-(--sc-border)"
						>
							<span
								className="absolute inset-y-0 left-0 rounded-(--sc-radius-full) bg-(--sc-accent) transition-[width] duration-(--sc-duration-med)"
								style={{ width: `${(peek.done / peek.total) * 100}%` }}
							/>
						</span>
						<span className="shrink-0 tabular-nums">
							{peek.done}/{peek.total}
						</span>
						{peek.current && (
							<span className="min-w-0 truncate text-(--sc-text-secondary)" title={peek.current.content}>
								{peek.current.status === "in_progress"
									? peek.current.content
									: t("dock.todo.next", { task: peek.current.content })}
							</span>
						)}
					</>
				) : undefined
			}
			title={t("dock.todo")}
		>
			<div className="px-2 py-1.5">
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
				{/* Lazy-chunk fallback: the card header and summary already show; rows follow in a frame. */}
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
			</div>
		</DockCard>
	);
}
