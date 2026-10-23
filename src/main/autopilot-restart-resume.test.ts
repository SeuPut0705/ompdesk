import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotStatus,
	DEFAULT_SHIP_POLICY,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { startSettings } from "./autopilot";
import {
	autopilot,
	build,
	commit,
	type FakeSidecar,
	installAutopilotRig,
	main,
	notices,
	record,
	remote,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";
import type { RelaunchContinuation } from "./turn-resume";

installAutopilotRig();

describe("restart", () => {
	/** A process that came up with the run `running` in the journal and stock's goal paused. */
	async function relaunched(relaunch: RelaunchContinuation, branch = "autopilot/2026-10-17"): Promise<FakeSidecar> {
		build({ relaunch });
		const sidecar = world.addTab("t1", path.join(tmp, "wt-restart"));
		world.statuses.set("t1", {
			active: true,
			state: "running",
			role: "parent",
			run: "2026-10-17",
			root: path.join(tmp, "wt-restart"),
			branch,
			baseBranch: "main",
			cycle: 3,
			settings: startSettings({}),
			cycles: [],
			ship: { policy: DEFAULT_SHIP_POLICY, queue: [] },
		});
		const exists = gitSync(main, "branch", "--list", branch) !== "";
		gitSync(
			main,
			"worktree",
			"add",
			"-q",
			...(exists ? [] : ["-b"]),
			...(exists ? [path.join(tmp, "wt-restart"), branch] : [branch, path.join(tmp, "wt-restart")]),
		);
		autopilot.attachSidecar("t1", sidecar as unknown as SidecarLike);
		sidecar.emit("status", { status: "ready" });
		await autopilot.idle();
		return sidecar;
	}

	/** Stock's goal pause first (it forgets the tool set it reattached with), then arm with resume, then the resume. */
	function expectContinued(): void {
		const steps = world
			.names("t1")
			.filter(
				name =>
					name === AUTOPILOT_BRIDGE_METHODS.arm ||
					name === "set_goal" ||
					name === AUTOPILOT_BRIDGE_METHODS.setState,
			);
		expect(steps).toEqual(["set_goal", AUTOPILOT_BRIDGE_METHODS.arm, "set_goal"]);
		expect(world.stock("t1", "set_goal").map(call => call.params)).toEqual([
			{ action: "pause" },
			{ action: "resume" },
		]);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			resume: true,
			role: "parent",
		});
	}

	it("a run on a branch the user picked goes on on that branch: the journal's branch is what is armed and pushed to", async () => {
		gitSync(main, "branch", "feature/x");
		gitSync(main, "push", "-q", "origin", "feature/x");
		const sidecar = await relaunched("now", "feature/x");
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			branch: "feature/x",
			root: path.join(tmp, "wt-restart"),
			baseBranch: "main",
		});
		// The adopted run pushes that branch, not an `autopilot/` one.
		const sha = await commit(path.join(tmp, "wt-restart"), "after-restart.txt");
		world.requests.push({ kind: "push", quote: "push now", cycle: 4, at: 1 });
		autopilot.frame(sidecar as unknown as SidecarLike, { type: "autopilot_cycle_end", record: record({ n: 4 }) });
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(sha);
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});

	it("without a launch marker (a kill between turns) the run goes on at once", async () => {
		await relaunched("now");
		expectContinued();
		expect(notices).toEqual([]);
	});

	it("a readiness judged before TurnResume's marker was in place continues once, even when resumeGoal follows", async () => {
		await relaunched("now");
		await autopilot.resumeGoal("t1");
		autopilot.resumeSettled("t1", "resumed");
		await autopilot.idle();
		expectContinued();
	});
	it("with Continue interrupted work off the run is paused with app_closed and nothing resumes by itself", async () => {
		await relaunched("off");
		expect(world.stock("t1", "set_goal").map(call => call.params?.action)).toEqual(["pause"]);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "app_closed",
		});
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)).toHaveLength(0);
		expect(notices).toEqual([]);
	});

	it("Resume continues a run paused as app_closed: arm again with resume, then stock's goal resume", async () => {
		const sidecar = await relaunched("off");
		const response = await autopilot.handleCommand(
			win,
			sidecar as unknown as SidecarLike,
			"t1",
			{ type: "set_autopilot", action: "resume" },
			"resume-1",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm).at(-1)?.params).toMatchObject({
			resume: true,
			role: "parent",
		});
		expect(world.stock("t1", "set_goal").map(call => call.params?.action)).toEqual(["pause", "resume"]);
	});

	it("with a marker the run waits for TurnResume, whose goal resume pauses, arms again, then resumes", async () => {
		await relaunched("after_restore");
		expect(world.stock("t1", "set_goal")).toHaveLength(0);
		await autopilot.resumeGoal("t1");
		autopilot.resumeSettled("t1", "resumed");
		await autopilot.idle();
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState)).toHaveLength(0);
	});

	it("arms again once even when TurnResume's goal resume comes before the readiness check has adopted the run", async () => {
		build({ relaunch: "after_restore" });
		const sidecar = world.addTab("t1", path.join(tmp, "wt-restart"));
		world.statuses.set("t1", {
			active: true,
			state: "running",
			role: "parent",
			run: "2026-10-17",
			root: path.join(tmp, "wt-restart"),
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			cycle: 3,
			settings: startSettings({}),
			cycles: [],
			ship: { policy: DEFAULT_SHIP_POLICY, queue: [] },
		});
		gitSync(main, "worktree", "add", "-q", "-b", "autopilot/2026-10-17", path.join(tmp, "wt-restart"));
		autopilot.attachSidecar("t1", sidecar as unknown as SidecarLike);
		sidecar.emit("status", { status: "ready" });
		await autopilot.resumeGoal("t1");
		await autopilot.idle();
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState)).toHaveLength(0);
	});

	it("a launch continuation that ends without resuming the goal still continues the run", async () => {
		await relaunched("after_restore");
		autopilot.resumeSettled("t1", "none");
		await autopilot.idle();
		expectContinued();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState)).toHaveLength(0);
	});

	it("the user's Stop on the Continuing toast leaves the run paused with app_closed", async () => {
		await relaunched("after_restore");
		autopilot.resumeSettled("t1", "cancelled");
		await autopilot.idle();
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.arm)).toHaveLength(0);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			reason: "app_closed",
		});
	});

	it("a goal stock cannot resume shows the run paused with app_closed, and TurnResume hears of the failure", async () => {
		await relaunched("after_restore");
		world.failGoalResume = true;
		await expect(autopilot.resumeGoal("t1")).rejects.toThrow(/No paused goal/);
		expect(world.bridgeCalls("t1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "app_closed",
		});
	});

	it("resumeGoal on a tab that is no run is stock's own resume", async () => {
		world.addTab("plain", main);
		await autopilot.resumeGoal("plain");
		expect(world.stock("plain", "set_goal")[0]?.params).toEqual({ action: "resume" });
		expect(world.names("plain", "bridge")).not.toContain(AUTOPILOT_BRIDGE_METHODS.arm);
	});

	it("does not adopt a child session or a finished run", async () => {
		build();
		const child = world.addTab("kid", main);
		world.statuses.set("kid", {
			active: true,
			state: "running",
			role: "child",
			root: main,
			branch: "x",
			settings: startSettings({}),
		});
		autopilot.attachSidecar("kid", child as unknown as SidecarLike);
		child.emit("status", { status: "ready" });
		await autopilot.idle();
		expect(world.stock("kid", "set_goal")).toHaveLength(0);
		const done = world.addTab("done", main);
		world.statuses.set("done", {
			active: true,
			state: "ended",
			role: "parent",
			root: main,
			branch: "x",
			settings: startSettings({}),
		});
		autopilot.attachSidecar("done", done as unknown as SidecarLike);
		done.emit("status", { status: "ready" });
		await autopilot.idle();
		expect(world.stock("done", "set_goal")).toHaveLength(0);
	});

	it("goes on naming its session after the cycle at work when the name is still the run's own", async () => {
		const pick = (title: string) => ({
			...(world.statuses.get("t1") as AutopilotStatus),
			now: { n: 4, startedAt: 4, area: "bugs" as const, title },
		});
		// An earlier build named it "Autopilot · <folder>": the relaunched run takes it over.
		world.sessionNames.set("t1", "Autopilot · app");
		const sidecar = await relaunched("now");
		autopilot.overlay(sidecar as unknown as SidecarLike, { type: "autopilot_update", status: pick("Fix the slug") });
		await vi.waitFor(() => expect(world.sessionNames.get("t1")).toBe("Fix the slug"));
	});

	it("leaves a name the person typed alone after a relaunch", async () => {
		world.sessionNames.set("t1", "My overnight run");
		const sidecar = await relaunched("now");
		autopilot.overlay(sidecar as unknown as SidecarLike, {
			type: "autopilot_update",
			status: {
				...(world.statuses.get("t1") as AutopilotStatus),
				now: { n: 4, startedAt: 4, title: "Fix the slug" },
			},
		});
		await autopilot.idle();
		expect(world.sessionNames.get("t1")).toBe("My overnight run");
		expect(world.stock("t1", "set_session_name")).toHaveLength(0);
	});
});
