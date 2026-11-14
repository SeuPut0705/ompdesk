/**
 * Contracts for what stays in Node of the tray's vocabulary: every run status has its own words, and the windows' states
 * aggregate to the loudest. The menu, its signature and the hover text moved into the shell (`chrome_core::tray`,
 * replayed against `captured/tray.json`; the live menu in `shell-host/modules/chrome-tray.test.ts`).
 */
import { describe, expect, it } from "vitest";
import MAIN_TEXT from "../../native/ompdesk/crates/shell/src/boot_core/main-text.json";
import type { TrayState } from "../shared/ipc-types";
import { aggregateProgress, aggregateTrayStatus } from "./tray-labels";

function state(overrides: Partial<TrayState> = {}): TrayState {
	return { status: "idle", language: "en", projectName: "alpha", ...overrides };
}

describe("tray status surface", () => {
	it("gives every status its own text", () => {
		const keys = [
			"statusIdle",
			"statusStreaming",
			"statusQuestion",
			"statusApproval",
			"statusChildWaiting",
			"statusError",
		] as const;
		for (const lang of ["en", "ko"] as const)
			expect(new Set(keys.map(key => MAIN_TEXT[`tray.${key}`][lang])).size).toBe(keys.length);
	});
});

describe("aggregateTrayStatus", () => {
	it("lets the loudest window win regardless of push order", () => {
		const windows = (statuses: TrayState["status"][]) => statuses.map(s => state({ status: s }));
		expect(aggregateTrayStatus(windows(["streaming", "error"]))).toBe("error");
		expect(aggregateTrayStatus(windows(["idle", "error"]))).toBe("error");
		expect(aggregateTrayStatus(windows(["approval", "streaming"]))).toBe("approval");
		expect(aggregateTrayStatus(windows(["streaming", "childWaiting"]))).toBe("childWaiting");
		expect(aggregateTrayStatus(windows(["idle", "streaming"]))).toBe("streaming");
		expect(aggregateTrayStatus(windows(["approval", "question"]))).toBe("question");
	});

	it("never lets a status it does not know hide an error or a wait", () => {
		const unknown = state({ status: "someday" as TrayState["status"] });
		expect(aggregateTrayStatus([unknown, state({ status: "error" })])).toBe("error");
		expect(aggregateTrayStatus([state({ status: "question" }), unknown])).toBe("question");
		expect(aggregateTrayStatus([unknown])).toBe("idle");
	});

	it("shows the app icon waiting while any window waits on the person, whatever another one runs", () => {
		expect(aggregateProgress(["working", "waiting"])).toBe("waiting");
		expect(aggregateProgress(["waiting", "working", "idle"])).toBe("waiting");
		expect(aggregateProgress(["idle", "working"])).toBe("working");
		expect(aggregateProgress([])).toBe("idle");
	});

	it("is idle with nothing to aggregate", () => {
		expect(aggregateTrayStatus([])).toBe("idle");
		expect(aggregateTrayStatus([state()])).toBe("idle");
	});
});
