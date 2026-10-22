import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotBranchChoice,
	type AutopilotStatus,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcResponse } from "../shared/rpc-types";
import {
	autopilot,
	build,
	commit,
	dataOf,
	errorOf,
	installAutopilotRig,
	main,
	nextTab,
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

describe("the branch a run is on", () => {
	const startOn = (branch: AutopilotBranchChoice, extra: { preset?: "push" } = {}) =>
		start({ type: "set_autopilot", action: "start", branch, ...extra });
	const rootOf = (response: RpcResponse) => dataOf<AutopilotStatus>(response).root ?? "";
	const refusal = (response: RpcResponse) => ({
		error: errorOf(response),
		code: "code" in response ? response.code : undefined,
	});
	const armed = () => world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.arm)[0]?.params;
	async function cycleEnd(n = 1): Promise<void> {
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ n }),
		});
		await autopilot.idle();
	}

	beforeEach(() => {
		gitSync(main, "branch", "feature/x");
		gitSync(main, "push", "-q", "origin", "feature/x");
		// On the remote only: pushed, then deleted locally.
		gitSync(main, "branch", "remote-only");
		gitSync(main, "push", "-q", "origin", "remote-only");
		gitSync(main, "branch", "-D", "remote-only");
	});

	it("checks an existing local branch out in the new worktree and commits there; nothing is named autopilot/", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" });
		expect(response.success).toBe(true);
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({
			active: true,
			branch: "feature/x",
			baseBranch: "main",
			run: "2026-10-17",
		});
		expect(gitSync(rootOf(response), "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/x");
		expect(armed()).toMatchObject({ role: "parent", branch: "feature/x", baseBranch: "main", run: "2026-10-17" });
		expect(gitSync(main, "branch", "--list", "autopilot/*")).toBe("");
		expect(gitSync(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});

	it("tracks a branch that is only on the remote", async () => {
		const { response } = await startOn({ kind: "existing", name: "remote-only" });
		expect(response.success).toBe(true);
		const root = rootOf(response);
		expect(gitSync(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("remote-only");
		expect(gitSync(root, "rev-parse", "--abbrev-ref", "remote-only@{upstream}")).toBe("origin/remote-only");
		expect(armed()).toMatchObject({ branch: "remote-only" });
	});

	it("a new branch takes the name the user typed, exactly", async () => {
		const { response } = await startOn({ kind: "new", name: "work/mine" });
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "work/mine", run: "2026-10-17" });
		expect(gitSync(rootOf(response), "rev-parse", "--abbrev-ref", "HEAD")).toBe("work/mine");
		expect(gitSync(main, "rev-parse", "work/mine")).toBe(gitSync(main, "rev-parse", "main"));
	});

	it("a name under autopilot/ keeps the run id the children are named from", async () => {
		const { response } = await startOn({ kind: "new", name: "autopilot/night-shift" });
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "autopilot/night-shift", run: "night-shift" });
	});

	it("main while the user's own folder is on it: the run works on its own branch cut from main, Push goes to HEAD:main and the folder is untouched", async () => {
		await fs.writeFile(path.join(main, "mine.txt"), "user work");
		const mainBefore = gitSync(main, "rev-parse", "main");
		const { response } = await startOn({ kind: "existing", name: "main" }, { preset: "push" });
		expect(response.success).toBe(true);
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({
			branch: "autopilot/2026-10-17",
			target: "main",
			baseBranch: "main",
		});
		expect(armed()).toMatchObject({ branch: "autopilot/2026-10-17", target: "main" });
		const sha = await commit(rootOf(response), "a.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/main"],
			sha,
		});
		// The user's folder: still on main, local main not moved, their file there, nothing else changed.
		expect(gitSync(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(gitSync(main, "rev-parse", "main")).toBe(mainBefore);
		expect(await fs.readFile(path.join(main, "mine.txt"), "utf8")).toBe("user work");
		expect(gitSync(main, "status", "--porcelain")).toBe("?? mine.txt");
	});

	it("any branch another worktree holds is a target too: the run works beside it and pushes to it, never forced", async () => {
		const other = path.join(tmp, "elsewhere");
		gitSync(main, "worktree", "add", "-q", other, "feature/x");
		const { response } = await startOn({ kind: "existing", name: "feature/x" }, { preset: "push" });
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "autopilot/2026-10-17", target: "feature/x" });
		const sha = await commit(rootOf(response), "a.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(sha);
		// The remote target moves on elsewhere: the next push is rejected, reported to the agent, not forced, not a stop.
		const theirs = path.join(tmp, "theirs2");
		gitSync(tmp, "clone", "-q", remote, theirs);
		gitSync(theirs, "config", "user.email", "t@example.com");
		gitSync(theirs, "config", "user.name", "T");
		gitSync(theirs, "switch", "-q", "feature/x");
		const moved = await commit(theirs, "theirs.txt");
		gitSync(theirs, "push", "-q", "origin", "feature/x");
		await commit(rootOf(response), "b.txt");
		await cycleEnd(2);
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(moved);
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/origin\/feature\/x has commits this run lacks.*never forces/,
		);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("a PR is opened from the push target, so a target that is the base branch has none to open (merge still has work to land)", async () => {
		const toBase = await startOn({ kind: "existing", name: "main" }, { preset: "push" });
		expect(dataOf<AutopilotStatus>(toBase.response)).toMatchObject({
			branch: "autopilot/2026-10-17",
			target: "main",
		});
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		const pr = (id: string) =>
			autopilot.handleCommand(win, sidecar, "ap-1", { type: "set_autopilot", action: "ship", kind: "pr" }, id);
		expect(refusal(await pr("8"))).toMatchObject({ code: "autopilot_on_base" });
		// Merge still has work to land: the run's own branch is not the base.
		const merged = await autopilot.handleCommand(
			win,
			sidecar,
			"ap-1",
			{ type: "set_autopilot", action: "ship", kind: "merge" },
			"9",
		);
		expect(merged.success).toBe(true);
	});

	it("refuses a branch that is gone, a new name that is taken and one git would not accept", async () => {
		const missing = (await startOn({ kind: "existing", name: "ghost" })).response;
		expect(refusal(missing)).toMatchObject({ code: "autopilot_branch_missing" });
		const taken = (await startOn({ kind: "new", name: "feature/x" })).response;
		expect(refusal(taken)).toMatchObject({ code: "autopilot_branch_exists" });
		const invalid = (await startOn({ kind: "new", name: "bad name" })).response;
		expect(refusal(invalid)).toMatchObject({ code: "autopilot_branch_invalid" });
		const garbage = (await startOn({ kind: "bogus" } as unknown as AutopilotBranchChoice)).response;
		expect(refusal(garbage)).toMatchObject({ code: "autopilot_branch_invalid" });
		expect(nextTab).toBe(0);
	});

	it("the default branch is allowed once the user's folder is off it: the run commits on it, Push pushes to it", async () => {
		gitSync(main, "switch", "-q", "-c", "dev");
		const { response } = await startOn({ kind: "existing", name: "main" }, { preset: "push" });
		expect(response.success).toBe(true);
		// A run on the default branch has itself as its base (a release pushes it).
		expect(dataOf<AutopilotStatus>(response)).toMatchObject({ branch: "main", baseBranch: "main" });
		const root = rootOf(response);
		const sha = await commit(root, "a.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/main"],
			sha,
		});
		expect(world.statuses.get("ap-1")?.state).toBe("running");
		// The user's own folder was not touched.
		expect(gitSync(main, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev");
	});

	it("Push goes to the chosen branch under the same name and never to main", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" }, { preset: "push" });
		const sha = await commit(rootOf(response), "a.txt");
		const mainBefore = gitSync(remote, "rev-parse", "refs/heads/main");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(sha);
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/feature/x"],
			sha,
		});
	});

	it("never forces: a remote branch that moved on is reported to the agent, not a stop", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" }, { preset: "push" });
		const theirs = path.join(tmp, "theirs");
		gitSync(tmp, "clone", "-q", remote, theirs);
		gitSync(theirs, "config", "user.email", "t@example.com");
		gitSync(theirs, "config", "user.name", "T");
		gitSync(theirs, "switch", "-q", "feature/x");
		const moved = await commit(theirs, "theirs.txt");
		gitSync(theirs, "push", "-q", "origin", "feature/x");
		await commit(rootOf(response), "mine.txt");
		await cycleEnd();
		expect(gitSync(remote, "rev-parse", "refs/heads/feature/x")).toBe(moved);
		const note = String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text);
		expect(note).toMatch(/not a fast-forward.*never forces/);
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("merge and PR have nothing to do on the default branch itself", async () => {
		gitSync(main, "switch", "-q", "-c", "dev");
		await startOn({ kind: "existing", name: "main" });
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		for (const kind of ["merge", "pr"] as const) {
			const refused = await autopilot.handleCommand(
				win,
				sidecar,
				"ap-1",
				{ type: "set_autopilot", action: "ship", kind },
				"9",
			);
			expect(refusal(refused)).toMatchObject({ code: "autopilot_on_base" });
		}
	});

	it("a cycle's audit judges the chosen branch: its own commits pass, another branch moving is a violation", async () => {
		const { response } = await startOn({ kind: "existing", name: "feature/x" });
		const root = rootOf(response);
		await commit(root, "a.txt");
		await cycleEnd(1);
		expect(
			world
				.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
				.some(call => call.params?.reason === "ban_violation"),
		).toBe(false);
		// An `autopilot/` branch is no longer trusted just for its prefix.
		gitSync(root, "branch", "autopilot/sneaky");
		await cycleEnd(2);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "ban_violation",
		});
	});

	it("gives the sheet the folder's own branch only, whatever an earlier release remembered", async () => {
		// `autopilotBranch` was the remembered choice of earlier releases: retired, never read.
		build({ prefs: { autopilotBranch: { [main]: { kind: "existing", name: "feature/x" } } } });
		const sidecar = world.addTab("m", main);
		const status = dataOf<AutopilotStatus>(
			await autopilot.handleCommand(win, sidecar as unknown as SidecarLike, "m", { type: "get_autopilot" }, "1"),
		);
		expect(status.branches).toEqual({ repo: main, remote: "origin", defaultBranch: "main", current: "main" });
		// The branch is per run: the ship defaults carry none.
		expect(Object.keys(status.ship?.policy ?? {}).sort()).toEqual(["autoPush", "autoRelease", "remote"]);
	});
});
