import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	AUTOPILOT_OBJECTIVE,
	type AutopilotStatus,
	DEFAULT_SHIP_POLICY,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { localDate, probeRepo, startSettings } from "./autopilot";
import {
	autopilot,
	build,
	dataOf,
	errorOf,
	type FakeSidecar,
	installAutopilotRig,
	main,
	nextTab,
	start,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

describe("pure helpers", () => {
	it("localDate is the local YYYY-MM-DD", () => {
		expect(localDate(new Date(2026, 9, 7))).toBe("2026-10-07");
	});

	it("probeRepo says present for a checkout, gone for a missing folder or one git calls no repository", async () => {
		expect(await probeRepo(main)).toBe("present");
		expect(await probeRepo(path.join(tmp, "missing"))).toBe("gone");
		const plain = path.join(tmp, "plain");
		await fs.mkdir(plain);
		expect(await probeRepo(plain)).toBe("gone");
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"probeRepo says unknown, never gone, when the folder cannot be looked at (EACCES): no soft stop",
		async () => {
			const locked = path.join(tmp, "locked");
			await fs.mkdir(path.join(locked, "wt"), { recursive: true });
			await fs.chmod(locked, 0o000);
			try {
				expect(await probeRepo(path.join(locked, "wt"))).toBe("unknown");
			} finally {
				await fs.chmod(locked, 0o755);
			}
		},
	);

	it("startSettings layers defaults, a preset and the explicit values", () => {
		expect(startSettings({}).ship).toEqual(DEFAULT_SHIP_POLICY);
		expect(startSettings({ preset: "push" }).ship).toMatchObject({ autoPush: true, autoRelease: { on: false } });
		expect(startSettings({ preset: "release" }).ship).toMatchObject({
			autoPush: true,
			autoRelease: { on: true },
		});
		expect(startSettings({ ship: { remote: "up" } }).ship.remote).toBe("up");
		// No cap on fan-out any more: a start that still names one gets no such setting.
		expect(startSettings({ maxParallel: 9 } as never)).not.toHaveProperty("maxParallel");
		expect(startSettings({})).not.toHaveProperty("maxParallel");
		expect(startSettings({ limits: { cycles: 3 } }).limits).toEqual({
			tokens: null,
			minutes: null,
			cycles: 3,
			usd: null,
		});
	});
});

describe("start", () => {
	it("opens a worktree tab, arms the bridge and only then creates the stock goal", async () => {
		const { response } = await start({ type: "set_autopilot", action: "start", preset: "push", focus: ["tests"] });
		expect(response.success).toBe(true);
		const data = dataOf<AutopilotStatus & { tabId: string }>(response);
		expect(data.tabId).toBe("ap-1");
		expect(data).toMatchObject({ active: true, branch: "autopilot/2026-10-17", baseBranch: "main" });
		const calls = world.calls.filter(call => call.tab === "ap-1");
		const arm = calls.findIndex(call => call.name === AUTOPILOT_BRIDGE_METHODS.arm);
		const create = calls.findIndex(call => call.name === "set_goal" && call.params?.objective);
		expect(arm).toBeGreaterThanOrEqual(0);
		expect(create).toBeGreaterThan(arm);
		expect(calls[create]?.params).toEqual({ objective: AUTOPILOT_OBJECTIVE });
		expect(calls[arm]?.params).toMatchObject({
			role: "parent",
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			settings: { focus: ["tests"], ship: { autoPush: true } },
		});
		expect(await fs.stat(path.join(tmp, "wt-2026-10-17"))).toBeTruthy();
	});

	it("titles the run's session by the folder, then by each cycle's item as it is picked, never over the user's own name", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		// No "Autopilot ·" word: the row's rocket mark says it is a run.
		expect(world.sessionNames.get("ap-1")).toBe(path.basename(main));
		const base = world.statuses.get("ap-1") as AutopilotStatus;
		const picked = { ...base, now: { n: 1, startedAt: 1, area: "bugs" as const, title: "Fix slugify spaces" } };
		autopilot.overlay(sidecar, { type: "autopilot_update", status: picked });
		await vi.waitFor(() => expect(world.sessionNames.get("ap-1")).toBe("Fix slugify spaces"));
		// Stock sends no update for an RPC rename: the windows are told by main.
		expect(world.shownNames.get("ap-1")).toBe("Fix slugify spaces");
		// The next cycle's item names it in turn.
		const second = { ...picked, now: { n: 2, startedAt: 2, area: "tests" as const, title: "Cover slugify edges" } };
		autopilot.overlay(sidecar, { type: "autopilot_update", status: second });
		await vi.waitFor(() => expect(world.sessionNames.get("ap-1")).toBe("Cover slugify edges"));
		// The user renames it; a later cycle changes nothing.
		world.sessionNames.set("ap-1", "mine");
		autopilot.overlay(sidecar, {
			type: "autopilot_update",
			status: { ...picked, now: { n: 3, startedAt: 3, area: "docs" as const, title: "x" } },
		});
		await autopilot.idle();
		expect(world.sessionNames.get("ap-1")).toBe("mine");
	});

	describe("the ship level nobody chose", () => {
		const armedPolicy = () => {
			const arm = world.calls.find(call => call.tab === "ap-1" && call.name === AUTOPILOT_BRIDGE_METHODS.arm);
			const settings = arm?.params?.settings;
			return settings && typeof settings === "object" && "ship" in settings ? settings.ship : undefined;
		};
		it("stays local in a repository without a remote", async () => {
			gitSync(main, "remote", "remove", "origin");
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ automatic: true, autoPush: false, autoRelease: { on: false } });
		});
		it("lands every green cycle on the default branch when the repository has a remote, and releases only by a procedure", async () => {
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({
				automatic: true,
				autoPush: false,
				land: true,
				autoRelease: { on: false },
				remote: "origin",
			});
		});
		it("releases by a rules file's procedure, when the agent judges it due", async () => {
			build({ releaseProcedure: true });
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ land: true, autoRelease: { on: true, cadence: { kind: "agent" } } });
		});
		it("releases by the Release section of the guide Start committed, and the agent is told to follow it", async () => {
			build({ realDetect: true });
			world.guide = {
				text: "# Guide\n\n## Release\n\nReleases: yes\n1. Tag it.\n",
				source: "template",
				release: "added",
				releases: true,
			};
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ land: true, autoRelease: { on: true } });
			expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
				releaseProcedure: { file: "AUTOPILOT.md", anchors: ["Release"] },
			});
		});
		it("only lands when the guide says the project does not release", async () => {
			build({ realDetect: true });
			world.guide = {
				text: "# Guide\n\n## Release\n\nReleases: no\n- Nothing ships.\n",
				source: "template",
				release: "added",
				releases: false,
			};
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ land: true, autoRelease: { on: false } });
		});
		it("never releases without a remote, whatever the procedure", async () => {
			build({ releaseProcedure: true });
			gitSync(main, "remote", "remove", "origin");
			await start({ type: "set_autopilot", action: "start" });
			expect(armedPolicy()).toMatchObject({ autoPush: false, autoRelease: { on: false } });
			expect(armedPolicy()).not.toHaveProperty("land");
		});
		it("lands too when the run works on the default branch itself", async () => {
			await start({ type: "set_autopilot", action: "start", branch: { kind: "existing", name: "main" } });
			expect(armedPolicy()).toMatchObject({ autoPush: false, land: true });
		});
		it("an explicit level wins", async () => {
			await start({ type: "set_autopilot", action: "start", preset: "local" });
			expect(armedPolicy()).toMatchObject({ autoPush: false });
			expect(armedPolicy()).not.toHaveProperty("land");
		});
	});

	it("commits an agent's guide as the branch's first commit and leaves the user's branch alone", async () => {
		const { response } = await start({
			type: "set_autopilot",
			action: "start",
			guide: "# Guide\n\nSmall diffs.",
		});
		expect(response.success).toBe(true);
		const worktree = path.join(tmp, "wt-2026-10-17");
		expect(await fs.readFile(path.join(worktree, "AUTOPILOT.md"), "utf8")).toBe("# Guide\n\nSmall diffs.\n");
		expect(gitSync(worktree, "log", "--format=%s", "main..HEAD")).toBe("docs: add AUTOPILOT.md guide");
		expect(gitSync(worktree, "show", "--name-only", "--format=", "HEAD")).toBe("AUTOPILOT.md");
		expect(gitSync(worktree, "status", "--porcelain")).toBe("");
		await expect(fs.access(path.join(main, "AUTOPILOT.md"))).rejects.toThrow();
		expect(gitSync(main, "log", "--format=%s", "main").split("\n")).not.toContain("docs: add AUTOPILOT.md guide");
	});

	it("commits nothing when the agent's guide is the repo's own text", async () => {
		await fs.writeFile(path.join(main, "AUTOPILOT.md"), "# Ours\n");
		gitSync(main, "add", "AUTOPILOT.md");
		gitSync(main, "commit", "-q", "-m", "add guide");
		await start({ type: "set_autopilot", action: "start", guide: "# Ours\n" });
		expect(gitSync(path.join(tmp, "wt-2026-10-17"), "log", "--format=%s", "main..HEAD")).toBe("");
	});

	it("commits an edit of the repo's own guide as an update", async () => {
		await fs.writeFile(path.join(main, "AUTOPILOT.md"), "# Ours\n");
		gitSync(main, "add", "AUTOPILOT.md");
		gitSync(main, "commit", "-q", "-m", "add guide");
		await start({ type: "set_autopilot", action: "start", guide: "# Ours\n\nEdited.\n" });
		const worktree = path.join(tmp, "wt-2026-10-17");
		expect(gitSync(worktree, "log", "--format=%s", "main..HEAD")).toBe("docs: update AUTOPILOT.md guide");
		expect(await fs.readFile(path.join(worktree, "AUTOPILOT.md"), "utf8")).toBe("# Ours\n\nEdited.\n");
	});

	it("asks the bridge for Start's guide with the checkout and its procedure, commits what it answers, and the sheet asks for none", async () => {
		build({ releaseProcedure: true });
		world.guide = {
			text: "# Built\n\n## Release\n\nReleases: yes\n",
			source: "template",
			release: "added",
			releases: true,
		};
		await start({ type: "set_autopilot", action: "start" });
		expect(world.bridgeCalls("parent", AUTOPILOT_BRIDGE_METHODS.guide)[0]?.params).toEqual({
			root: expect.any(String),
			procedure: { file: "AGENTS.md", anchors: ["Release"] },
		});
		const worktree = path.join(tmp, "wt-2026-10-17");
		expect(await fs.readFile(path.join(worktree, "AUTOPILOT.md"), "utf8")).toBe(
			"# Built\n\n## Release\n\nReleases: yes\n",
		);
		expect(gitSync(worktree, "log", "--format=%s", "main..HEAD")).toBe("docs: add AUTOPILOT.md guide");

		const sidecar = world.addTab("sheet", main);
		autopilot.attachSidecar("sheet", sidecar as unknown as SidecarLike);
		const idle = await autopilot.status(sidecar as unknown as SidecarLike, "sheet");
		expect(idle).toMatchObject({ active: false, ship: { queue: [] } });
		expect(idle).not.toHaveProperty("guide");
		expect(world.bridgeCalls("sheet", AUTOPILOT_BRIDGE_METHODS.guide)).toEqual([]);
	});

	it("starts with no guide commit when the bridge cannot build one", async () => {
		const { response } = await start({ type: "set_autopilot", action: "start" });
		expect(response.success).toBe(true);
		expect(gitSync(path.join(tmp, "wt-2026-10-17"), "log", "--format=%s", "main..HEAD")).toBe("");
	});

	it("passes a token ceiling to stock as the goal's budget and never a time limit", async () => {
		await start({ type: "set_autopilot", action: "start", limits: { tokens: 50_000, minutes: 30 } });
		expect(world.stock("ap-1", "set_goal")[0]?.params).toEqual({
			objective: AUTOPILOT_OBJECTIVE,
			tokenBudget: 50_000,
		});
	});

	it("refuses with a readable sentence: not a repository, detached HEAD, a device tab", async () => {
		const outside = world.addTab("outside", tmp);
		const refused = async (sidecar: FakeSidecar, tab = sidecar.tabId) =>
			errorOf(
				await autopilot.handleCommand(
					win,
					sidecar as unknown as SidecarLike,
					tab,
					{ type: "set_autopilot", action: "start" },
					"1",
				),
			);
		expect(await refused(outside)).toMatch(/git repository/);
		const inMain = world.addTab("m", main);
		const device = world.addTab("d", main);
		device.device = "phone";
		expect(await refused(device)).toMatch(/this computer/);
		gitSync(main, "checkout", "-q", "--detach");
		expect(await refused(inMain)).toMatch(/Check out a branch/);
		expect(world.calls.some(call => call.name === AUTOPILOT_BRIDGE_METHODS.arm)).toBe(false);
		expect(nextTab).toBe(0);
	});

	it("starts from a tab in Plan mode or with its own Goal: the run is a new tab, the source tab is left as it is", async () => {
		world.plan = true;
		world.goal = { enabled: true, status: "active" };
		const { response } = await start();
		expect(response.success, JSON.stringify(response)).toBe(true);
		expect(world.stock("parent", "set_plan_mode")).toEqual([]);
		expect(world.stock("parent", "set_goal")).toEqual([]);
	});

	it("refuses a release start without a release procedure, and allows it with one", async () => {
		const sidecar = world.addTab("m", main);
		const command = { type: "set_autopilot", action: "start", preset: "release" } as const;
		const refused = await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "m", command, "1");
		expect(errorOf(refused)).toMatch(/release procedure/i);
		expect(refused).toMatchObject({ success: false, code: "autopilot_no_release" });
		// Nothing was created: no run tab, no autopilot branch.
		expect(nextTab).toBe(0);
		expect(gitSync(main, "branch", "--list", "autopilot/*")).toBe("");
		build({ releaseProcedure: true });
		const ok = await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "m", command, "2");
		expect(ok.success).toBe(true);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params).toMatchObject({
			releaseProcedure: { file: "AGENTS.md", anchors: ["Release"] },
		});
	});

	it("is not a run when the goal cannot be created: disarmed, no run", async () => {
		world.failGoalCreate = true;
		const { response, sidecar } = await start();
		expect(errorOf(response)).toMatch(/goal refused/);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.disarm)).toHaveLength(1);
		const status = await autopilot.status(sidecar as unknown as SidecarLike, "ap-1");
		expect(status.state).toBe("ended");
	});

	it("answers get_autopilot on a tab that is no run with the sheet's facts", async () => {
		build({ releaseProcedure: true });
		const sidecar = world.addTab("m", main);
		const status = await autopilot.status(sidecar as unknown as SidecarLike, "m");
		expect(status).toMatchObject({
			active: false,
			ship: { policy: DEFAULT_SHIP_POLICY, queue: [], releaseProcedure: { file: "AGENTS.md" } },
		});
		build();
		expect((await autopilot.status(sidecar as unknown as SidecarLike, "m")).ship?.releaseBlocked).toMatch(
			/release procedure/i,
		);
	});
});
