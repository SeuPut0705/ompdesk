import { ChevronRight, ListTodo } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { selectTodoCardVisible, type TodoSnapshot, useTodoStore } from "../../../stores/todo";
import { useUiStore } from "../../../stores/ui";
import { PanelErrorBoundary } from "../../common";
import { buildTodoDockPeek } from "../dock/dock-summary";
import { GoalDockBar } from "../dock/GoalDockBar";
import { TodoListEditor, useTodoTaskSummary } from "../dock/TodoListEditor";

/** The session's todo progress as one row of the work card; it opens the editable list in place. */
function WorkTodo() {
	const t = useT();
	const rowRef = useRef<HTMLDivElement>(null);
	const focus = useUiStore(state => state.dockFocus);
	const reminder = useTodoStore(state => state.reminderVisible);
	const [open, setOpen] = useState(() => reminder);
	const seenFocus = useRef(focus?.seq ?? 0);
	const previousReminder = useRef(reminder);
	useLayoutEffect(() => {
		const focused = focus?.id === "todo" && focus.seq > seenFocus.current;
		const reminded = reminder && !previousReminder.current;
		seenFocus.current = focus?.seq ?? seenFocus.current;
		previousReminder.current = reminder;
		if (!focused && !reminded) return;
		setOpen(true);
		rowRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [focus, reminder]);
	const phases = useTodoStore(state => state.phases) ?? [];
	const visible = useTodoStore(selectTodoCardVisible);
	const summary = useTodoTaskSummary();
	const peek = useMemo(() => buildTodoDockPeek(phases), [phases]);
	if (!visible || (peek.total === 0 && !reminder)) return null;
	const current = peek.current
		? peek.current.status === "in_progress"
			? peek.current.content
			: t("dock.todo.next", { task: peek.current.content })
		: summary;
	return (
		<div className="omp-work-todo" data-open={open} ref={rowRef}>
			{/* controls-ok: the omp-work-context-row class draws the whole row */}
			<button
				type="button"
				className="omp-work-context-row omp-work-todo-toggle"
				aria-expanded={open}
				aria-label={`${t("dock.todo")}: ${peek.done}/${peek.total} · ${current}`}
				onClick={() => setOpen(value => !value)}
			>
				<ListTodo aria-hidden className="omp-live-step-icon" />
				<span aria-hidden className="omp-work-todo-bar">
					<span style={{ width: `${peek.total ? (peek.done / peek.total) * 100 : 0}%` }} />
				</span>
				<span className="omp-work-todo-count">
					{peek.done}/{peek.total}
				</span>
				<span className="omp-work-todo-current" title={current}>
					{current}
				</span>
				<ChevronRight aria-hidden className={cx("omp-work-card-chevron", open && "rotate-90")} />
			</button>
			{open ? (
				<div className="omp-work-todo-list">
					<TodoListEditor />
				</div>
			) : null}
		</div>
	);
}

/** Archived progress is read-only, but uses the same tidy todo row as live work. */
function WorkTodoSnapshot({ snapshot }: { snapshot: TodoSnapshot }) {
	const t = useT();
	const [open, setOpen] = useState(false);
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

/**
 * What the session is working toward, shown with the running work: the active
 * goal with its controls and the todo progress. The dock above the composer
 * steps aside while this is on screen, so nothing is shown twice.
 */
export function WorkContext({ live = true, snapshot }: { live?: boolean; snapshot?: TodoSnapshot }) {
	const goal = useSessionStore(state => live && state.goal !== null);
	const todos = useTodoStore(state => live && selectTodoCardVisible(state));
	if (!live) return snapshot ? <WorkTodoSnapshot snapshot={snapshot} /> : null;
	if (!goal && !todos) return null;
	return (
		<div className="omp-work-context">
			{goal ? (
				<PanelErrorBoundary>
					<GoalDockBar inline />
				</PanelErrorBoundary>
			) : null}
			<PanelErrorBoundary>
				<WorkTodo />
			</PanelErrorBoundary>
		</div>
	);
}
