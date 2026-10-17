import { describe, expect, it } from "vitest";
import type { AutopilotStatus } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { createAutopilotStore, isAutopilotTab } from "./autopilot";

const running: AutopilotStatus = { active: true, state: "running", cycle: 2, branch: "autopilot/2026-10-17" };

describe("autopilot store", () => {
	it("starts as no run", () => {
		const store = createAutopilotStore();
		expect(store.getState().status).toEqual({ active: false });
		expect(store.getState().hydrated).toBe(false);
		expect(isAutopilotTab(store.getState())).toBe(false);
	});

	it("takes a whole status from a frame and counts it", () => {
		const store = createAutopilotStore();
		store.getState().apply(running);
		expect(store.getState().status).toBe(running);
		expect(store.getState().hydrated).toBe(true);
		expect(store.getState().version).toBe(1);
		expect(isAutopilotTab(store.getState())).toBe(true);
	});

	it("lets a hydration answer in only when no frame arrived since it started", () => {
		const store = createAutopilotStore();
		const startedAt = store.getState().version;
		store.getState().apply({ active: true, state: "paused", reason: "user_pause" });
		expect(store.getState().hydrateIfCurrent(startedAt, running)).toBe(false);
		expect(store.getState().status.state).toBe("paused");
		expect(store.getState().hydrateIfCurrent(store.getState().version, running)).toBe(true);
		expect(store.getState().status).toBe(running);
	});

	it("an ended run is still shown by its screen, but is not a live tab", () => {
		const store = createAutopilotStore();
		store.getState().apply({ active: true, state: "ended", reason: "user" });
		expect(isAutopilotTab(store.getState())).toBe(true);
		expect(store.getState().status.state).toBe("ended");
	});

	it("keeps the branch status and drops it with the run", () => {
		const store = createAutopilotStore();
		store.getState().apply(running);
		store.getState().setBranchStatus({ ahead: 12, behind: 0 });
		expect(store.getState().branchStatus).toEqual({ ahead: 12, behind: 0 });
		store.getState().reset();
		expect(store.getState().branchStatus).toBeNull();
		expect(store.getState().status).toEqual({ active: false });
	});
});
