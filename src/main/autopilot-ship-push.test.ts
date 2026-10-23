import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
	tmp,
	work,
} from "./autopilot-ship-test-rig";
import { gitSync } from "./local/git/test-repos";

installShipRig();

describe("push", () => {
	it("pushes the sha pinned at the start to the autopilot branch only, and journals the ref move first", async () => {
		const sha = await commit(work, "a.txt");
		const ship = runner();
		ship.enqueue({ kind: "push" });
		const [result] = await ship.drain(target());
		expect(result?.failure).toBeUndefined();
		expect(remoteTip(`refs/heads/${branch}`)).toBe(sha);
		expect(remoteTip("refs/heads/main")).not.toBe(sha);
		expect(actions).toEqual([{ kind: "push", refs: [`refs/remotes/origin/${branch}`], sha }]);
		expect(ship.queue()[0]).toMatchObject({ state: "done", sha });
	});

	it("sets the branch's upstream so the screen can count ahead and behind", async () => {
		await commit(work, "a.txt");
		const ship = runner();
		ship.enqueue({ kind: "push" });
		await ship.drain(target());
		expect(gitSync(work, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`)).toBe(`origin/${branch}`);
	});

	it("pushes through the remote's own url even when pushInsteadOf would redirect it", async () => {
		const trap = path.join(tmp, "trap.git");
		gitSync(tmp, "init", "-q", "--bare", trap);
		gitSync(main, "config", `url.${trap}.pushInsteadOf`, remote);
		const sha = await commit(work, "a.txt");
		const ship = runner();
		ship.enqueue({ kind: "push" });
		const [result] = await ship.drain(target());
		expect(result?.failure).toBeUndefined();
		expect(remoteTip(`refs/heads/${branch}`)).toBe(sha);
		expect(gitSync(trap, "for-each-ref")).toBe("");
	});

	it("reports a refusal (non-fast-forward) as a rejected failure and never forces", async () => {
		await commit(work, "a.txt");
		const other = path.join(tmp, "other");
		gitSync(tmp, "clone", "-q", remote, other);
		gitSync(other, "config", "user.email", "t@example.com");
		gitSync(other, "config", "user.name", "T");
		gitSync(other, "checkout", "-q", "-b", branch);
		const theirs = await commit(other, "theirs.txt");
		gitSync(other, "push", "-q", "origin", branch);
		const ship = runner();
		ship.enqueue({ kind: "push" });
		const [result] = await ship.drain(target());
		expect(result).toMatchObject({ failure: "rejected", item: { state: "failed" } });
		expect(remoteTip(`refs/heads/${branch}`)).toBe(theirs);
	});

	it("says why a moved-on remote branch stopped the push: not a fast-forward, never forced", async () => {
		await commit(work, "a.txt");
		const other = path.join(tmp, "other");
		gitSync(tmp, "clone", "-q", remote, other);
		gitSync(other, "config", "user.email", "t@example.com");
		gitSync(other, "config", "user.name", "T");
		gitSync(other, "checkout", "-q", "-b", branch);
		await commit(other, "theirs.txt");
		gitSync(other, "push", "-q", "origin", branch);
		const ship = runner();
		ship.enqueue({ kind: "push" });
		const [result] = await ship.drain(target());
		expect(result?.item.detail).toMatch(
			new RegExp(
				`origin/${branch} has commits this run lacks \\(not a fast-forward\\); Autopilot never forces a push`,
			),
		);
	});

	describe("on a branch the user picked", () => {
		const picked = "feature/x";
		let pickedWork = "";

		beforeEach(() => {
			gitSync(main, "branch", picked);
			gitSync(main, "push", "-q", "origin", picked);
			pickedWork = path.join(tmp, "picked");
			gitSync(main, "worktree", "add", "-q", pickedWork, picked);
		});

		it("pushes it under the same name, journals that ref and leaves main and autopilot/ branches alone", async () => {
			const sha = await commit(pickedWork, "a.txt");
			const mainTip = remoteTip("refs/heads/main");
			const ship = runner();
			ship.enqueue({ kind: "push" });
			const [result] = await ship.drain(target({ root: pickedWork, branch: picked }));
			expect(result?.failure).toBeUndefined();
			expect(remoteTip(`refs/heads/${picked}`)).toBe(sha);
			expect(remoteTip("refs/heads/main")).toBe(mainTip);
			expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
			expect(actions).toEqual([{ kind: "push", refs: [`refs/remotes/origin/${picked}`], sha }]);
		});

		it("pushes the default branch itself when that is the run's branch, fast-forward only", async () => {
			gitSync(main, "switch", "-q", "-c", "dev");
			const onMain = path.join(tmp, "on-main");
			gitSync(main, "worktree", "add", "-q", onMain, "main");
			const sha = await commit(onMain, "a.txt");
			const ship = runner();
			ship.enqueue({ kind: "push" });
			const [result] = await ship.drain(target({ root: onMain, branch: "main" }));
			expect(result?.failure).toBeUndefined();
			expect(remoteTip("refs/heads/main")).toBe(sha);
			// The remote moved on meanwhile (somebody else's push): a second push is refused, never forced.
			const other = path.join(tmp, "other");
			gitSync(tmp, "clone", "-q", remote, other);
			gitSync(other, "config", "user.email", "t@example.com");
			gitSync(other, "config", "user.name", "T");
			const theirs = await commit(other, "theirs.txt");
			gitSync(other, "push", "-q", "origin", "main");
			await commit(onMain, "b.txt");
			ship.enqueue({ kind: "push" });
			const [second] = await ship.drain(target({ root: onMain, branch: "main" }));
			expect(second).toMatchObject({ failure: "rejected", item: { state: "failed" } });
			expect(remoteTip("refs/heads/main")).toBe(theirs);
		});
	});

	it("reports an unreachable remote as a network failure", async () => {
		await commit(work, "a.txt");
		gitSync(main, "remote", "set-url", "origin", path.join(tmp, "no-such-dir.git"));
		const ship = runner();
		ship.enqueue({ kind: "push" });
		const [result] = await ship.drain(target());
		expect(result?.item.state).toBe("failed");
		expect(result?.failure).toBeDefined();
	});
});

describe("pr", () => {
	it("pushes first when the branch is not on the remote yet, then opens a draft PR from the cycle log", async () => {
		const sha = await commit(work, "a.txt");
		const ship = runner();
		ship.enqueue({ kind: "pr" });
		const results = await ship.drain(target());
		expect(results.map(result => result.item.state)).toEqual(["done"]);
		expect(remoteTip(`refs/heads/${branch}`)).toBe(sha);
		expect(prs).toEqual([
			{ cwd: work, title: "autopilot/2026-10-17: 2 cycles", body: "# log", base: "main", head: branch, draft: true },
		]);
		expect(ship.queue()[0]).toMatchObject({ url: "https://github.com/o/r/pull/7" });
	});

	describe("on a run with a separate push target", () => {
		const dest = "feature/x";

		beforeEach(() => {
			gitSync(main, "branch", dest);
			gitSync(main, "push", "-q", "origin", dest);
		});

		it("pushes the work to the push target first (never the work branch) and opens the PR from the target", async () => {
			const sha = await commit(work, "a.txt");
			const ship = runner();
			ship.enqueue({ kind: "pr" });
			const results = await ship.drain(target({ pushTo: dest }));
			expect(results.map(result => result.item.state)).toEqual(["done"]);
			expect(remoteTip(`refs/heads/${dest}`)).toBe(sha);
			expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
			expect(prs).toMatchObject([{ base: "main", head: dest, draft: true }]);
		});

		it("refuses when the push target is the base branch: head and base would be the same branch", async () => {
			await commit(work, "a.txt");
			const mainTip = remoteTip("refs/heads/main");
			const ship = runner();
			ship.enqueue({ kind: "pr" });
			const [result] = await ship.drain(target({ pushTo: "main" }));
			expect(result).toMatchObject({ item: { state: "failed" } });
			expect(result?.item.detail).toMatch(/base branch/);
			expect(remoteTip("refs/heads/main")).toBe(mainTip);
			expect(prs).toEqual([]);
		});
	});
});
