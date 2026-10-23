import { describe, expect, it } from "vitest";
import { pickupOf } from "./pickup";

describe("pickupOf", () => {
	it("reads the verdict line before any report", () => {
		expect(
			pickupOf({
				answer: "Done.\nResult: problem — tests fail on Windows",
				report: { kind: "done", dispatch: "d1" },
				dispatch: "d1",
			}),
		).toBe("finished with a problem: tests fail on Windows");
	});

	it("takes only a report on the opener's current dispatch", () => {
		const answer = "Working on it.";
		expect(pickupOf({ answer, report: { kind: "done", dispatch: "d2" }, dispatch: "d2" })).toBe(
			"finished: reported done",
		);
		expect(pickupOf({ answer, report: { kind: "done", dispatch: "d1" }, dispatch: "d2" })).toMatch(/^ended its turn/);
		expect(pickupOf({ answer, report: { kind: "blocked", dispatch: "d2" }, dispatch: "d2" })).toBe(
			"stopped: reported blocked",
		);
	});

	it("tells a session that never answered", () => {
		expect(pickupOf({ answer: null })).toBe("has not answered yet");
	});
});
