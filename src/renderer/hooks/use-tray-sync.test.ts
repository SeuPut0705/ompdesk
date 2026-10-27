import { describe, expect, it } from "vitest";
import { trayStatusOf } from "./use-tray-sync";

describe("trayStatusOf", () => {
	const base = { status: "ready", sessionHeld: false, attention: null, working: false } as const;

	it("reports a failed session as an error", () => {
		expect(trayStatusOf({ ...base, status: "error" })).toBe("error");
	});

	it("reports a session another omp still holds as a wait, not an error", () => {
		expect(trayStatusOf({ ...base, status: "error", sessionHeld: true })).toBe("idle");
	});

	it("puts what the person owes ahead of streaming, by its kind", () => {
		expect(trayStatusOf({ ...base, attention: { kind: "approval", count: 1 }, working: true })).toBe("approval");
		expect(trayStatusOf({ ...base, attention: { kind: "childWaiting", count: 2 } })).toBe("childWaiting");
		expect(trayStatusOf({ ...base, working: true })).toBe("streaming");
	});
});
