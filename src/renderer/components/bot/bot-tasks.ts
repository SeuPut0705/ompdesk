/**
 * The bot's tasks as two lists (ChatGPT dots' Activity: In progress / Completed; Duet's Tasks): what it works on now
 * and what is finished. What it will do and when is its routines' own section, never repeated here. Pure: built from
 * what the window already holds, the sessions the bot opened (`openedChildRows`), its answered or lapsed decisions and
 * the tasks the owner marked done (the desk's `tasksDone`). Only the owner completes a task (Duet): a session that
 * finished stays in progress as "Done?" until the owner marks it, so the bot's own word never closes it.
 */
import { type BotDecision, type BotDeskState, decisionExpired } from "../../../shared/bot-desk";
import type { OpenedChildRow } from "../layout/work-board/opened-children";

/** Where a task the bot opened stands. `needs`: it waits on an answer; `review`: it finished and waits on the owner's mark. */
export type TaskState = "needs" | "running" | "failed" | "review" | "done";

export type TaskItem =
	| { kind: "task"; key: string; state: TaskState; row: OpenedChildRow; unread: boolean; at: number | undefined }
	| { kind: "decision"; key: string; decision: BotDecision; outcome: "answered" | "expired"; at: number };

export interface BotTasks {
	progress: TaskItem[];
	completed: TaskItem[];
}

const PROGRESS_ORDER: Record<TaskState, number> = { needs: 0, failed: 1, running: 2, review: 3, done: 4 };

function taskState(row: OpenedChildRow, marked: boolean): TaskState {
	if (row.status === "waiting") return "needs";
	if (row.status === "running") return "running";
	if (row.status === "failed") return "failed";
	return marked ? "done" : "review";
}

export function botTasks(input: {
	rows: readonly OpenedChildRow[];
	desk: Pick<BotDeskState, "decisions" | "tasksDone">;
	/** A finished child the owner has not looked at since (its tab's unread mark). */
	unread: (row: OpenedChildRow) => boolean;
	now: number;
}): BotTasks {
	const { rows, desk, unread, now } = input;
	const done = new Set(desk.tasksDone);
	const tasks: TaskItem[] = rows.map(row => {
		const state = taskState(row, row.sessionPath !== undefined && done.has(row.sessionPath));
		return {
			kind: "task",
			key: `task:${row.key}`,
			state,
			row,
			unread: (state === "review" || state === "failed") && unread(row),
			at: row.at,
		};
	});
	const decisions = desk.decisions.flatMap((decision): TaskItem[] => {
		if (decision.state === "answered")
			return [
				{
					kind: "decision",
					key: `decision:${decision.id}`,
					decision,
					outcome: "answered",
					at: Date.parse(decision.answeredAt),
				},
			];
		if (!decisionExpired(decision, now)) return [];
		return [
			{
				kind: "decision",
				key: `decision:${decision.id}`,
				decision,
				outcome: "expired",
				at: Date.parse(decision.expiresAt ?? decision.at),
			},
		];
	});
	const stateOf = (item: TaskItem) => (item.kind === "task" ? item.state : "done");
	return {
		progress: tasks
			.filter(task => stateOf(task) !== "done")
			.sort((a, b) => PROGRESS_ORDER[stateOf(a)] - PROGRESS_ORDER[stateOf(b)] || (b.at ?? 0) - (a.at ?? 0)),
		completed: [...tasks.filter(task => stateOf(task) === "done"), ...decisions].sort(
			(a, b) => (b.at ?? 0) - (a.at ?? 0),
		),
	};
}
