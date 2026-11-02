import { describe, expect, it } from "vitest";
import type { SessionTab } from "../../../stores/tabs";
import { hostRowState, hostSectionSummary } from "./host-row-state";

const HOST = "dev-win";

function tab(id: string, change: Partial<SessionTab> = {}): SessionTab {
	return {
		id,
		cwd: "C:\\work",
		status: "ready",
		kind: "agent",
		unreadDone: false,
		sessionPath: `C:\\s\\${id}.jsonl`,
		device: HOST,
		...change,
	} as SessionTab;
}

describe("hostRowState", () => {
	it("reads a host's turn as running though the tab here never heard it start", () => {
		const state = hostRowState(tab("t1"), "turn");
		expect(state.running).toBe(true);
		expect(state.settling).toBe(false);
		expect(state.fold).toBe("running");
	});

	it("reads the host's background work as running, settling", () => {
		const state = hostRowState(tab("t1"), "background");
		expect(state.running).toBe(true);
		expect(state.settling).toBe(true);
	});

	it("reads a prompt the host says waits as a question, even with a tab here that shows none", () => {
		const state = hostRowState(tab("t1"), "waiting");
		expect(state.waiting).toBe(true);
		expect(state.ask).toBe("question");
		expect(state.running).toBe(false);
		expect(state.fold).toBe("question");
	});

	it("keeps what the tab here says while the host's list is silent", () => {
		expect(hostRowState(tab("t1", { status: "running" }), undefined).fold).toBe("running");
		expect(hostRowState(tab("t1", { awaitingInput: "approval" }), undefined).fold).toBe("approval");
		// Its own ask outranks the host's turn, as on a local row.
		expect(hostRowState(tab("t1", { awaitingInput: "approval" }), "turn").fold).toBe("approval");
		expect(hostRowState(tab("t1"), undefined).fold).toBeNull();
	});
});

describe("hostSectionSummary", () => {
	it("counts a session the host runs while the tab here reads it idle", () => {
		const t1 = tab("t1");
		const summary = hostSectionSummary(
			{ deviceId: HOST, live: [{ sessionPath: t1.sessionPath ?? "", state: "turn" }] },
			[t1],
			undefined,
		);
		expect(summary).toMatchObject({ running: 1, waiting: 0 });
	});

	it("leaves a session opened from this computer to its opener's section, tab and live entry alike", () => {
		const child = tab("child");
		const summary = hostSectionSummary(
			{ deviceId: HOST, live: [{ sessionPath: child.sessionPath ?? "", state: "turn" }] },
			[child],
			new Set([child.id, child.sessionPath ?? ""]),
		);
		expect(summary).toMatchObject({ running: 0, waiting: 0 });
	});
});
