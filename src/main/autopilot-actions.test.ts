import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotArmParams,
	type AutopilotStatus,
	DEFAULT_SHIP_POLICY,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { ExtensionUIRequest } from "../shared/rpc-types";
import { RELEASE_NOW_MESSAGE, startSettings } from "./autopilot";
import {
	autopilot,
	build,
	clock,
	commit,
	dataOf,
	errorOf,
	type FakeSidecar,
	installAutopilotRig,
	main,
	notices,
	polls,
	record,
	remote,
	setReleaseState,
	start,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";
import type { RelaunchContinuation } from "./turn-resume";

installAutopilotRig();

describe("ship actions from the screen", () => {
	it("queues a revert for the cycle's commit and runs it at once between turns, then marks the cycle", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = [record({ n: 5, commit: sha })];
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const response = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 5 },
			"9",
		);
		expect(response.success).toBe(true);
		await autopilot.idle();
		await expect(fs.stat(path.join(worktree, "a.txt"))).rejects.toThrow();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.markReverted)[0]?.params).toEqual({ cycle: 5 });
	});

	it("a cycle end that outlives the next cycle's start pushes its own commit and leaves later items for that turn's end", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.now = { n: 2, startedAt: 1 };
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		clock.value = 20;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 1, commit: sha }) });
		clock.value = 30;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "pr" }, "1");
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
		const queue = (await autopilot.status(sidecar, "ap-1")).ship?.queue ?? [];
		expect(queue.map(item => `${item.kind}:${item.state}`).sort()).toEqual(["pr:queued", "push:done"]);
		status.now = undefined;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect((await autopilot.status(sidecar, "ap-1")).ship?.queue.find(item => item.kind === "pr")?.state).toBe(
			"done",
		);
	});

	it("keeps two consecutive actions queued while the journal shows a cycle in flight, even if the pool says idle", async () => {
		await start();
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.now = { n: 2, startedAt: 1 };
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "push" }, "1");
		const second = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "pr" },
			"2",
		);
		await autopilot.idle();
		expect(dataOf<AutopilotStatus>(second).ship?.queue.map(item => [item.kind, item.state])).toEqual([
			["push", "queued"],
			["pr", "queued"],
		]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)).toHaveLength(0);
		status.now = undefined;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction).length).toBeGreaterThan(0);
	});

	it("holds an item queued while a turn runs and runs it at that turn's end", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = [record({ n: 5, commit: sha })];
		world.busy.add("ap-1");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const response = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 5 },
			"9",
		);
		const queue = dataOf<AutopilotStatus>(response).ship?.queue;
		expect(queue).toEqual([expect.objectContaining({ kind: "revert", state: "queued", cycle: 5 })]);
		await expect(fs.stat(path.join(worktree, "a.txt"))).resolves.toBeTruthy();
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 6 }) });
		await autopilot.idle();
		await expect(fs.stat(path.join(worktree, "a.txt"))).rejects.toThrow();
	});

	it("refuses a revert of a cycle without a commit, and cancels a queued item", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = [record({ n: 2 })];
		const refused = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 2 },
			"1",
		);
		expect(errorOf(refused)).toMatch(/no commit/);
		world.busy.add("ap-1");
		const queued = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "push" },
			"2",
		);
		const id = dataOf<AutopilotStatus>(queued).ship?.queue[0]?.id ?? "";
		const cancelled = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "cancel_ship", id },
			"3",
		);
		expect(dataOf<AutopilotStatus>(cancelled).ship?.queue).toEqual([]);
	});

	it("the auto release toggle configures the bridge only with a procedure", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const refused = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "auto_release", enabled: true },
			"2",
		);
		expect(errorOf(refused)).toMatch(/release procedure/i);
	});

	it("Release sends the user's own words as a follow-up and shows a tracked item", async () => {
		build({ releaseProcedure: true });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const response = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "release" },
			"1",
		);
		expect(dataOf<AutopilotStatus>(response).ship?.queue).toEqual([
			expect.objectContaining({ kind: "release", state: "running" }),
		]);
		expect(world.stock("ap-1", "prompt")[0]?.params).toEqual({
			message: RELEASE_NOW_MESSAGE,
			streamingBehavior: "followUp",
		});
	});
});

