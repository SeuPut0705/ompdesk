import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { formatAgo, formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { messageText } from "../../lib/messages";
import { Collapse } from "../common";
import type { FoldedRepeat } from "./chat-stream-utils";
import { parseTodoReminder, type TodoReminder } from "./todo-reminder";

/**
 * A persisted stock todo reminder as the line the live card showed ("Todo reminder — Needs
 * attention: N todos"); opening it lists the todos it named. Used inside a work card's notes and,
 * when no work run owns the reminder, as its own transcript row. `answer`: the reply to it that only
 * repeated the answer above (`foldRepeatedAnswers`), folded here and shown when the line opens.
 */
export function TodoReminderNote({
	message,
	reminder,
	answer,
}: {
	message: AgentMessage;
	reminder: TodoReminder;
	answer?: AgentMessage;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const age = formatAgo(message.timestamp);
	return (
		<>
			{/* controls-ok: the omp-work-notes-line class draws the whole row */}
			<button
				type="button"
				className="omp-work-notes-line"
				aria-expanded={open}
				data-todo-reminder
				data-todo-reminder-repeat={answer ? "" : undefined}
				onClick={() => setOpen(value => !value)}
			>
				<AlertTriangle size={12} aria-hidden="true" className="omp-todo-reminder-icon" />
				<span className="omp-work-notes-source">{t("todoPanel.reminder")}</span>
				<span className="omp-work-notes-preview">
					{answer ? t("todoPanel.reminderRepeat") : t("todoPanel.reminderCount", { count: reminder.count })}
				</span>
				{age && (
					<time
						className="omp-work-notes-age"
						dateTime={new Date(message.timestamp ?? 0).toISOString()}
						title={formatClock(message.timestamp)}
					>
						{age}
					</time>
				)}
			</button>
			<Collapse className="flow-root" open={open}>
				<ul className="omp-todo-reminder-list">
					{reminder.phases.map((phase, phaseIndex) => (
						<li key={`${phaseIndex}:${phase.name}`}>
							<span className="omp-todo-reminder-phase">{phase.name}</span>
							<ul>
								{phase.tasks.map((task, taskIndex) => (
									<li key={`${taskIndex}:${task}`}>{task}</li>
								))}
							</ul>
						</li>
					))}
				</ul>
				{answer && <p className="omp-todo-reminder-answer">{messageText(answer)}</p>}
			</Collapse>
		</>
	);
}

/** The reminder turns that only repeated the answer above, one folded line each, right under that answer. */
export function FoldedReminders({ repeats }: { repeats: readonly FoldedRepeat[] }) {
	const t = useT();
	return (
		<div className="omp-todo-reminder ps-(--omp-editorial-inset) pe-(--omp-editorial-edge)" data-folded-reminders>
			<ul className="omp-transcript-content omp-work-notes-list" aria-label={t("todoPanel.reminder")}>
				{repeats.map(({ reminder, answer }, index) => {
					const parsed = parseTodoReminder(reminder);
					return (
						parsed && (
							<li className="omp-work-notes-item" key={`${index}:${reminder.timestamp ?? ""}`}>
								<TodoReminderNote message={reminder} reminder={parsed} answer={answer} />
							</li>
						)
					);
				})}
			</ul>
		</div>
	);
}
