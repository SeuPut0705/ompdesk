import { describe, expect, it } from "vitest";
import { mergeTimings } from "./test-timings";

describe("folding a run's measurements into the record", () => {
	const record = { linux: { "a.test.ts": 100, "gone.test.ts": 40, "idle.test.ts": 7 }, win32: { "a.test.ts": 300 } };

	it("moves a file halfway to its new time, takes a new file as measured and keeps one no job ran", () => {
		const merged = mergeTimings(
			record,
			[
				{ group: "linux", files: { "a.test.ts": 60 } },
				{ group: "linux", files: { "new.test.ts": 12.34 } },
			],
			file => file !== "gone.test.ts",
		);
		expect(merged.linux).toEqual({ "a.test.ts": 80, "idle.test.ts": 7, "new.test.ts": 12.3 });
	});

	it("keeps each group's own costs, and starts a group the record did not have", () => {
		const merged = mergeTimings(record, [{ group: "e2e", files: { "e2e/a.e2e.ts": 90 } }], () => true);
		expect(merged.win32).toEqual({ "a.test.ts": 300 });
		expect(merged.linux?.["a.test.ts"]).toBe(100);
		expect(merged.e2e).toEqual({ "e2e/a.e2e.ts": 90 });
	});
});
