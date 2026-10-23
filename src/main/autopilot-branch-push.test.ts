import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOPILOT_BRIDGE_METHODS, type AutopilotStatus } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	autopilot,
	branchChoiceWorld,
	commit,
	dataOf,
	installAutopilotRig,
	main,
	remote,
	tmp,
	win,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";

// Split from autopilot-branch-choice.test.ts so the push, PR and merge targets run beside the branch choice.
installAutopilotRig();

describe("where a run on a chosen branch pushes, opens a PR and merges", () => {
	const { startOn, rootOf, refusal, armed, cycleEnd } = branchChoiceWorld();

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
});
