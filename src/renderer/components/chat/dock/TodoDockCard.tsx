/**
 * Todo dock card: the session's todo list above the composer while no running
 * work card carries it (idle sessions, a turn that is only writing text). It
 * starts collapsed to one line (progress and the current task); expanding
 * shows the shared TodoListEditor. Renders nothing when the session has no
 * open todos and no reminder pending.
 */

import { ListTodo } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useT } from "../../../lib/i18n";
import { selectTodoCardVisible, useTodoStore } from "../../../stores/todo";
import { DockCard } from "./DockCard";
import { buildTodoDockPeek } from "./dock-summary";
import { TodoListEditor, useTodoTaskSummary } from "./TodoListEditor";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

export function TodoDockCard() {
	const t = useT();
	const { focusedCard, clearFocus } = useWorkspaceDockFocus();
	const focused = focusedCard === "todo";
	const phases = useTodoStore(state => state.phases) ?? [];
	const visible = useTodoStore(selectTodoCardVisible);
	const taskSummary = useTodoTaskSummary();
	const peek = useMemo(() => buildTodoDockPeek(phases), [phases]);

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
				<TodoListEditor />
			</div>
		</DockCard>
	);
}
