import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotCycleRecord,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	autopilot,
	commit,
	installAutopilotRig,
	notices,
	record,
	remote,
	runLogs,
	start,
	tmp,
	world,
} from "./autopilot-test-rig";
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

	it("a conflicting main is a note naming the files, never a pause", async () => {
		await start();
		await pushElsewhere("README.md", "theirs\n");
		await fs.writeFile(path.join(worktree(), "README.md"), "ours\n");
		gitSync(worktree(), "commit", "-q", "-am", "ours");
		await end({ verify: "green", commit: gitSync(worktree(), "rev-parse", "HEAD") });
		expect(notes().at(-1)).toContain("merging it conflicts in README.md");
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state),
		).not.toContain("paused");
	});

	it("a protected main falls back to one pull request, said once, and the end summary says what landed", async () => {
		const hook = path.join(remote, "hooks", "pre-receive");
		await fs.writeFile(
			hook,
			'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "GH006: Protected branch update failed" >&2; exit 1; fi\ndone\nexit 0\n',
		);
		await fs.chmod(hook, 0o755);
		await start();
		const first = await commit(worktree(), "a.txt");
		await end({ verify: "green", commit: first });
		const second = await commit(worktree(), "b.txt");
		await end({ verify: "green", commit: second });
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(second);
		const said = notices.filter(notice => notice.title === "Autopilot can't push to the default branch");
		expect(said).toEqual([
			expect.objectContaining({ body: expect.stringContaining("https://github.com/o/r/pull/1") }),
		]);
		const status = await autopilot.status(world.sidecars.get("ap-1") as unknown as SidecarLike, "ap-1");
		expect(status.ship?.landing).toMatchObject({ via: "pr", url: "https://github.com/o/r/pull/1" });

		world.statuses
			.get("ap-1")
			?.cycles?.push(record({ n: 1, commit: first }), record({ n: 2, commit: second, verify: "red" }));
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_stop_requested",
			reason: "budget",
		});
		await autopilot.idle();
		expect(runLogs.at(-1)).toMatchObject({
			message: "paused",
			details: {
				reason: "budget",
				cycles: 2,
				green: 1,
				commits: 2,
				landed: 0,
				pr: "https://github.com/o/r/pull/1",
			},
		});
		expect(notices.at(-1)?.body).toBe(
			"autopilot/2026-10-17: 2 cycles (1 green), 2 commits; main is protected: 0 of 2 landed, the rest waits in https://github.com/o/r/pull/1. Stopped: The token limit was reached.",
		);
	});

	it("the end summary counts what landed and is written for the user's own pause too, with no notification", async () => {
		await start();
		const sha = await commit(worktree(), "a.txt");
		await end({ verify: "green", commit: sha });
		const unlanded = await commit(worktree(), "b.txt");
		await end({ verify: "red", commit: unlanded });
		world.statuses
			.get("ap-1")
			?.cycles?.push(record({ n: 1, commit: sha }), record({ n: 2, commit: unlanded, verify: "red" }));
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_stop_requested",
			reason: "user_pause",
		});
		await autopilot.idle();
		expect(runLogs.at(-1)).toMatchObject({ message: "paused", details: { landed: 1, commits: 2 } });
		expect(notices).toEqual([]);
	});
});
