import { describe, expect, it } from "vitest";
import { trayStatusOf } from "./use-tray-sync";

describe("trayStatusOf", () => {
	const base = { status: "ready", sessionHeld: false, awaitedInput: null, isStreaming: false } as const;

	it("reports a failed session as an error", () => {
		expect(trayStatusOf({ ...base, status: "error" })).toBe("error");
	});

	it("reports a session another omp still holds as a wait, not an error", () => {
		expect(trayStatusOf({ ...base, status: "error", sessionHeld: true })).toBe("idle");
	});

	it("puts an answer the person owes ahead of streaming", () => {
		expect(trayStatusOf({ ...base, awaitedInput: "approval", isStreaming: true })).toBe("approval");
		expect(trayStatusOf({ ...base, isStreaming: true })).toBe("streaming");
	});
});
