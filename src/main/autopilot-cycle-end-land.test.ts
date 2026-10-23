import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotCycleRecord,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { autopilot, commit, installAutopilotRig, main, record, remote, start, tmp, world } from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

describe("a cycle's end: Automatic shipping lands on the default branch", () => {
	const worktree = () => path.join(tmp, "wt-2026-10-17");
	const end = async (over: Partial<AutopilotCycleRecord>) => {
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(over),
		});
		await autopilot.idle();
	};
	const notes = () => world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).map(call => String(call.params?.text));

	it("a green cycle with a commit lands on main; a red cycle and one without a commit never do", async () => {
		await start();
		const before = gitSync(remote, "rev-parse", "refs/heads/main");
		const red = await commit(worktree(), "red.txt");
		await end({ verify: "red", commit: red });
		await end({ verify: "green" });
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(before);
		const sha = await commit(worktree(), "green.txt");
		await end({ verify: "green", commit: sha });
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
		// Never the user's checkout, never the run's own branch on the remote.
		expect(gitSync(main, "rev-parse", "main")).toBe(before);
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});

	/** Someone else's commit on the remote's main, from a clone of their own (the run's repository is not touched). */
	async function pushElsewhere(file: string, text: string): Promise<string> {
		const other = path.join(tmp, "someone-else");
		if (await fs.stat(other).catch(() => null)) gitSync(other, "pull", "-q", "--ff-only", "origin", "main");
		else gitSync(tmp, "clone", "-q", remote, other);
		gitSync(other, "config", "user.email", "o@example.com");
		gitSync(other, "config", "user.name", "Other");
		gitSync(other, "config", "commit.gpgsign", "false");
		await fs.writeFile(path.join(other, file), text);
		gitSync(other, "add", file);
		gitSync(other, "commit", "-q", "-m", `elsewhere ${file}`);
		gitSync(other, "push", "-q", "origin", "HEAD:main");
		return gitSync(other, "rev-parse", "HEAD");
	}

	it("main moved: nothing lands and the agent is told to merge; after its merge the next green cycle lands", async () => {
		await start();
		const moved = await pushElsewhere("other.txt", "other\n");
		const sha = await commit(worktree(), "a.txt");
		await end({ verify: "green", commit: sha });
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(moved);
		expect(notes().at(-1)).toMatch(
			/^Not landed: origin\/main has commits this run lacks\. Run git fetch origin && git merge origin\/main/,
		);
		// The agent's next cycle: merge, check, commit.
		gitSync(worktree(), "merge", "-q", "--no-edit", "origin/main");
		const merged = gitSync(worktree(), "rev-parse", "HEAD");
		await end({ verify: "green", commit: merged });
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(merged);
	});

	it("main moved: the cycle's own check runs on the merge, and a passing merge lands without the agent", async () => {
		await start();
		const moved = await pushElsewhere("other.txt", "other\n");
		const sha = await commit(worktree(), "a.txt");
		await end({ verify: "green", commit: sha, checkCommand: "test -f a.txt && test -f other.txt" });
		const landed = gitSync(remote, "rev-parse", "refs/heads/main");
		expect(gitSync(remote, "rev-list", "--parents", "-n", "1", landed).split(" ").slice(1)).toEqual([sha, moved]);
		expect(notes().at(-1)).toMatch(/^Landed on origin\/main as a merge .* fast-forwarded to it/);
		expect(gitSync(worktree(), "rev-parse", "HEAD")).toBe(landed);
		// A merge that fails the check never lands: the agent is told what failed.
		const next = await commit(worktree(), "b.txt");
		await pushElsewhere("third.txt", "third\n");
		const before = gitSync(remote, "rev-parse", "refs/heads/main");
		await end({ verify: "green", commit: next, checkCommand: "test ! -f third.txt" });
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(before);
		expect(notes().at(-1)).toMatch(
			/^Not landed: .*your check \(test ! -f third\.txt\) fails on that merge \(exit 1\)/,
		);
	});
});
