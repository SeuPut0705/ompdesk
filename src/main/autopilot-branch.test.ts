import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_CHILD_TAG,
	type AutopilotStatus,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { QUOTA_FALLBACK_MS } from "../shared/quota-reset";
import {
	autopilot,
	build,
	commit,
	endedRoots,
	type FakeSidecar,
	installAutopilotRig,
	main,
	notices,
	record,
	remote,
	runLogs,
	sleep,
	start,
	TUNING,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
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

	it("ship, then stop: only a cycle after the choice whose work landed ends the run; a red one is told to repair", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.busy.add("ap-1");
		// Main dates the choice with its own clock as it takes the command, a moment after this; cycles that began
		// after it are a minute and two later.
		const chosen = Date.now();
		await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "stop_after_ship", enabled: true },
			"2",
		);
		const notes = () =>
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).map(call => String(call.params?.text));
		expect(notes().at(-1)).toContain("ship, then stop");
		expect((await autopilot.status(sidecar, "ap-1")).ship?.endAfterShip).toBe(true);
		const worktree = path.join(tmp, "wt-2026-10-17");
		// The cycle in flight when the person chose began before it: the run goes on.
		const early = await commit(worktree, "early.txt");
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({ commit: early, startedAt: chosen - 60_000 }),
		});
		await autopilot.idle();
		expect(autopilot.isStopping("ap-1")).toBe(false);
		// The next one ended red: nothing shipped, the choice stays on and the agent is told to repair.
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({ n: 2, verify: "red", startedAt: chosen + 60_000 }),
		});
		await autopilot.idle();
		expect(autopilot.isStopping("ap-1")).toBe(false);
		expect(notes().at(-1)).toMatch(/^Ship, then stop is still on: this cycle did not ship \(its check was red\)/);
		expect((await autopilot.status(sidecar, "ap-1")).ship?.endAfterShip).toBe(true);
		// Repaired, green, landed on main: the run ends.
		const sha = await commit(worktree, "fixed.txt");
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({ n: 3, commit: sha, startedAt: chosen + 120_000 }),
		});
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
		expect(autopilot.isStopping("ap-1")).toBe(true);
	});

	it("ship, then stop pressed again is cancelled, and a paused run resumes for it", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "pause" }, "2");
		await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "stop_after_ship", enabled: true },
			"3",
		);
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toContain("resume");
		await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "stop_after_ship", enabled: false },
			"4",
		);
		expect((await autopilot.status(sidecar, "ap-1")).ship?.endAfterShip).toBeUndefined();
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2, startedAt: Date.now() + 1 }) });
		await autopilot.idle();
		expect(autopilot.isStopping("ap-1")).toBe(false);
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
		autopilot.attachControl({ clearQueue: async tab => void cleared.push(tab) });
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
	const asked = () => world.stock("ap-1", "prompt").length;

	// The core's clock cannot be moved: the failed turn's grace and the nudge windows are the short real durations of
	// `TUNING` (`errorGraceMs` 30 ms, `errorNudgeMs` 250 ms; the window tests widen the window to 600 ms).
	it("asks for the next cycle once the retries leave nothing pending, and never pauses", async () => {
		await start();
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		await vi.waitFor(() => expect(asked()).toBe(1), { timeout: 5_000 });
		await autopilot.idle();
		expect(world.stock("ap-1", "prompt").at(-1)?.params).toMatchObject({ streamingBehavior: "followUp" });
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("a second failure inside the nudge window is asked for again once the window passes, never dropped", async () => {
		build({ tuning: { errorNudgeMs: 600 } });
		await start();
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		await vi.waitFor(() => expect(asked()).toBe(1), { timeout: 5_000 });
		// The nudge's own turn fails again a moment later: nothing else will ever wake the run.
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		await sleep((TUNING.errorGraceMs ?? 30) + 100);
		await autopilot.idle();
		expect(asked()).toBe(1);
		await vi.waitFor(() => expect(asked()).toBe(2), { timeout: 5_000 });
	});

	for (const [held, hold] of [
		["paused by the user", () => ((world.statuses.get("ap-1") as AutopilotStatus).state = "paused")],
		["retried by TurnResume", () => world.scheduled.add("ap-1")],
	] as const) {
		it(`a deferred ask that comes due while the run is ${held} asks nothing`, async () => {
			build({ tuning: { errorNudgeMs: 500 } });
			await start();
			autopilot.observeActivity(failed("Provider returned 500: overloaded"));
			await vi.waitFor(() => expect(asked()).toBe(1), { timeout: 5_000 });
			autopilot.observeActivity(failed("Provider returned 500: overloaded"));
			await sleep(150);
			await autopilot.idle();
			hold();
			// Waits out the window the ask was deferred to: the check is that nothing comes.
			await sleep(700);
			await autopilot.idle();
			expect(asked()).toBe(1);
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

	it("tells the quiet run why it went quiet, so a run whose todos are all blocked picks another item", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_nudge", reason: "blocked" });
		await autopilot.idle();
		const said = world.stock("ap-1", "prompt").map(call => call.params?.message);
		// The text is the core's (`nudge_message`, pinned there against the old table); the agent reads it.
		expect(said).toEqual([
			"Autopilot: every todo item is blocked, so the run stopped. If a cycle is open, end it with each blocker as a follow-up; then call `autopilot begin` and pick an item that is not blocked.",
		]);
	});

	it("waits while TurnResume holds a scheduled retry, or a turn is running again", async () => {
		await start();
		world.scheduled.add("ap-1");
		autopilot.observeActivity(failed("fetch failed"));
		await sleep(150);
		await autopilot.idle();
		world.scheduled.delete("ap-1");
		world.busy.add("ap-1");
		autopilot.observeActivity(failed("fetch failed"));
		await sleep(150);
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
		expect(asked()).toBe(0);
	});

	it("a usage limit waits in main, with no window: journals the reset, wakes at it and retries the turn", async () => {
		await start();
		const resetAt = Date.now() + 800;
		world.usage = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [], resetAt }];
		autopilot.observeActivity(failed("429 usage limit reached, resets at 14:20"));
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		await vi.waitFor(() => expect(status).toMatchObject({ state: "waiting_quota", quotaResetAt: resetAt }), {
			timeout: 5_000,
		});
		expect(world.stock("ap-1", "retry")).toHaveLength(0);
		await vi.waitFor(() => expect(world.stock("ap-1", "retry")).toHaveLength(1), { timeout: 5_000 });
		await autopilot.idle();
		expect(status.state).toBe("running");
		// Other tabs and endings that are no failure are left alone.
		autopilot.observeActivity({ type: "idle", tabId: "elsewhere", outcome: { stopReason: "error" } });
		autopilot.observeActivity({ type: "idle", tabId: "ap-1", outcome: { stopReason: "stop" } });
		autopilot.observeActivity({ type: "idle", tabId: "ap-1", outcome: undefined });
		await sleep(150);
		await autopilot.idle();
		expect(status.state).toBe("running");
		expect(world.stock("ap-1", "retry")).toHaveLength(1);
	});

	it("a retry that fails after the wake waits again, visibly, with a backoff that doubles up to a ceiling, until it takes", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		world.usage = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [], resetAt: Date.now() + 150 }];
		world.failRetries = 5;
		autopilot.observeActivity(failed("429 usage limit reached"));
		// The waits `TUNING` runs: 60 ms doubling to 240 ms (30 s doubling to 10 min in the app).
		const resets: number[] = [];
		await vi.waitFor(
			() => {
				const at = status.quotaResetAt;
				if (status.state === "waiting_quota" && at !== undefined && resets.at(-1) !== at) resets.push(at);
				expect(status.state).toBe("running");
				expect(world.stock("ap-1", "retry")).toHaveLength(6);
			},
			{ timeout: 10_000, interval: 5 },
		);
		expect(resets).toHaveLength(6);
		[60, 120, 240, 240, 240].forEach((least, i) => {
			const wait = (resets[i + 1] as number) - (resets[i] as number);
			expect(wait, `wait ${i + 1}`).toBeGreaterThanOrEqual(least);
			expect(wait, `wait ${i + 1}`).toBeLessThan(least + 250);
		});
		// No nudge piled on a retry that failed: the wait is the answer.
		expect(asked()).toBe(0);
	});

	it("a step of the run's pipeline that never answers is stopped, shown in the status, and the run goes on", async () => {
		// The step's bound is 400 ms here (15 min in the app); the nudge window is short so the next nudge may go at once.
		build({ tuning: { stepMaxMs: 400, errorNudgeMs: 40 } });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.hang.add("prompt");
		autopilot.observeActivity(failed("Provider returned 500: overloaded"));
		await vi.waitFor(() => expect(asked()).toBe(1), { timeout: 5_000 });
		// A step queued behind the hung nudge waits for the bound, then runs.
		world.hang.delete("prompt");
		autopilot.observeActivity(failed("fetch failed"));
		await vi.waitFor(() => expect(asked()).toBe(2), { timeout: 5_000 });
		await autopilot.idle();
		const shown = await autopilot.handleCommand(win, sidecar, "ap-1", { type: "get_autopilot" }, "1");
		expect((shown.data as AutopilotStatus).stalls).toEqual([expect.objectContaining({ step: "nudge", ms: 400 })]);
	});

	it("a usage limit with no reset in the reports waits the fallback", async () => {
		await start();
		autopilot.observeActivity(failed("Too many requests"));
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		await vi.waitFor(() => expect(status.state).toBe("waiting_quota"), { timeout: 5_000 });
		const at = status.quotaResetAt as number;
		expect(at).toBeGreaterThan(Date.now() + QUOTA_FALLBACK_MS - 10_000);
		expect(at).toBeLessThanOrEqual(Date.now() + QUOTA_FALLBACK_MS);
	});

	it("a pause meanwhile cancels the quota wake", async () => {
		await start();
		world.usage = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [], resetAt: Date.now() + 400 }];
		autopilot.observeActivity(failed("Too many requests"));
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		await vi.waitFor(() => expect(status.state).toBe("waiting_quota"), { timeout: 5_000 });
		status.state = "paused";
		// Waits out the wake: the check is that it does nothing.
		await sleep(700);
		await autopilot.idle();
		expect(status.state).toBe("paused");
		expect(world.stock("ap-1", "retry")).toHaveLength(0);
	});

	it("a run that was waiting for the quota when the app quit wakes at the reset after the relaunch", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		Object.assign(status, { state: "waiting_quota", quotaResetAt: Date.now() + 400 });
		build();
		const sidecar = world.sidecars.get("ap-1") as FakeSidecar;
		autopilot.attachSidecar("ap-1", sidecar as unknown as SidecarLike);
		sidecar.emit("status", { status: "ready" });
		await vi.waitFor(() => expect(status.state).toBe("running"), { timeout: 5_000 });
		await autopilot.idle();
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toMatchObject({ action: "resume" });
	});

	it("does not pause a run that is already paused or stopping", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.state = "paused";
		autopilot.observeActivity(failed("boom"));
		// Waits past the grace: the check is that nothing comes.
		await sleep(150);
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
