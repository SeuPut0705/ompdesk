/**
 * Goal time limit rules, without omp imports (src/main/bridge-goal-time.test.ts).
 * Stock goals carry a token budget only; their `timeUsedSeconds` counts wall
 * time while the goal is active (stock `goals/runtime.ts` `#flushUsageLocked`;
 * paused time never counts). OMPdesk keeps a limit in minutes per goal as a
 * journal custom entry, so it survives an omp restart and a resumed session.
 * Once the used time reaches it, modes/goal.ts reports it and main pauses the
 * goal through stock RPC `goal pause` (stock's own pause, tool set included).
 * A resume past the limit moves it one span (the length the user set) beyond
 * the time used so far, so the goal gets that much more instead of pausing
 * again on the resume itself.
 */

export const GOAL_TIME_ENTRY_TYPE = "ompdesk.goal-time-limit";

/**
 * The limit entry's data. `seconds` is the used time at which the goal pauses (`null` clears an earlier
 * limit for that goal); `span` is the length the user set, which a resume past the limit adds again
 * (absent on entries the user wrote: there it is `seconds`).
 */
export interface GoalTimeLimitEntry {
	goalId: string;
	seconds: number | null;
	span?: number;
}

interface JournalEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The goal fields the limit reads (stock `Goal`). */
export interface GoalTimeFields {
	id: string;
	status: string;
	timeUsedSeconds: number;
	updatedAt: number;
}

/** The latest limit recorded for `goalId` on the branch: when it pauses and the span it was set for, in seconds. */
function latestLimit(
	entries: readonly JournalEntryLike[],
	goalId: string,
): { seconds: number; span: number } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== GOAL_TIME_ENTRY_TYPE) continue;
		const data = entry.data as Partial<GoalTimeLimitEntry> | undefined;
		if (data?.goalId !== goalId) continue;
		if (typeof data.seconds !== "number" || data.seconds <= 0) return undefined;
		const span = typeof data.span === "number" && data.span > 0 ? data.span : data.seconds;
		return { seconds: data.seconds, span };
	}
	return undefined;
}

/** The latest limit recorded for `goalId` on the branch, in seconds. */
export function timeLimitFromEntries(entries: readonly JournalEntryLike[], goalId: string): number | undefined {
	return latestLimit(entries, goalId)?.seconds;
}

/** The length of `goalId`'s limit as the user set it, in seconds (what the "ran out" notice names). */
export function timeLimitSpanFromEntries(entries: readonly JournalEntryLike[], goalId: string): number | undefined {
	return latestLimit(entries, goalId)?.span;
}

/**
 * The entry a resume writes for a goal that has used its time: the limit moves one span past the time
 * used. Undefined while the goal is within its limit or has none.
 */
export function resumedTimeLimit(
	entries: readonly JournalEntryLike[],
	goal: Pick<GoalTimeFields, "id" | "timeUsedSeconds">,
): GoalTimeLimitEntry | undefined {
	const limit = latestLimit(entries, goal.id);
	if (!limit || goal.timeUsedSeconds < limit.seconds) return undefined;
	return { goalId: goal.id, seconds: goal.timeUsedSeconds + limit.span, span: limit.span };
}

/** `{minutes}` from the GUI → whole seconds, or `null` to clear. Anything else is refused. */
export function parseTimeLimitMinutes(minutes: unknown): number | null {
	if (minutes === null || minutes === 0) return null;
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
		throw new Error("Goal time limit must be a positive number of minutes, or null.");
	}
	return Math.max(60, Math.round(minutes * 60));
}

/**
 * Used time including what stock has not flushed yet: stock accounts wall time
 * at tool and turn boundaries, so while a turn runs the seconds since the
 * goal's last update count too.
 */
export function goalSecondsUsed(goal: GoalTimeFields, streaming: boolean, now: number): number {
	const pending = streaming && goal.status === "active" ? Math.max(0, Math.floor((now - goal.updatedAt) / 1000)) : 0;
	return goal.timeUsedSeconds + pending;
}

/** Whether an active goal with this limit has used its time. */
export function goalTimeExceeded(
	goal: GoalTimeFields,
	limitSeconds: number | undefined,
	streaming: boolean,
	now: number,
): boolean {
	if (limitSeconds === undefined || goal.status !== "active") return false;
	return goalSecondsUsed(goal, streaming, now) >= limitSeconds;
}
