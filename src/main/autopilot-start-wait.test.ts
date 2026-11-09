import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOPILOT_BRIDGE_METHODS } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { autopilot, errorOf, installAutopilotRig, start, win, world } from "./autopilot-test-rig";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

afterEach(() => {
	vi.useRealTimers();
});

const settle = async () => {
	for (let i = 0; i < 40; i++) await Promise.resolve();
};

/**
 * Starts a run whose new tab's omp is still starting. Resolves once the coordinator waits for it, with the start's own
 * promise; the clock is fake from the tab's creation on, so a deadline the wait carried would fire when advanced.
 */
async function startOnSlowOmp() {
	world.spawnStatus = "starting";
	const spawned = Promise.withResolvers<void>();
	world.onSpawn = () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		spawned.resolve();
	};
	const started = start();
	await spawned.promise;
	await settle();
	const tab = world.sidecars.get("ap-1");
	if (!tab) throw new Error("no run tab");
	return { started, tab };
}

describe("the Autopilot tab's omp is slow to start", () => {
	it("is waited for without a deadline: the run starts once it is ready", async () => {
		const { started, tab } = await startOnSlowOmp();
		// The coordinator's own status listener and the one waiting for `ready`.
		expect(tab.listenerCount("status")).toBe(2);

		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		expect(tab.listenerCount("status")).toBe(2);

		vi.useRealTimers();
		tab.status = "ready";
		tab.emit("status", { status: "ready" });
		const { response } = await started;
		expect(errorOf(response)).toBeUndefined();
		expect(response.success).toBe(true);
		expect(tab.listenerCount("status")).toBe(1);
	});

	it("ends when the tab closes: the start fails as a gone tab and no listener stays", async () => {
		const { started, tab } = await startOnSlowOmp();

		autopilot.observeActivity({ type: "released", tabId: "ap-1" });
		await settle();
		expect(tab.listenerCount("status")).toBe(1);

		vi.useRealTimers();
		const { response } = await started;
		expect(errorOf(response)).toBe("The Autopilot tab is gone.");
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)).toEqual([]);
	});

	it("ends when the omp fails to start", async () => {
		const { started, tab } = await startOnSlowOmp();

		tab.status = "error";
		tab.emit("status", { status: "error" });
		await settle();
		expect(tab.listenerCount("status")).toBe(1);

		vi.useRealTimers();
		const { response } = await started;
		expect(errorOf(response)).toBe("The Autopilot session failed to start.");
	});

	it("ends when the user stops the run: nothing is armed and no listener stays", async () => {
		const { started, tab } = await startOnSlowOmp();

		vi.useRealTimers();
		const stopped = await autopilot.handleCommand(
			win,
			tab as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "stop" },
			"2",
		);
		expect(stopped.success).toBe(true);
		expect(tab.listenerCount("status")).toBe(1);

		const { response } = await started;
		expect(errorOf(response)).toBe("Autopilot's start was stopped.");
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)).toEqual([]);
	});
});
