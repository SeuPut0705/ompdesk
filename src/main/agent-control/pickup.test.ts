import { describe, expect, it } from "vitest";
import { pickupOf } from "./pickup";

describe("pickupOf", () => {
	it("reads the verdict line before any report", () => {
		expect(
			pickupOf({ answer: "Done.\nResult: problem — tests fail on Windows", report: { kind: "done", at: 5 } }),
		).toBe("finished with a problem: tests fail on Windows");
	});

	it("takes only a report from the current turn", () => {
		const answer = "Working on it.";
		expect(pickupOf({ answer, report: { kind: "done", at: 10 }, busySince: 5 })).toBe("finished: reported done");
		expect(pickupOf({ answer, report: { kind: "done", at: 1 }, busySince: 5 })).toMatch(/^ended its turn/);
		expect(pickupOf({ answer, report: { kind: "blocked", at: 10 }, busySince: 5 })).toBe("stopped: reported blocked");
	});

	it("tells a session that never answered", () => {
		expect(pickupOf({ answer: null })).toBe("has not answered yet");
	});
});
