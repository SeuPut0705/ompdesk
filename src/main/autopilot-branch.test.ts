import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_CHILD_TAG,
	type AutopilotStatus,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { QUOTA_FALLBACK_MS } from "../shared/quota-reset";
import {
	afters,
	autopilot,
	build,
	clock,
	endedRoots,
	type FakeSidecar,
	installAutopilotRig,
	main,
	notices,
	runLogs,
	start,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

describe("stop", () => {
	it("an idle run stops at once: goal paused, bridge stopping, then ended, dropped, disarmed, one notice", async () => {
		await start();
		const response = await autopilot.handleCommand(
			win,
			world.sidecars.get("ap-1") as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "stop" },
			"2",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		const states = world
			.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
			.map(call => [call.params?.state, call.params?.reason]);
		expect(states).toEqual([
			["stopping", "user"],
			["ended", "user"],
		]);
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual([
			"create",
			"pause",
			"drop",
		]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(1);
		expect(notices).toEqual([expect.objectContaining({ kind: "completion", title: "Autopilot ended" })]);
		expect(autopilot.isStopping("ap-1")).toBe(false);
	});

	it("names the run's worktree for its tab and its children's, and says when the run ends", async () => {
		await start();
		const root = (await autopilot.status(world.sidecars.get("ap-1") as unknown as SidecarLike, "ap-1")).root;
		expect(root).toBeTruthy();
		expect(autopilot.runRootOf("ap-1")).toBe(root);
		expect(autopilot.runRootOf("parent")).toBeUndefined();
		world.addTab("child-1", main);
		await autopilot.beforeFirstPrompt({ tabId: "child-1", callerTabId: "ap-1", tag: AUTOPILOT_CHILD_TAG });
		expect(autopilot.runRootOf("child-1")).toBe(root);
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "stop" }, "2");
		await autopilot.idle();
		expect(endedRoots).toEqual([root]);
		expect(autopilot.runRootOf("ap-1")).toBeUndefined();
	});

	it("a run mid-turn keeps going until the bridge says the last turn settled", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.busy.add("ap-1");
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "stop" }, "2");
		await autopilot.idle();
		expect(autopilot.isStopping("ap-1")).toBe(true);
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create", "pause"]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(0);
		autopilot.frame(sidecar, { type: "autopilot_settled", reason: "user" });
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual([
			"create",
			"pause",
			"drop",
		]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(1);
		expect(notices).toHaveLength(1);
	});

	it("empties a child's queue on stop without aborting it", async () => {
		const cleared: string[] = [];
		autopilot.attachControl({ childrenOf: () => [], clearQueue: async tab => void cleared.push(tab) });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.addTab("child-1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c1"), branch: "omp/agent/x" },
		});
		world.busy.add("ap-1");
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "stop" }, "2");
		expect(cleared).toEqual(["child-1"]);
		expect(world.stock("child-1", "abort")).toHaveLength(0);
	});

	it("a stopping run refuses new sessions", async () => {
		await start();
		world.busy.add("ap-1");
		await autopilot.handleCommand(
			win,
			world.sidecars.get("ap-1") as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "stop" },
			"2",
		);
		await expect(
			autopilot.beforeFirstPrompt({ tabId: "c", callerTabId: "ap-1", tag: "autopilot-child" }),
		).rejects.toThrow(/ending/);
	});

	it("■ aborts the running children, leaves the idle ones, and journals paused user_abort", async () => {
		await start();
		for (const tab of ["child-1", "child-2"]) {
			world.addTab(tab, path.join(tmp, tab));
			await autopilot.beforeFirstPrompt({ tabId: tab, callerTabId: "ap-1", tag: "autopilot-child" });
		}
		world.busy.add("child-1");
		await autopilot.aborted("ap-1");
		expect(world.stock("child-1", "abort")).toHaveLength(1);
		expect(world.stock("child-2", "abort")).toHaveLength(0);
		expect(world.stopped).toEqual(["child-1"]);
		const last = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1);
		expect(last?.params).toMatchObject({ state: "paused", reason: "user_abort" });
		expect(notices).toEqual([]);
	});

	it("the screen's ■ (set_autopilot abort) aborts the parent's turn through stock, then pauses as user_abort", async () => {
		const { sidecar } = await start();
		world.busy.add("ap-1");
		const response = await autopilot.handleCommand(
			win,
			sidecar as unknown as SidecarLike,
			"ap-1",
			{ type: "set_autopilot", action: "abort" },
			"abort-1",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		expect(world.stock("ap-1", "abort")).toHaveLength(1);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "user_abort",
		});
	});
});

