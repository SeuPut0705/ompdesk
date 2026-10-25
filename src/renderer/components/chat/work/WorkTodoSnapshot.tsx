import { ChevronRight, ListTodo } from "lucide-react";
import { useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { TodoSnapshot } from "../../../stores/todo";

/**
 * A finished card's todo progress as its own todo call recorded it: one row, read-only, opening the list in place.
 * A running card has none: the dock above the composer (and the work board) carry the live list and the goal.
 */
export function WorkTodoSnapshot({ snapshot }: { snapshot: TodoSnapshot | undefined }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	if (!snapshot) return null;
	const tasks = snapshot.phases.flatMap(phase => phase.tasks).filter(task => task.status !== "abandoned");
	const done = tasks.filter(task => task.status === "completed").length;
	return (
		<div className="omp-work-context" data-todo-snapshot={snapshot.id}>
			<div className="omp-work-todo" data-open={open}>
				{/* controls-ok: the omp-work-context-row class draws the whole row */}
				<button
					type="button"
					className="omp-work-context-row omp-work-todo-toggle"
					aria-expanded={open}
					aria-label={`${t("dock.todo")}: ${done}/${tasks.length}`}
					onClick={() => setOpen(value => !value)}
				>
					<ListTodo aria-hidden className="omp-live-step-icon" />
					<span aria-hidden className="omp-work-todo-bar">
						<span style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
					</span>
					<span className="omp-work-todo-count">
						{done}/{tasks.length}
					</span>
					<span className="omp-work-todo-current">{t("dock.todo")}</span>
					<ChevronRight aria-hidden className={cx("omp-work-card-chevron", open && "rotate-90")} />
				</button>
				{open ? (
					<ul className="omp-work-todo-list">
						{snapshot.phases.flatMap((phase, phaseIndex) =>
							phase.tasks.map((task, taskIndex) => (
								<li key={`${phaseIndex}:${taskIndex}`} data-status={task.status}>
									{task.content}
								</li>
							)),
						)}
					</ul>
				) : null}
			</div>
		</div>
	);
}
