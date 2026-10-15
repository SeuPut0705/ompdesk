/**
 * gui-bridge goal time limit rules (resources/gui-bridge/modes/goal-time-core.ts):
 * the limit is read per goal from the journal, cleared by `null`, counted
 * against stock's `timeUsedSeconds` plus the unflushed seconds of a running
 * turn, and only ever stops an active goal.
 */
import { describe, expect, it } from "vitest";
import {
	GOAL_TIME_ENTRY_TYPE,
	goalSecondsUsed,
	goalTimeExceeded,
	parseTimeLimitMinutes,
	timeLimitFromEntries,
} from "../../resources/gui-bridge/modes/goal-time-core";

const entry = (goalId: string, seconds: number | null) => ({
	type: "custom",
	customType: GOAL_TIME_ENTRY_TYPE,
	data: { goalId, seconds },
});

describe("goal time limit", () => {
	it("reads the latest limit recorded for the goal and honours a clear", () => {
		const entries = [entry("g1", 600), { type: "message" }, entry("g2", 120), entry("g1", 1200)];
		expect(timeLimitFromEntries(entries, "g1")).toBe(1200);
		expect(timeLimitFromEntries(entries, "g2")).toBe(120);
		expect(timeLimitFromEntries(entries, "g3")).toBeUndefined();
		expect(timeLimitFromEntries([...entries, entry("g1", null)], "g1")).toBeUndefined();
		expect(
			timeLimitFromEntries([{ type: "custom", customType: "other", data: { goalId: "g1", seconds: 5 } }], "g1"),
		).toBeUndefined();
	});

	it("turns minutes into seconds, null or 0 into no limit, and refuses the rest", () => {
		expect(parseTimeLimitMinutes(30)).toBe(1800);
		expect(parseTimeLimitMinutes(0.25)).toBe(60);
		expect(parseTimeLimitMinutes(null)).toBeNull();
		expect(parseTimeLimitMinutes(0)).toBeNull();
		for (const bad of [-1, Number.NaN, "10", undefined]) expect(() => parseTimeLimitMinutes(bad)).toThrow("minutes");
	});

	it("counts the running turn's unflushed seconds, never paused time", () => {
		const goal = { id: "g1", status: "active", timeUsedSeconds: 100, updatedAt: 1_000_000 };
		expect(goalSecondsUsed(goal, false, 1_050_000)).toBe(100);
		expect(goalSecondsUsed(goal, true, 1_050_000)).toBe(150);
		expect(goalSecondsUsed({ ...goal, status: "paused" }, true, 1_050_000)).toBe(100);
		expect(goalTimeExceeded(goal, 150, true, 1_050_000)).toBe(true);
		expect(goalTimeExceeded(goal, 150, false, 1_050_000)).toBe(false);
		expect(goalTimeExceeded({ ...goal, status: "paused" }, 50, true, 1_050_000)).toBe(false);
		expect(goalTimeExceeded({ ...goal, status: "budget-limited" }, 50, true, 1_050_000)).toBe(false);
		expect(goalTimeExceeded(goal, undefined, true, 9_999_999)).toBe(false);
	});
});
