import { describe, expect, it, vi } from "vitest";
import { AUTOPILOT_BRIDGE_METHODS, type AutopilotStatus } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	afters,
	autopilot,
	clock,
	installAutopilotRig,
	notices,
	record,
	runLogs,
	start,
	world,
} from "./autopilot-test-rig";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

const failed = (message: string) => ({
	type: "idle" as const,
	tabId: "ap-1",
	outcome: { stopReason: "error", errorMessage: message },
});
const frame = (body: Record<string, unknown>) =>
	autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, body);

/**
 * A step of the run's pipeline stopped for running past its bound can still answer later. Each kind below holds one
 * call of the step, lets the bound stop it and the next step run, then answers the held call: the late step must change
 * nothing (no further call, no state, no notice, no log line).
 */
const KINDS: Array<{
	name: string;
	bound: number;
	begin: () => Promise<void>;
}> = [
	{
		name: "nudge",
		bound: 15 * 60_000,
		begin: async () => {
			world.hang.add("bridge:modes.autopilot_status");
			autopilot.observeActivity(failed("Provider returned 500: overloaded"));
			afters.at(-1)?.();
		},
	},
	{
		name: "stop",
		bound: 15 * 60_000,
		begin: async () => {
			world.hang.add("set_goal");
			frame({ type: "autopilot_stop_requested", reason: "time", end: false });
		},
	},
	{
		name: "settle",
		bound: 15 * 60_000,
		begin: async () => {
			world.hang.add("bridge:modes.autopilot_status");
			frame({ type: "autopilot_settled", reason: "user" });
		},
	},
	{
		name: "quota wake",
		bound: 15 * 60_000,
		begin: async () => {
			autopilot.observeActivity(failed("429 usage limit reached"));
			afters.at(-1)?.();
			await autopilot.idle();
			clock.value += 24 * 3_600_000;
			world.hang.add("bridge:modes.autopilot_status");
			afters.at(-1)?.();
		},
	},
	{
		name: "cycle end",
		bound: 4 * 60 * 60_000,
		begin: async () => {
			world.hang.add(`bridge:${AUTOPILOT_BRIDGE_METHODS.takeShipRequests}`);
			// The held answer, once it comes, asks for a push: a late step would queue and run it.
			world.requests.push({ kind: "push", quote: "", cycle: 1, at: 0 });
			frame({ type: "autopilot_cycle_end", record: record() });
		},
	},
];

describe("a pipeline step stopped at its bound that answers late", () => {
	for (const kind of KINDS) {
		it(`${kind.name}: changes nothing once the next step has started`, async () => {
			await start();
			vi.useFakeTimers();
			try {
				await kind.begin();
				await vi.advanceTimersByTimeAsync(0);
				await vi.waitFor(() => expect(world.held.length).toBeGreaterThan(0));
				// The next step queued behind it, its own calls answered at once.
				world.hang.clear();
				clock.value += 3_600_000;
				autopilot.observeActivity(failed("fetch failed"));
				afters.at(-1)?.();
				await vi.advanceTimersByTimeAsync(kind.bound);
				await autopilot.idle();
				const status = world.statuses.get("ap-1") as AutopilotStatus;
				const before = {
					calls: world.calls.length,
					state: JSON.stringify(status),
					notices: notices.length,
					logs: runLogs.length,
				};
				for (const held of world.held.splice(0)) held.release();
				await vi.advanceTimersByTimeAsync(0);
				await autopilot.idle();
				expect(world.calls.length).toBe(before.calls);
				expect(JSON.stringify(status)).toBe(before.state);
				expect(notices.length).toBe(before.notices);
				expect(runLogs.length).toBe(before.logs);
			} finally {
				vi.useRealTimers();
			}
		});
	}
});
