import { describe, expect, it } from "vitest";
import { nextRunAt, type ScheduleDraft, type ScheduleFrequency, scheduleDraftProblem } from "./schedules";

const draft: ScheduleDraft = {
	name: "Nightly review",
	prompt: "Review yesterday's commits",
	cwd: "/work/app",
	frequency: { kind: "daily", time: "09:30", days: [] },
	model: null,
	autoApprove: false,
	enabled: true,
};

describe("nextRunAt", () => {
	it("repeats an interval from the previous start, skipping starts missed while closed", () => {
		const now = new Date(2026, 9, 15, 12, 0);
		const hourly = { kind: "interval", minutes: 60 } as const;
		expect(nextRunAt(hourly, now, null)).toEqual(new Date(2026, 9, 15, 13, 0));
		expect(nextRunAt(hourly, now, new Date(2026, 9, 15, 11, 30))).toEqual(new Date(2026, 9, 15, 12, 30));
		// The previous start is three hours back: the missed starts are skipped, not caught up.
		expect(nextRunAt(hourly, now, new Date(2026, 9, 15, 9, 0))).toEqual(new Date(2026, 9, 15, 13, 0));
	});

	it("starts a daily schedule at its local time on an allowed weekday", () => {
		const daily: ScheduleFrequency = { kind: "daily", time: "09:30", days: [] };
		expect(nextRunAt(daily, new Date(2026, 9, 15, 8, 0), null)).toEqual(new Date(2026, 9, 15, 9, 30));
		expect(nextRunAt(daily, new Date(2026, 9, 15, 9, 30), null)).toEqual(new Date(2026, 9, 16, 9, 30));
		// 2026-10-15 is a Thursday; Monday only → the 19th.
		const mondays: ScheduleFrequency = { kind: "daily", time: "09:30", days: [1] };
		expect(nextRunAt(mondays, new Date(2026, 9, 15, 8, 0), null)).toEqual(new Date(2026, 9, 19, 9, 30));
	});
});

describe("scheduleDraftProblem", () => {
	it("names the first field that keeps a draft from saving", () => {
		expect(scheduleDraftProblem(draft)).toBeNull();
		expect(scheduleDraftProblem({ ...draft, name: " " })).toBe("name");
		expect(scheduleDraftProblem({ ...draft, prompt: "" })).toBe("prompt");
		expect(scheduleDraftProblem({ ...draft, cwd: "relative/dir" })).toBe("cwd");
		expect(scheduleDraftProblem({ ...draft, cwd: "C:\\work" })).toBeNull();
		expect(scheduleDraftProblem({ ...draft, frequency: { kind: "interval", minutes: 2 } })).toBe("interval");
		expect(scheduleDraftProblem({ ...draft, frequency: { kind: "daily", time: "24:00", days: [] } })).toBe("time");
		expect(scheduleDraftProblem({ ...draft, frequency: { kind: "daily", time: "07:05", days: [7] } })).toBe("days");
	});
});
