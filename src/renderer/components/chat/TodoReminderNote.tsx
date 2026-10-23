import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { formatAgo, formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { TodoReminder } from "./todo-reminder";

/**
 * A persisted stock todo reminder as the line the live card showed ("Todo reminder — Needs
 * attention: N todos"); opening it lists the todos it named. Used inside a work card's notes and,
 * when no work run owns the reminder, as its own transcript row.
 */
export function TodoReminderNote({ message, reminder }: { message: AgentMessage; reminder: TodoReminder }) {
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
				onClick={() => setOpen(value => !value)}
			>
				<AlertTriangle size={12} aria-hidden="true" className="omp-todo-reminder-icon" />
				<span className="omp-work-notes-source">{t("todoPanel.reminder")}</span>
				<span className="omp-work-notes-preview">{t("todoPanel.reminderCount", { count: reminder.count })}</span>
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
			{open && (
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
			)}
		</>
	);
}