describe("stop requests from the bridge", () => {
	it("a rule's pause becomes a stock pause plus a journaled reason, with a notice by kind", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "repo_gone", detail: "/x" });
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toEqual({ action: "pause" });
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "repo_gone",
		});
		expect(notices).toEqual([
			{
				kind: "error",
				title: "Autopilot paused",
				body: "autopilot/2026-10-17: 0 cycles (0 green), 0 commits; 0 of 0 landed on main. Stopped: The repository folder is gone (/x).",
			},
		]);
		expect(runLogs.at(-1)).toMatchObject({
			message: "paused",
			details: { reason: "repo_gone", detail: "/x", cycles: 0, commits: 0, landed: 0, landTo: "main" },
		});
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "budget" });
		await autopilot.idle();
		expect(notices.at(-1)?.kind).toBe("completion");
	});

	it("the user's own pause says nothing; this computer's notifications switch does not silence the other routes", async () => {
		// The switch rules this computer's banner only (ipc.ts); the device that started the run and phones decide their own.
		build({ prefs: { notifications: false } });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "ban_violation", detail: "x" });
		await autopilot.idle();
		expect(notices.map(notice => notice.kind)).toEqual(["error"]);
		build();
		notices.length = 0;
		await start();
		const second = world.sidecars.get("ap-2") as unknown as SidecarLike;
		autopilot.frame(second, { type: "autopilot_stop_requested", reason: "user_pause" });
		await autopilot.idle();
		expect(notices).toEqual([]);
	});

	it("an end request winds the run down like a stop", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_stop_requested", reason: "agent_done", end: true });
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state)).toEqual([
			"stopping",
			"ended",
		]);
		expect(notices[0]?.body).toMatch(/declared the work done/);
	});
});

