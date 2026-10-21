import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkLandCandidate, type LandCheckInput } from "./autopilot-land-check";
import type { ShipRunner } from "./autopilot-ship";
import {
	actions,
	branch,
	commit,
	installShipRig,
	main,
	prs,
	remote,
	remoteTip,
	runner,
	target,
	work,
} from "./autopilot-ship-test-rig";
import { gitSync } from "./local/git/test-repos";

installShipRig();

describe("land", () => {
	const landTarget = () => target({ landTo: "main" });
	const land = async (ship: ShipRunner, sha?: string, check?: string) => {
		ship.enqueue({ kind: "land", ...(sha ? { sha } : {}), ...(check ? { check } : {}) });
		const [result] = await ship.drain(landTarget());
		return result;
	};
	const worktrees = () => gitSync(main, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length;
	const parents = (sha: string) => gitSync(remote, "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
	const contains = (ancestor: string, tip: string) =>
		gitSync(remote, "merge-base", "--is-ancestor", ancestor, tip) === "";
	/** The real temporary-checkout check, recording which commits it ran on; `after` runs once each check ended. */
	function checking(after?: (input: LandCheckInput, n: number) => Promise<void>) {
		const checked: string[] = [];
		const checkCandidate = async (input: LandCheckInput) => {
			const result = await checkLandCandidate(input);
			checked.push(input.sha);
			await after?.(input, checked.length);
			return result;
		};
		return { checked, checkCandidate };
	}
	/** Someone else's commit on the remote's default branch, made from the user's checkout. */
	async function landElsewhere(file: string, text: string): Promise<string> {
		await fs.writeFile(path.join(main, file), text);
		gitSync(main, "add", file);
		gitSync(main, "commit", "-q", "-m", `elsewhere ${file}`);
		gitSync(main, "push", "-q", "origin", "main");
		return gitSync(main, "rev-parse", "HEAD");
	}

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