describe("release run", () => {
	async function reported(): Promise<SidecarLike> {
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({
				area: "release",
				ship: { kind: "release", version: "1.2.3", runUrl: "https://github.com/o/r/actions/runs/9" },
			}),
		});
		await autopilot.idle();
		return sidecar;
	}

	it("follows the run every 15 s and reports success", async () => {
		await reported();
		expect(world.releaseCalls("ap-1").at(-1)?.params).toEqual({
			release: { version: "1.2.3", runUrl: "https://github.com/o/r/actions/runs/9", state: "pending" },
		});
		expect(polls).toHaveLength(1);
		setReleaseState({ status: "in_progress", conclusion: null });
		polls[0]?.run();
		await autopilot.idle();
		expect(polls[0]?.stopped).toBe(false);
		setReleaseState({ status: "completed", conclusion: "success" });
		polls[0]?.run();
		await autopilot.idle();
		await autopilot.idle();
		expect(polls[0]?.stopped).toBe(true);
		expect(world.releaseCalls("ap-1").at(-1)?.params).toMatchObject({
			release: { state: "success" },
		});
		expect(notices.at(-1)).toEqual({
			kind: "completion",
			title: "Autopilot release",
			body: "Release 1.2.3 succeeded.",
		});
	});

	it("a failed run is reported and handed to the next cycle: the run is not paused", async () => {
		await reported();
		setReleaseState({ status: "completed", conclusion: "failure" });
		polls[0]?.run();
		await autopilot.idle();
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params?.state).not.toBe("paused");
		expect(notices.map(notice => notice.kind)).toContain("error");
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/release run of 1\.2\.3 failed/,
		);
		// The status the sheet shows keeps which release failed.
		expect(world.releaseCalls("ap-1").at(-1)?.params).toMatchObject({
			release: { version: "1.2.3", state: "failure" },
		});
	});

	it("a release without a run to watch is recorded as done", async () => {
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ area: "release", ship: { kind: "release", version: "1.2.3" } }),
		});
		await autopilot.idle();
		expect(polls).toHaveLength(0);
		expect(world.releaseCalls("ap-1").at(-1)?.params).toEqual({
			release: { version: "1.2.3", state: "success" },
		});
	});

	it("opens the audit's release scope while auto release is on: the default branch push is no violation", async () => {
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		gitSync(worktree, "push", "-q", "origin", "HEAD:main");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ area: "release" }),
		});
		await autopilot.idle();
		expect(
			world
				.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
				.some(call => call.params?.reason === "ban_violation"),
		).toBe(false);
	});
});

describe("status overlay", () => {
	it("adds the live children and the ship queue to the bridge's update, for a run only", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.addTab("child-1", path.join(tmp, "c"));
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c"), branch: "omp/agent/c" },
		});
		world.busy.add("child-1");
		const base = world.statuses.get("ap-1") as AutopilotStatus;
		const frame = { type: "autopilot_update", status: base };
		const out = autopilot.overlay(sidecar, frame) as { status: AutopilotStatus };
		expect(out.status.children).toEqual([{ tabId: "child-1", branch: "omp/agent/c", status: "running" }]);
		expect(out.status.ship?.queue).toEqual([]);
		expect(autopilot.overlay(world.addTab("other", main), frame)).toBe(frame);
		const inactive = { type: "autopilot_update", status: { active: false } };
		expect(autopilot.overlay(sidecar, inactive)).toBe(inactive);
	});

	it("asks the bridge to re-emit after a child opens", async () => {
		await start();
		const before = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.configure).length;
		world.addTab("child-1", path.join(tmp, "c"));
		await autopilot.beforeFirstPrompt({ tabId: "child-1", callerTabId: "ap-1", tag: "autopilot-child" });
		await autopilot.idle();
		const emptied = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.configure).slice(before);
		expect(emptied.length).toBeGreaterThan(0);
		expect(emptied.every(call => Object.keys(call.params ?? {}).length === 0)).toBe(true);
	});
});

