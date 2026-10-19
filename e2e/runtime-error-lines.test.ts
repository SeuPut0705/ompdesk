import { describe, expect, it } from "vitest";
import { isRuntimeFailure } from "./runtime-error-lines";

describe("isRuntimeFailure", () => {
	it("counts every line of a failure source, background tasks included", () => {
		expect(isRuntimeFailure({ source: "error-toast", message: "Delete failed" })).toBe(true);
		expect(isRuntimeFailure({ source: "background-task", message: "history_record" })).toBe(true);
		expect(isRuntimeFailure({ source: "main-unhandled-rejection", message: "x" })).toBe(true);
	});

	it("leaves informational sources alone", () => {
		expect(isRuntimeFailure({ source: "startup-timing", message: "app-ready" })).toBe(false);
		expect(isRuntimeFailure({ source: "app-update", message: "check", details: { event: "no-update" } })).toBe(false);
		expect(isRuntimeFailure({ message: "no source" })).toBe(false);
	});

	it("counts a child process that did not exit cleanly", () => {
		expect(isRuntimeFailure({ source: "child-process", details: { reason: "crashed" } })).toBe(true);
		expect(isRuntimeFailure({ source: "child-process", details: { reason: "killed" } })).toBe(true);
		expect(isRuntimeFailure({ source: "child-process", details: { reason: "clean-exit" } })).toBe(false);
	});

	it("counts a remote tab that stalled or failed, not its progress steps", () => {
		expect(isRuntimeFailure({ source: "remote-tab", message: "stalled", details: { step: "ready" } })).toBe(true);
		expect(isRuntimeFailure({ source: "remote-tab", message: "failed", details: { step: "open" } })).toBe(true);
		for (const step of ["open", "start", "ready"]) {
			expect(isRuntimeFailure({ source: "remote-tab", message: step })).toBe(false);
		}
	});

	it("counts a continuation that never got going, not one that recovered or was cancelled", () => {
		const continued = (details: Record<string, unknown>) =>
			isRuntimeFailure({ source: "turn-resume", message: "continue", details });
		expect(continued({ ready: false })).toBe(true);
		expect(
			continued({ started: false, restored: "failed", restoreError: "boom", retryError: "Nothing to retry" }),
		).toBe(true);
		// The restore failed but stock's retry took the turn on: the user lost nothing.
		expect(continued({ started: true, restoreError: "boom", retried: true })).toBe(false);
		expect(continued({ started: true, restored: "turn" })).toBe(false);
		expect(continued({ ready: false, cancelled: true })).toBe(false);
		expect(isRuntimeFailure({ source: "turn-resume", message: "marker", details: { ready: false } })).toBe(false);
	});
});
