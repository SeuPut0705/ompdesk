/**
 * Goal time limit rules, without omp imports (src/main/bridge-goal-time.test.ts).
 * Stock goals carry a token budget only; their `timeUsedSeconds` counts wall
 * time while the goal is active (stock `goals/runtime.ts` `#flushUsageLocked`;
 * paused time never counts). OMPdesk keeps a limit in minutes per goal as a
 * journal custom entry, so it survives an omp restart and a resumed session,
 * and modes/goal.ts pauses the goal through stock `pauseGoal()` once the used
 * time reaches it — the same runtime pause stock applies on a host abort.
 */

export const GOAL_TIME_ENTRY_TYPE = "ompdesk.goal-time-limit";

/** The limit entry's data. `seconds: null` clears an earlier limit for that goal. */
export interface GoalTimeLimitEntry {
	goalId: string;
	seconds: number | null;
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

/** The latest limit recorded for `goalId` on the branch, in seconds. */
export function timeLimitFromEntries(entries: readonly JournalEntryLike[], goalId: string): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== GOAL_TIME_ENTRY_TYPE) continue;
		const data = entry.data as Partial<GoalTimeLimitEntry> | undefined;
		if (data?.goalId !== goalId) continue;
		return typeof data.seconds === "number" && data.seconds > 0 ? data.seconds : undefined;
	}
	return undefined;
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
