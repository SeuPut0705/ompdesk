import { describe, expect, it } from "vitest";
import {
	actions,
	checking,
	commit,
	contains,
	installShipRig,
	land,
	landElsewhere,
	main,
	parents,
	remoteTip,
	runner,
	work,
	worktrees,
} from "./autopilot-ship-test-rig";
import { gitSync } from "./local/git/test-repos";

// Split from autopilot-ship-land.test.ts so the two halves run side by side (each case runs real git dozens of times).
installShipRig();

describe("a default branch that moved on and merges cleanly", () => {
	const check = "test -f a.txt && test -f other.txt";

	it("checks the merge commit itself in a temporary checkout and lands exactly that commit", async () => {
		const moved = await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const { checked, checkCandidate } = checking();
		const result = await land(runner({ checkCandidate }), sha, check);
		expect(result?.item.state).toBe("done");
		expect(checked).toHaveLength(1);
		const candidate = checked[0] as string;
		expect(result?.land).toEqual({
			kind: "landed",
			sha: candidate,
			merge: { onto: moved, check, advanced: true },
		});
		expect(remoteTip("refs/heads/main")).toBe(candidate);
		expect(parents(candidate)).toEqual([sha, moved]);
		expect(actions).toContainEqual({ kind: "push", refs: ["refs/remotes/origin/main"], sha: candidate });
		// The run's branch follows (its worktree had not moved), the temporary checkout is gone, the user's checkout untouched.
		expect(gitSync(work, "rev-parse", "HEAD")).toBe(candidate);
		expect(gitSync(work, "status", "--porcelain")).toBe("");
		expect(worktrees()).toBe(2);
		expect(gitSync(main, "rev-parse", "main")).toBe(moved);
	});

	it("runs a check that looks only at what changed on the run's change, in the temporary checkout", async () => {
		const moved = await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		// The run's change shows as uncommitted against the moved default branch, and the command's own path to the
		// run's worktree points at the temporary checkout (other.txt is there, not in the run's worktree). The path is
		// written as a Windows agent's bash takes it (forward slashes); the run's root is the native path.
		const scoped = `cd ${work.replaceAll("\\", "/")} && test -f other.txt && git diff --name-only HEAD | grep -qx a.txt && ! git diff --name-only HEAD | grep -q other.txt`;
		const { checked, checkCandidate } = checking();
		const result = await land(runner({ checkCandidate }), sha, scoped);
		expect(result?.land).toMatchObject({ kind: "landed", sha: checked[0], merge: { onto: moved } });
	});

	it("does not land a merge whose check fails, and cleans the temporary checkout", async () => {
		const moved = await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const { checked, checkCandidate } = checking();
		const red = "test -f a.txt && test ! -f other.txt";
		const result = await land(runner({ checkCandidate }), sha, red);
		expect(result?.item.state).toBe("failed");
		expect(result?.land).toMatchObject({
			kind: "red",
			candidate: checked[0],
			onto: moved,
			check: red,
			exitCode: 1,
		});
		expect(result?.item.detail).toContain("fails the check");
		expect(remoteTip("refs/heads/main")).toBe(moved);
		expect(gitSync(work, "rev-parse", "HEAD")).toBe(sha);
		expect(worktrees()).toBe(2);
	});

	it("builds and checks a new candidate when the default branch moves again during the check", async () => {
		await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		let newest = "";
		const { checked, checkCandidate } = checking(async (_input, n) => {
			if (n === 1) newest = await landElsewhere("third.txt", "third\n");
		});
		const result = await land(runner({ checkCandidate }), sha, check);
		expect(checked).toHaveLength(2);
		const [first, second] = checked as [string, string];
		expect(first).not.toBe(second);
		expect(parents(second)).toEqual([sha, newest]);
		expect(result?.land).toMatchObject({ kind: "landed", sha: second, merge: { onto: newest } });
		expect(remoteTip("refs/heads/main")).toBe(second);
		expect(worktrees()).toBe(2);
	});

	it("builds and checks a new candidate when the default branch moves during the push", async () => {
		await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const { checked, checkCandidate } = checking();
		let newest = "";
		const ship = runner({
			checkCandidate,
			journal: async action => {
				actions.push(action);
				if (action.kind === "push" && !newest) newest = await landElsewhere("third.txt", "third\n");
			},
		});
		const result = await land(ship, sha, check);
		expect(checked).toHaveLength(2);
		const second = checked[1] as string;
		expect(parents(second)).toEqual([sha, newest]);
		expect(result?.land).toMatchObject({ kind: "landed", sha: second, merge: { onto: newest } });
		expect(remoteTip("refs/heads/main")).toBe(second);
	});

	it("leaves the run's branch alone when its worktree moved on meanwhile", async () => {
		await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const later = await commit(work, "b.txt");
		const { checked, checkCandidate } = checking();
		const result = await land(runner({ checkCandidate }), sha, check);
		expect(result?.land).toMatchObject({ kind: "landed", sha: checked[0], merge: { advanced: false } });
		expect(gitSync(work, "rev-parse", "HEAD")).toBe(later);
	});

	it("lands every earlier commit of a run started on an existing branch ahead of the default branch", async () => {
		// The existing branch's earlier work, never landed (a run before this one).
		const earlier = [await commit(work, "b.txt"), await commit(work, "c.txt")];
		const moved = await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const { checked, checkCandidate } = checking();
		const result = await land(
			runner({ checkCandidate }),
			sha,
			"test -f a.txt && test -f b.txt && test -f c.txt && test -f other.txt",
		);
		expect(checked).toHaveLength(1);
		expect(result?.land).toMatchObject({ kind: "landed", sha: checked[0], merge: { onto: moved } });
		for (const commitSha of [...earlier, sha, moved])
			expect(contains(commitSha, remoteTip("refs/heads/main"))).toBe(true);
	});
});
