import { describe, expect, it } from "vitest";
import { ompRestartDecision } from "./omp-restart";

describe("ompRestartDecision", () => {
	it("restarts every started, idle tab now, however it ended up idle", () => {
		for (const status of ["starting", "ready", "exited", "error", "restarting"] as const) {
			expect(ompRestartDecision({ status, busy: false })).toBe("restart");
		}
	});

	it("never touches a tab in a turn: it waits for the turn to end", () => {
		expect(ompRestartDecision({ status: "ready", busy: true })).toBe("wait");
	});

	it("leaves a tab that never started: its first spawn resolves the new omp", () => {
		expect(ompRestartDecision({ status: "asleep", busy: false })).toBe("skip");
	});
});
