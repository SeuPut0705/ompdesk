import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOPILOT_BRIDGE_METHODS } from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { RepoProbe } from "./autopilot";
import {
	afters,
	autopilot,
	build,
	commit,
	installAutopilotRig,
	main,
	notices,
	record,
	remote,
	start,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

describe("a cycle's end", () => {
	/** Fires the timers the coordinator arms while its chain waits on them, until the chain has drained. */
	async function drainWithTimers(): Promise<void> {
		for (let round = 0; round < 50; round++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			for (const fire of afters.splice(0)) fire();
		}
		await autopilot.idle();
	}

	it("a git that cannot answer for a moment is no missing repository: no pause, the next cycle goes on", async () => {
		const probes: RepoProbe[] = ["unknown", "unknown", "present"];
		build({ probeRepo: async () => probes.shift() ?? "present" });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record() });
		await drainWithTimers();
		const states = () => world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state);
		expect(states()).not.toContain("paused");
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
	});

	it("one probe that says gone is checked again: gone twice pauses, gone then present goes on", async () => {
		const once: RepoProbe[] = ["gone", "present"];
		build({ probeRepo: async () => once.shift() ?? "present" });
		await start();
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await drainWithTimers();
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state),
		).not.toContain("paused");
		build({ probeRepo: async () => "gone" });
		await start();
		autopilot.frame(world.sidecars.get("ap-2") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await drainWithTimers();
		expect(world.bridgeCalls("ap-2", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "repo_gone",
		});
	});

	it("pushes the autopilot branch after a green cycle when auto push is on, and records the journal action first", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ commit: sha }) });
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).not.toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/autopilot/2026-10-17"],
			sha,
		});
		const flags = world
			.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
			.map(call => call.params?.inFlight ?? null);
		expect(flags).toEqual([expect.objectContaining({ kind: "push" }), null]);
		// The in-flight marks name no state: the journal's own stays, whatever this process last read.
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state ?? null),
		).toEqual([null, null]);
	});

	it("a pause given while the cycle's push runs stays: the push's marks never journal the run running again", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "pause" }, "2");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ commit: sha }) });
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
		expect(world.statuses.get("ap-1")).toMatchObject({ state: "paused", reason: "user_pause" });
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state ?? null),
		).not.toContain("running");
	});

	it("does not push a red cycle, nor anything when auto push is off", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ verify: "red" }) });
		await autopilot.idle();
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
		build();
		await start({ type: "set_autopilot", action: "start", preset: "local" });
		await commit(path.join(tmp, "wt-2026-10-17-2"), "b.txt").catch(() => undefined);
		autopilot.frame(world.sidecars.get("ap-2") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});

	it("a verified user push request pushes at the turn's end even with auto push off", async () => {
		await start();
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		world.requests.push({ kind: "push", quote: "push now", cycle: 1, at: 1 });
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ verify: "red" }),
		});
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
	});

	it("a refused push is reported to the agent and never pauses the run", async () => {
		gitSync(main, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		for (let cycle = 1; cycle <= 4; cycle++) {
			autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: cycle }) });
			await autopilot.idle();
		}
		const states = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state);
		expect(states).not.toContain("paused");
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/push of autopilot\/2026-10-17 failed.*never forces/,
		);
	});

	it("pauses with ban_violation when the cycle moved something it was not entitled to", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		gitSync(worktree, "push", "-q", "origin", "HEAD:refs/heads/autopilot/2026-10-17");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "ban_violation",
		});
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toEqual({ action: "pause" });
		expect(notices.at(-1)).toMatchObject({ kind: "error", title: "Autopilot paused" });
	});

	// What the guard cannot see (an obfuscated command), the audit still names: the moved ref is the detail.
	it.each([
		["a tag", (worktree: string) => gitSync(worktree, "tag", "stray-tag"), "refs/tags/stray-tag"],
		[
			"a push to another branch",
			(worktree: string) => gitSync(worktree, "push", "-q", "origin", "HEAD:refs/heads/rogue"),
			"refs/remotes/origin/rogue",
		],
	])("names %s the cycle made behind the guard's back", async (_name, act, ref) => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		act(worktree);
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		const paused = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params;
		expect(paused).toMatchObject({ state: "paused", reason: "ban_violation" });
		expect(String((paused as { detail?: unknown } | undefined)?.detail ?? "")).toContain(ref);
	});

	it("a clean cycle is not a violation, and a second cycle is judged against the first's end", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await commit(worktree, "a.txt");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record() });
		await autopilot.idle();
		await commit(worktree, "b.txt");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("folds the children's usage into the cycle, closes their tabs and removes only clean merged worktrees", async () => {
		await start();
		const parent = path.join(tmp, "wt-2026-10-17");
		const merged = path.join(tmp, "child-merged");
		const unmerged = path.join(tmp, "child-unmerged");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/merged", merged, "autopilot/2026-10-17");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/unmerged", unmerged, "autopilot/2026-10-17");
		await commit(unmerged, "u.txt");
		for (const [tab, dir, branch] of [
			["child-1", merged, "omp/agent/merged"],
			["child-2", unmerged, "omp/agent/unmerged"],
		] as const) {
			world.addTab(tab, dir);
			await autopilot.beforeFirstPrompt({
				tabId: tab,
				callerTabId: "ap-1",
				tag: "autopilot-child",
				worktree: { path: dir, branch },
			});
		}
		world.stats.set("child-1", { tokens: { total: 1000 }, cost: 0.5 });
		world.stats.set("child-2", { tokens: { total: 250 }, cost: 0.25 });
		world.busy.add("child-2");
		await commit(parent, "p.txt");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ n: 4 }),
		});
		await autopilot.idle();
		expect(world.released.sort()).toEqual(["child-1", "child-2"]);
		expect(world.stock("child-2", "abort")).toHaveLength(1);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.cycleAmend)[0]?.params).toEqual({
			n: 4,
			tokens: 1250,
			usd: 0.75,
		});
		await expect(fs.stat(merged)).rejects.toThrow();
		await expect(fs.stat(unmerged)).resolves.toBeTruthy();
		expect(
			gitSync(main, "for-each-ref", "--format=%(refname:short)", "refs/heads/omp/agent").split("\n").sort(),
		).toEqual(["omp/agent/merged", "omp/agent/unmerged"]);
	});

	it("keeps a merged child's worktree when it has uncommitted changes", async () => {
		await start();
		const dir = path.join(tmp, "child-dirty");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/dirty", dir, "autopilot/2026-10-17");
		await fs.writeFile(path.join(dir, "README.md"), "dirty\n");
		world.addTab("child-1", dir);
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: dir, branch: "omp/agent/dirty" },
		});
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		await expect(fs.stat(dir)).resolves.toBeTruthy();
	});

	it("a cycle's end is no notification, green or red: the screen and the timeline say it", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2, title: "Fix it" }) });
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({ n: 3, verify: "red", title: "Broke it" }),
		});
		await autopilot.idle();
		expect(notices).toEqual([]);
	});
});
