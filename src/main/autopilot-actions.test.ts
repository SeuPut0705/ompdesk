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
import { RELEASE_NOW_MESSAGE } from "./autopilot";
import {
	autopilot,
	build,
	clock,
	commit,
	dataOf,
	errorOf,
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

	it("ship, then stop waits for the release run: a failed one is owed and repaired, a successful one ends the run", async () => {
		build({ releaseProcedure: true });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		world.busy.add("ap-1");
		const chosen = Date.now();
		await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "stop_after_ship", enabled: true },
			"2",
		);
		const worktree = path.join(tmp, "wt-2026-10-17");
		const cycle = async (n: number, version: string) => {
			const sha = await commit(worktree, `c${n}.txt`);
			autopilot.frame(sidecar, {
				type: "autopilot_cycle_end",
				record: record({
					n,
					commit: sha,
					startedAt: chosen + n,
					ship: { kind: "release", version, runUrl: `https://github.com/o/r/actions/runs/${n}` },
				}),
			});
			await autopilot.idle();
		};
		const poll = async (conclusion: "success" | "failure") => {
			setReleaseState({ status: "completed", conclusion });
			polls.at(-1)?.run();
			await autopilot.idle();
			await autopilot.idle();
		};
		// Landed, its release still running: the run waits for it.
		await cycle(2, "1.2.3");
		expect(autopilot.isStopping("ap-1")).toBe(false);
		// The release failed: owed, the run goes on.
		await poll("failure");
		expect(autopilot.isStopping("ap-1")).toBe(false);
		expect((await autopilot.status(sidecar, "ap-1")).ship?.endAfterShip).toBe(true);
		// The next cycle repairs and releases again; its release succeeds and the run ends.
		await cycle(3, "1.2.4");
		expect(autopilot.isStopping("ap-1")).toBe(false);
		await poll("success");
		expect(autopilot.isStopping("ap-1")).toBe(true);
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

describe("a long run's cycles on the way to a window", () => {
	it("are the newest 30 in an update and a read, every one when asked, and the coordinator keeps them all", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sha = await commit(worktree, "a.txt");
		const status = world.statuses.get("ap-1") as AutopilotStatus;
		status.cycles = Array.from({ length: 40 }, (_, index) =>
			record({ n: index + 1, ...(index === 1 ? { commit: sha } : {}) }),
		);
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const out = autopilot.overlay(sidecar, { type: "autopilot_update", status }) as { status: AutopilotStatus };
		expect(out.status.cycles?.map(cycle => cycle.n)).toEqual(Array.from({ length: 30 }, (_, index) => index + 11));
		expect(out.status.cycleCount).toBe(40);
		const read = dataOf<AutopilotStatus>(
			await autopilot.handleCommand(win, sidecar, "ap-1", { type: "get_autopilot" }, "1"),
		);
		expect([read.cycles?.length, read.cycleCount]).toEqual([30, 40]);
		const all = dataOf<AutopilotStatus>(
			await autopilot.handleCommand(win, sidecar, "ap-1", { type: "get_autopilot", allCycles: true }, "2"),
		);
		expect(all.cycles?.length).toBe(40);
		expect(all.cycleCount).toBeUndefined();
		// A cycle the windows no longer list can still be reverted.
		const reverted = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "revert", cycle: 2 },
			"3",
		);
		expect(reverted.success).toBe(true);
	});
});
