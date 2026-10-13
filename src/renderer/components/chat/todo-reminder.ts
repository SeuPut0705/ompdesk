import type { AgentMessage } from "../../../shared/rpc-types";
import { messageText } from "../../lib/messages";

/** The incomplete todos one stock todo reminder named, grouped as stock listed them. */
export interface TodoReminder {
	count: number;
	attempt: number;
	maxAttempts: number;
	phases: Array<{ name: string; tasks: string[] }>;
}

/**
 * Stock's todo reminder (pi-coding-agent session/todo-tracker.ts `checkCompletion`): it emits the
 * `todo_reminder` event the live card shows, then persists the same reminder as an agent-attributed
 * `developer` message. Live never receives that message, so a reload must show the reminder the
 * live card showed, never its prompt text.
 */
const REMINDER =
	/^<system-reminder>\nYou stopped with (\d+) incomplete todo item\(s\):\n([\s\S]*?)\n\nPlease continue working on these tasks or mark them complete if finished\.\n\(Reminder (\d+)\/(\d+)\)\n<\/system-reminder>$/;

export function parseTodoReminder(message: AgentMessage): TodoReminder | null {
	if (message.role !== "developer") return null;
	const match = REMINDER.exec(messageText(message));
	if (!match) return null;
	const phases: TodoReminder["phases"] = [];
	for (const line of (match[2] ?? "").split("\n")) {
		const task = /^ {2}- (.*)$/.exec(line);
		if (task) phases.at(-1)?.tasks.push(task[1] ?? "");
		else if (line.startsWith("- ")) phases.push({ name: line.slice(2), tasks: [] });
	}
	return {
		count: Number(match[1]),
		attempt: Number(match[3]),
		maxAttempts: Number(match[4]),
		phases,
	};
}
