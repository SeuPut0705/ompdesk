import { describe, expect, it, vi } from "vitest";
import { AUTOPILOT_BRIDGE_METHODS } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { autopilot, errorOf, installAutopilotRig, sleep, start, win, world } from "./autopilot-test-rig";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

/**
 * Starts a run whose new tab's omp is still starting. Resolves once the coordinator waits for it, with the start's own
 * promise. The wait is the core's (`ready` of its start): it holds no timer, which a test over the real core can only show
 * by waiting a while, where the TypeScript test moved a fake clock a day on.
 */
async function startOnSlowOmp() {
	world.spawnStatus = "starting";
	const spawned = Promise.withResolvers<void>();
	world.onSpawn = () => spawned.resolve();
	const started = start();
	await spawned.promise;
	const tab = world.sidecars.get("ap-1");
	if (!tab) throw new Error("no run tab");
	// The coordinator's own status listener and the one waiting for `ready` (the core asks for it once it made the tab).
	await vi.waitFor(() => expect(tab.listenerCount("status")).toBe(2), { timeout: 5_000 });
	return { started, tab };
}

describe("the Autopilot tab's omp is slow to start", () => {
	it("is waited for without a deadline: the run starts once it is ready", async () => {
		const { started, tab } = await startOnSlowOmp();
		await sleep(400);
		expect(tab.listenerCount("status")).toBe(2);

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
		await vi.waitFor(() => expect(tab.listenerCount("status")).toBe(1), { timeout: 5_000 });

		const { response } = await started;
		expect(errorOf(response)).toBe("The Autopilot tab is gone.");
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)).toEqual([]);
	});

	it("ends when the omp fails to start", async () => {
		const { started, tab } = await startOnSlowOmp();

		tab.status = "error";
		tab.emit("status", { status: "error" });
		await vi.waitFor(() => expect(tab.listenerCount("status")).toBe(1), { timeout: 5_000 });

		const { response } = await started;
		expect(errorOf(response)).toBe("The Autopilot session failed to start.");
	});

	it("ends when the user stops the run: nothing is armed and no listener stays", async () => {
		const { started, tab } = await startOnSlowOmp();

		const stopped = await autopilot.handleCommand(
			win,
			tab as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "stop" },
			"2",
		);
		expect(stopped.success).toBe(true);
		await vi.waitFor(() => expect(tab.listenerCount("status")).toBe(1), { timeout: 5_000 });

		const { response } = await started;
		expect(errorOf(response)).toBe("Autopilot's start was stopped.");
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)).toEqual([]);
	});
});
