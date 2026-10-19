/**
 * Rules of the work board (`WorkBoard.tsx`): when a session pane has room for it and how its
 * rows are chosen. Pure, so the breakpoint and the sections are tested without a DOM.
 */

import type { ExtensionUIRequest, SubagentSnapshot, TodoTask } from "../../../../shared/rpc-types";
import { APPROVAL_TITLE_PREFIX } from "../../../../shared/tool-approval";
import { isApprovalRequest } from "../../../stores/extension-ui";
import { isLiveSubagentStatus } from "../../panels/subagent-graph";

/** Width of the board and the gap between it and the transcript column (components.css `--omp-board-*`). */
export const WORK_BOARD_WIDTH = 264;
export const WORK_BOARD_GAP = 24;
/** The margin the pane must leave beside the transcript column before the board takes it. */
export const WORK_BOARD_MIN_SPARE = 300;

/** `--omp-column-reading` (48rem) and the clamp of `--omp-column-pad` (16px … 3cqw … 40px), components.css. */
export const READING_COLUMN_PX = 768;
const COLUMN_PAD_MIN_PX = 16;
const COLUMN_PAD_MAX_PX = 40;
const COLUMN_PAD_RATIO = 0.03;

/** The transcript column (reading width plus its two paddings) in a pane `paneWidth` wide. */
export function transcriptColumnWidth(paneWidth: number): number {
	const pad = Math.min(COLUMN_PAD_MAX_PX, Math.max(COLUMN_PAD_MIN_PX, paneWidth * COLUMN_PAD_RATIO));
	return READING_COLUMN_PX + 2 * pad;
}

/** Whether a pane this wide leaves at least `WORK_BOARD_MIN_SPARE` px beside the transcript column. */
export function workBoardFits(paneWidth: number): boolean {
	return paneWidth - transcriptColumnWidth(paneWidth) >= WORK_BOARD_MIN_SPARE;
}

export interface TodoBoardRow {
	content: string;
	status: TodoTask["status"];
}

export interface TodoBoard {
	done: number;
	total: number;
	/** The first in-progress task, else null. */
	active: string | null;
	rows: TodoBoardRow[];
	/** Completed tasks folded away before the first shown row. */
	doneBefore: number;
	/** Tasks after the last shown row. */
	hidden: number;
	/** Every counted task's status in order, for the progress bar. */
	segments: TodoTask["status"][];
}

/** Rows the plan section lists before it folds the rest into a count. */
export const TODO_BOARD_ROWS = 7;

/**
 * The plan's progress and the tasks from the first open one on; every finished task before it folds into a count.
 * Abandoned tasks are neither done nor left to do, so they leave the count and the list.
 */
export function todoBoard(phases: readonly { tasks: readonly TodoTask[] }[]): TodoBoard | null {
	const tasks = phases.flatMap(phase => phase.tasks).filter(task => task.status !== "abandoned");
	if (tasks.length === 0) return null;
	const done = tasks.filter(task => task.status === "completed").length;
	const firstOpen = tasks.findIndex(task => task.status !== "completed");
	// A list with work left folds all finished tasks before the first open one; a finished list shows its tail.
	const start = Math.max(0, firstOpen < 0 ? tasks.length - TODO_BOARD_ROWS : firstOpen);
	const rows = tasks.slice(start, start + TODO_BOARD_ROWS).map(({ content, status }) => ({ content, status }));
	return {
		done,
		total: tasks.length,
		active: tasks.find(task => task.status === "in_progress")?.content ?? null,
		rows,
		doneBefore: start,
		hidden: Math.max(0, tasks.length - (start + rows.length)),
		segments: tasks.map(task => task.status),
	};
}

/** Live subagents (working or waiting; a finished, failed or aborted one has left the board) in spawn order. */
export function liveSubagents(subagents: ReadonlyMap<string, SubagentSnapshot>): SubagentSnapshot[] {
	const live: SubagentSnapshot[] = [];
	for (const agent of subagents.values()) if (isLiveSubagentStatus(agent.status)) live.push(agent);
	return live.sort((a, b) => a.index - b.index);
}

/** One line for a question or approval waiting on the user, in the user's language. */
export function requestLabel(
	request: ExtensionUIRequest,
	t: (key: string, params?: Record<string, string>) => string,
): string {
	switch (request.method) {
		case "select": {
			// The guard narrows to every select, so the approval's tool is read through a ternary.
			const tool = isApprovalRequest(request)
				? (request.title.slice(APPROVAL_TITLE_PREFIX.length).split("\n", 1)[0]?.trim() ?? "")
				: "";
			return tool ? t("workBoard.approve", { tool }) : request.title.trim() || t("workBoard.question");
		}
		case "confirm":
		case "input":
		case "editor":
			return request.title.trim() || t("workBoard.question");
		case "ask": {
			const first = request.questions[0];
			return first?.question.trim() || first?.header?.trim() || t("workBoard.question");
		}
		default:
			return t("workBoard.question");
	}
}