describe("a failed turn", () => {
	const failed = (message: string) => ({
		type: "idle" as const,
		tabId: "ap-1",
		outcome: { stopReason: "error", errorMessage: message },
	});

	it("asks for the next cycle once the retries leave nothing pending, and never pauses", async () => {
		await start();
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		expect(afters).toHaveLength(1);
		afters[0]?.();
		await autopilot.idle();
		expect(world.stock("ap-1", "prompt").at(-1)?.params).toMatchObject({ streamingBehavior: "followUp" });
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("a second failure inside the nudge window is asked for again once the window passes, never dropped", async () => {
		await start();
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		afters[0]?.();
		await autopilot.idle();
		const asked = () => world.stock("ap-1", "prompt").length;
		expect(asked()).toBe(1);
		// The nudge's own turn fails again a few seconds later: nothing else will ever wake the run.
		clock.value += 5_000;
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		afters[1]?.();
		await autopilot.idle();
		expect(asked()).toBe(1);
		expect(afters).toHaveLength(3);
		clock.value += 60_000;
		afters[2]?.();
		await autopilot.idle();
		expect(asked()).toBe(2);
	});

	for (const [held, hold] of [
		["paused by the user", () => ((world.statuses.get("ap-1") as AutopilotStatus).state = "paused")],
		["retried by TurnResume", () => world.scheduled.add("ap-1")],
	] as const) {
		it(`a deferred ask that comes due while the run is ${held} asks nothing`, async () => {
			await start();
			autopilot.observeActivity(failed("Provider returned 500: overloaded"));
			afters[0]?.();
			await autopilot.idle();
			clock.value += 5_000;
			autopilot.observeActivity(failed("Provider returned 500: overloaded"));
			afters[1]?.();
			await autopilot.idle();
			expect(afters).toHaveLength(3);
			hold();
			clock.value += 60_000;
			afters[2]?.();
			await autopilot.idle();
			expect(world.stock("ap-1", "prompt")).toHaveLength(1);
		});
	}

	it("a queued nudge checks the run right before it asks: one that lands after a pause asks nothing", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		// The ask was queued while the run was running; the user paused before the queue reached it.
		(world.statuses.get("ap-1") as AutopilotStatus).state = "paused";
		autopilot.frame(sidecar, { type: "autopilot_nudge", reason: "no_progress" });
		await autopilot.idle();
		expect(world.stock("ap-1", "prompt")).toHaveLength(0);
		(world.statuses.get("ap-1") as AutopilotStatus).state = "running";
		autopilot.frame(sidecar, { type: "autopilot_nudge", reason: "no_progress" });
		await autopilot.idle();
		expect(world.stock("ap-1", "prompt")).toHaveLength(1);
	});

	it("waits while TurnResume holds a scheduled retry, or a turn is running again", async () => {
		await start();
		world.scheduled.add("ap-1");
		autopilot.observeActivity(failed("fetch failed"));
		afters[0]?.();
		await autopilot.idle();
		world.scheduled.delete("ap-1");
		world.busy.add("ap-1");
		autopilot.observeActivity(failed("fetch failed"));
		afters[1]?.();
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
	});

	it("a usage limit waits in main, with no window: journals the reset, wakes at it and retries the turn", async () => {
		await start();
		world.usage = [{ provider: "anthropic", fetchedAt: clock.value, limits: [], resetAt: clock.value + 3_600_000 }];
		autopilot.observeActivity(failed("429 usage limit reached, resets at 14:20"));
		afters[0]?.();
		await autopilot.idle();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		expect(status).toMatchObject({ state: "waiting_quota", quotaResetAt: clock.value + 3_600_000 });
		expect(world.stock("ap-1", "retry")).toHaveLength(0);
		expect(afters).toHaveLength(2);
		clock.value += 3_600_000;
		afters[1]?.();
		await autopilot.idle();
		expect(status.state).toBe("running");
		expect(world.stock("ap-1", "retry")).toHaveLength(1);
		// Other tabs and endings that are no failure are left alone.
		autopilot.observeActivity({ type: "idle", tabId: "elsewhere", outcome: { stopReason: "error" } });
		autopilot.observeActivity({ type: "idle", tabId: "ap-1", outcome: { stopReason: "stop" } });
		autopilot.observeActivity({ type: "idle", tabId: "ap-1", outcome: undefined });
		expect(afters).toHaveLength(2);
	});

	it("a usage limit with no reset in the reports waits the fallback, and a pause meanwhile cancels the wake", async () => {
		await start();
		autopilot.observeActivity(failed("Too many requests"));
		afters[0]?.();
		await autopilot.idle();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		expect(status.quotaResetAt).toBe(clock.value + QUOTA_FALLBACK_MS);
		status.state = "paused";
		afters[1]?.();
		await autopilot.idle();
		expect(status.state).toBe("paused");
		expect(world.stock("ap-1", "retry")).toHaveLength(0);
	});

	it("a run that was waiting for the quota when the app quit wakes at the reset after the relaunch", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		Object.assign(status, { state: "waiting_quota", quotaResetAt: clock.value + 60_000 });
		build();
		const sidecar = world.sidecars.get("ap-1") as FakeSidecar;
		autopilot.attachSidecar("ap-1", sidecar as unknown as SidecarLike);
		sidecar.emit("status", { status: "ready" });
		await autopilot.idle();
		expect(afters.length).toBeGreaterThan(0);
		clock.value += 60_000;
		afters.at(-1)?.();
		await autopilot.idle();
		expect(status.state).toBe("running");
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toMatchObject({ action: "resume" });
	});

	it("does not pause a run that is already paused or stopping", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.state = "paused";
		autopilot.observeActivity(failed("boom"));
		afters[0]?.();
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal")).toHaveLength(1);
	});

	it("a released tab ends its run's bookkeeping", async () => {
		await start();
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "ap-1", tag: "autopilot-child" });
		autopilot.observeActivity({ type: "released", tabId: "ap-1" });
		await autopilot.idle();
		expect(world.released).toEqual(["c1"]);
	});
});
