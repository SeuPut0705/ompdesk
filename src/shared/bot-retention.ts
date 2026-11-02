/**
 * How long each of the bot's records lives (the owner's order, 2 Nov 2026: "why do the records keep piling up?"), on
 * top of each record's count cap. Main prunes at launch and every `BOT_PRUNE_EVERY_MS`; the Library, which windows
 * derive, drops its old items as it is drawn. Never the owner's own sessions: only the bot's records and the
 * conversations it ended.
 */
const DAY_MS = 24 * 60 * 60_000;

export const BOT_RETENTION_MS = {
	/** The activity log (`bot-activity.json`). */
	activity: 7 * DAY_MS,
	/** A task the owner marked done, and an answered or expired decision. */
	finished: 3 * DAY_MS,
	/** A run of an agent's schedule (still at most `SCHEDULE_RUNS_PER_SCHEDULE` per schedule). */
	routineRuns: 7 * DAY_MS,
	/** A spent one-time agent schedule whose run failed: kept so its reason can be read. A succeeded one goes at once. */
	failedOnce: DAY_MS,
	/** An unpinned Library item. */
	library: 14 * DAY_MS,
	/** A closed child's record (`agentClosedChildren`). */
	closedChildren: 7 * DAY_MS,
	/** An ended bot conversation, deleted with its sidecar files. */
	pastConversation: 7 * DAY_MS,
} as const;

/** How often main prunes the bot's records after the launch's pass. */
export const BOT_PRUNE_EVERY_MS = 60 * 60_000;

/** `iso` is older than `ms` at `now` (an unreadable time is never old: nothing is dropped on a guess). */
export function olderThan(iso: string | number | undefined, ms: number, now: number): boolean {
	const at = typeof iso === "number" ? iso : iso === undefined ? Number.NaN : Date.parse(iso);
	return Number.isFinite(at) && now - at > ms;
}
