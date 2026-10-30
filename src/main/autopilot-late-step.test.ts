import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AUTOPILOT_BRIDGE_METHODS, type AutopilotStatus } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	afters,
	autopilot,
	clock,
	commit,
	installAutopilotRig,
	notices,
	record,
	remote,
	runLogs,
	start,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
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

describe("a settle that stalls while the ship queue drains", () => {
	it("the drain it started is stopped with it: no push once the settle's bound passed", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		// A push queued by the person; the turn is busy, so nothing drains it yet.
		world.busy.add("ap-1");
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "push" }, "1");
		world.busy.delete("ap-1");
		vi.useFakeTimers();
		try {
			// The drain's journal write never answers: the settle step waits inside the drain.
			world.hang.add(`bridge:${AUTOPILOT_BRIDGE_METHODS.shipAction}`);
			frame({ type: "autopilot_settled", reason: "user" });
			await vi.advanceTimersByTimeAsync(0);
			await vi.waitFor(() => expect(world.held.length).toBeGreaterThan(0));
			await vi.advanceTimersByTimeAsync(15 * 60_000);
			// The drain the settle awaited is stopped with it: its item fails now instead of running on behind it.
			const queue = (await autopilot.status(sidecar, "ap-1")).ship?.queue ?? [];
			expect(queue.map(item => item.state)).toEqual(["failed"]);
			world.hang.clear();
			for (const held of world.held.splice(0)) held.release();
			await vi.advanceTimersByTimeAsync(0);
			await autopilot.idle();
		} finally {
			vi.useRealTimers();
		}
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});
});
