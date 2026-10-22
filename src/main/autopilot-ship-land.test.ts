import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	actions,
	branch,
	checking,
	commit,
	contains,
	installShipRig,
	land,
	landElsewhere,
	main,
	prs,
	remote,
	remoteTip,
	runner,
	work,
} from "./autopilot-ship-test-rig";
import { gitSync } from "./local/git/test-repos";

installShipRig();

describe("land", () => {
	it("fast-forwards the default branch to a green cycle's commit and journals it first", async () => {
		const sha = await commit(work, "a.txt");
		const result = await land(runner(), sha);
		expect(result?.item.state).toBe("done");
		expect(result?.land).toEqual({ kind: "landed", sha });
		expect(remoteTip("refs/heads/main")).toBe(sha);
		expect(actions).toContainEqual({ kind: "push", refs: ["refs/remotes/origin/main"], sha });
		// The user's checkout is never written.
		expect(gitSync(main, "rev-parse", "main")).not.toBe(sha);
	});

	it("does not land when the default branch moved; once the run merged it, the next land goes through", async () => {
		const moved = await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const ship = runner();
		const first = await land(ship, sha);
		expect(first?.item.state).toBe("failed");
		expect(first?.land).toEqual({ kind: "behind", ahead: 1, conflicts: [] });
		expect(first?.item.detail).toContain("merges cleanly");
		expect(remoteTip("refs/heads/main")).toBe(moved);
		// What the next cycle does: merge the default branch, check, commit.
		gitSync(work, "merge", "-q", "--no-edit", "origin/main");
		const merged = gitSync(work, "rev-parse", "HEAD");
		const second = await land(ship, merged);
		expect(second?.land).toEqual({ kind: "landed", sha: merged });
		expect(remoteTip("refs/heads/main")).toBe(merged);
	});

	it("names the files a merge would conflict in and moves nothing", async () => {
		const moved = await landElsewhere("README.md", "theirs\n");
		await fs.writeFile(path.join(work, "README.md"), "ours\n");
		gitSync(work, "commit", "-q", "-am", "ours");
		const sha = gitSync(work, "rev-parse", "HEAD");
		const result = await land(runner(), sha);
		expect(result?.land).toEqual({ kind: "behind", ahead: 1, conflicts: ["README.md"] });
		expect(result?.item.detail).toContain("conflicts in README.md");
		expect(remoteTip("refs/heads/main")).toBe(moved);
		expect(gitSync(work, "status", "--porcelain")).toBe("");
	});

	it("a protected default branch gets the run's branch and one pull request, updated by later lands", async () => {
		const hook = path.join(remote, "hooks", "pre-receive");
		await fs.writeFile(
			hook,
			'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "GH006: Protected branch update failed for refs/heads/main." >&2; exit 1; fi\ndone\nexit 0\n',
		);
		await fs.chmod(hook, 0o755);
		const before = remoteTip("refs/heads/main");
		const ship = runner();
		const sha = await commit(work, "a.txt");
		const first = await land(ship, sha);
		expect(first?.item.state).toBe("done");
		expect(first?.land).toMatchObject({ kind: "pr", url: "https://github.com/o/r/pull/7", created: true });
		expect(first?.land?.kind === "pr" && first.land.reason).toContain("Protected branch");
		expect(prs).toEqual([expect.objectContaining({ base: "main", head: branch, draft: false })]);
		expect(remoteTip(`refs/heads/${branch}`)).toBe(sha);
		expect(remoteTip("refs/heads/main")).toBe(before);

		const next = await commit(work, "b.txt");
		const second = await land(ship, next);
		expect(second?.land).toMatchObject({ kind: "pr", created: false });
		expect(prs).toHaveLength(1);
		expect(remoteTip(`refs/heads/${branch}`)).toBe(next);
	});

	it("an existing pull request from an earlier launch carries the work", async () => {
		const hook = path.join(remote, "hooks", "pre-receive");
		await fs.writeFile(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
		await fs.chmod(hook, 0o755);
		const ship = runner({
			prCreate: async () => {
				throw new Error(
					'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/3',
				);
			},
		});
		const sha = await commit(work, "a.txt");
		// Every push is refused here, the branch's too: the land fails, nothing is opened.
		const refused = await land(ship, sha);
		expect(refused?.item.state).toBe("failed");
		await fs.writeFile(
			hook,
			'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "protected branch" >&2; exit 1; fi\ndone\nexit 0\n',
		);
		const result = await land(ship, sha);
		expect(result?.land).toMatchObject({ kind: "pr", url: "https://github.com/o/r/pull/3" });
	});

	it("a run on an existing branch ahead of an unmoved default branch fast-forwards it with every earlier commit", async () => {
		const earlier = await commit(work, "b.txt");
		const sha = await commit(work, "a.txt");
		const { checked, checkCandidate } = checking();
		const result = await land(runner({ checkCandidate }), sha, "test -f a.txt");
		expect(result?.land).toEqual({ kind: "landed", sha });
		expect(checked).toEqual([]);
		expect(contains(earlier, remoteTip("refs/heads/main"))).toBe(true);
	});
});
