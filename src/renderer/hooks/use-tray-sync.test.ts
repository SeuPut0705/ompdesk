import { describe, expect, it } from "vitest";
import { sessionRun } from "../lib/session-run";
import { trayStatusOf } from "./use-tray-sync";

describe("trayStatusOf", () => {
	const ready = sessionRun({ status: "ready" });

	it("reports a failed session as an error", () => {
		expect(trayStatusOf(sessionRun({ status: "error" }), null)).toBe("error");
	});

	it("reports a session another omp still holds as a wait, not an error", () => {
		expect(trayStatusOf(sessionRun({ status: "error", sessionHeld: true }), null)).toBe("idle");
	});

	it("puts what the person owes ahead of streaming, by its kind", () => {
		expect(trayStatusOf(sessionRun({ status: "running" }), { kind: "approval", count: 1 })).toBe("approval");
		expect(trayStatusOf(ready, { kind: "childWaiting", count: 2 })).toBe("childWaiting");
		expect(trayStatusOf(sessionRun({ status: "running" }), null)).toBe("streaming");
	});

	it("reads a compaction between turns as work, as the session's row does", () => {
		expect(trayStatusOf(sessionRun({ status: "ready", compacting: true }), null)).toBe("streaming");
		expect(trayStatusOf(ready, null)).toBe("idle");
	});
});