describe("children", () => {
	it("arms a tagged child before its first prompt with a local-only policy, and ignores other sessions", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "release" }).catch(() => undefined);
		build({ releaseProcedure: true });
		await start({ type: "set_autopilot", action: "start", preset: "release" });
		const parentTab = [...world.sidecars.keys()].find(tab => tab.startsWith("ap-")) ?? "ap-1";
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({
			tabId: "c1",
			callerTabId: parentTab,
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c1"), branch: "omp/agent/c1" },
		});
		const arm = world.bridgeCalls("c1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params as unknown as AutopilotArmParams;
		expect(arm).toMatchObject({ role: "child", root: path.join(tmp, "c1"), parentTab, branch: "omp/agent/c1" });
		expect(arm.settings.ship).toEqual({ ...DEFAULT_SHIP_POLICY, remote: "origin" });
		expect(arm.settings.limits).toEqual({ tokens: null, minutes: null, cycles: null, usd: null });
		// A session some other tab opened is none of the run's business.
		world.addTab("plain", main);
		await autopilot.beforeFirstPrompt({ tabId: "plain", callerTabId: "somebody-else" });
		expect(world.bridgeCalls("plain", AUTOPILOT_BRIDGE_METHODS.arm)).toHaveLength(0);
		// The tool path (`ompdesk_session_open`) passes no tag: whatever the run's tab opens is its child.
		world.addTab("untagged", path.join(tmp, "u"));
		await autopilot.beforeFirstPrompt({ tabId: "untagged", callerTabId: parentTab });
		expect(world.bridgeCalls("untagged", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			role: "child",
			parentTab,
		});
	});

	it("allows no more parallel children than the run's setting", async () => {
		await start({ type: "set_autopilot", action: "start", maxParallel: 1 });
		for (const tab of ["c1", "c2"]) world.addTab(tab, path.join(tmp, tab));
		await autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "ap-1", tag: "autopilot-child" });
		await expect(
			autopilot.beforeFirstPrompt({ tabId: "c2", callerTabId: "ap-1", tag: "autopilot-child" }),
		).rejects.toThrow(/at most 1/);
	});

	it("refuses a tagged child whose parent is no run", async () => {
		world.addTab("c1", main);
		await expect(
			autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "nobody", tag: "autopilot-child" }),
		).rejects.toThrow();
	});

	it("closes the children when the parent tab goes away", async () => {
		await start();
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({ tabId: "c1", callerTabId: "ap-1", tag: "autopilot-child" });
		autopilot.tabReleased("ap-1");
		await Promise.resolve();
		expect(world.released).toEqual(["c1"]);
		expect(autopilot.isStopping("ap-1")).toBe(false);
	});
});

describe("approval cards", () => {
	const card = (title: string): ExtensionUIRequest => ({
		type: "extension_ui_request",
		id: "r1",
		method: "select",
		title: `Allow tool: ${title}`,
		options: ["Approve", "Deny"],
	});

	it("answers a run's cards (Deny for a violation), a child's cards by the child's rules, and leaves other tabs", async () => {
		await start();
		world.addTab("c1", path.join(tmp, "c1"));
		await autopilot.beforeFirstPrompt({
			tabId: "c1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: path.join(tmp, "c1"), branch: "omp/agent/c1" },
		});
		autopilot.attachSidecar("c1", world.sidecars.get("c1") as unknown as SidecarLike);
		world.sidecars.get("ap-1")?.emit("extensionUi", card("bash\nbun run check:changed"));
		world.sidecars.get("ap-1")?.emit("extensionUi", { ...card("bash\ngit push --force origin main"), id: "r2" });
		world.sidecars.get("c1")?.emit("extensionUi", { ...card("bash\ngit push origin HEAD"), id: "r3" });
		await autopilot.idle();
		expect(
			world.answers.map(entry => [entry.id, entry.tab, "value" in entry.response ? entry.response.value : ""]),
		).toEqual([
			["r1", "ap-1", "Approve"],
			["r2", "ap-1", "Deny"],
			["r3", "c1", "Deny"],
		]);
	});
});

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
});
