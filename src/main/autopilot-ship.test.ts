import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotShipActionParams, ShipQueueItem } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { classifyPushFailure, type ShipDeps, ShipRunner, type ShipTarget } from "./autopilot-ship";
import { gitSync, initRepo } from "./local/git/test-repos";

let tmp = "";
let main = "";
let remote = "";
let work = "";
let actions: AutopilotShipActionParams[] = [];
let broadcasts: ShipQueueItem[][] = [];
let reverted: number[] = [];
let prs: Array<{ cwd: string; title: string; body: string; base?: string; head?: string; draft?: boolean }> = [];

const branch = "autopilot/2026-10-17";

function target(over: Partial<ShipTarget> = {}): ShipTarget {
	return { root: work, checkoutRoot: main, branch, baseBranch: "main", remote: "origin", ...over };
}

function runner(over: Partial<ShipDeps> = {}): ShipRunner {
	let n = 0;
	return new ShipRunner({
		journal: async action => {
			actions.push(action);
		},
		changed: queue => {
			broadcasts.push(queue.map(item => ({ ...item })));
		},
		reverted: async cycle => {
			reverted.push(cycle);
		},
		prText: async () => ({ title: "autopilot/2026-10-17: 2 cycles", body: "# log" }),
		prCreate: async (cwd, input) => {
			prs.push({ cwd, ...input });
			return { url: "https://github.com/o/r/pull/7", number: 7 };
		},
		now: () => 1000 + n,
		id: () => `s${++n}`,
		...over,
	});
}

async function commit(cwd: string, file: string): Promise<string> {
	await fs.writeFile(path.join(cwd, file), `${file}\n`);
	gitSync(cwd, "add", file);
	gitSync(cwd, "commit", "-q", "-m", file);
	return gitSync(cwd, "rev-parse", "HEAD");
}

const remoteTip = (ref: string): string => gitSync(remote, "rev-parse", ref);

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-ship-")));
	main = path.join(tmp, "main");
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	actions = [];
	broadcasts = [];
	reverted = [];
	prs = [];
	await initRepo(main);
	gitSync(tmp, "init", "-q", "--bare", "-b", "main", remote);
	gitSync(main, "remote", "add", "origin", remote);
	gitSync(main, "push", "-q", "origin", "main");
	gitSync(main, "worktree", "add", "-q", "-b", branch, work);
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("classifyPushFailure", () => {
	it("tells a refusal from a network failure", () => {
		expect(classifyPushFailure("! [rejected] a -> a (non-fast-forward)")).toBe("rejected");
		expect(classifyPushFailure("remote: Permission to o/r.git denied to x.")).toBe("rejected");
		expect(
			classifyPushFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
		).toBe("rejected");
		expect(classifyPushFailure("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe("network");
		expect(classifyPushFailure("ssh: connect to host github.com port 22: Operation timed out")).toBe("network");
		expect(classifyPushFailure("something odd")).toBe("rejected");
	});
});

describe("ShipRunner queue", () => {
	it("shows queued → running → done in order and broadcasts every change", async () => {
		await commit(work, "a.txt");
		const ship = runner();
		const item = ship.enqueue({ kind: "push" });
		expect(item).toMatchObject({ kind: "push", state: "queued" });
		await ship.drain(target());
		expect(ship.queue().map(entry => entry.state)).toEqual(["done"]);
		const seen = broadcasts.map(queue => queue[0]?.state);
		expect(seen).toEqual(["queued", "running", "done"]);
	});

	it("cancels only an item that has not started", async () => {
		const ship = runner();
		const item = ship.enqueue({ kind: "push" });
		expect(ship.cancel(item.id)).toBe(true);
		expect(ship.queue()).toEqual([]);
		expect(ship.cancel("nope")).toBe(false);
	});

	it("one failed item does not stop the others", async () => {
		const sha = await commit(work, "a.txt");
		const ship = runner();
		ship.enqueue({ kind: "revert", cycle: 3, sha: "0000000000000000000000000000000000000000" });
		ship.enqueue({ kind: "push" });
		const results = await ship.drain(target());
		expect(results.map(result => result.item.state)).toEqual(["failed", "done"]);
		expect(remoteTip(`refs/heads/${branch}`)).toBe(sha);
	});

	it("keeps the newest release item while later pushes push the finished ones out", async () => {
		await commit(work, "a.txt");
		const ship = runner();
		const release = ship.track({ kind: "release", detail: "v1" });
		for (let i = 0; i < 25; i++)
			ship.enqueue({ kind: "revert", cycle: i, sha: "0000000000000000000000000000000000000000" });
		await ship.drain(target());
		ship.finish(release.id, "done", "ok");
		await ship.drain(target());
		expect(ship.queue().find(item => item.kind === "release")).toMatchObject({ state: "done" });
		expect(ship.queue().filter(item => item.kind === "revert").length).toBeLessThanOrEqual(20);
	});

	it("tracks a release for display only: the runner never executes it", async () => {
		const ship = runner();
		const item = ship.track({ kind: "release", detail: "v1.2.3" });
		expect(item.state).toBe("running");
		await ship.drain(target());
		expect(ship.queue()[0]?.state).toBe("running");
		ship.finish(item.id, "done", "run passed");
		expect(ship.queue()[0]).toMatchObject({ state: "done", detail: "run passed" });
	});
});

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
});

describe("merge", () => {
	it("fast-forwards the default checkout when it is on the base branch and clean", async () => {
		const sha = await commit(work, "a.txt");
		const ship = runner();
		ship.enqueue({ kind: "merge" });
		const [result] = await ship.drain(target());
		expect(result?.item.state).toBe("done");
		expect(gitSync(main, "rev-parse", "HEAD")).toBe(sha);
		expect(actions).toEqual([{ kind: "merge", refs: ["refs/heads/main"], sha }]);
	});

	it("refuses a default checkout that is on another branch or has uncommitted changes", async () => {
		await commit(work, "a.txt");
		await fs.writeFile(path.join(main, "README.md"), "dirty\n");
		const ship = runner();
		ship.enqueue({ kind: "merge" });
		expect((await ship.drain(target()))[0]?.item).toMatchObject({
			state: "failed",
			detail: expect.stringMatching(/clean|uncommitted/i),
		});
		gitSync(main, "checkout", "--", "README.md");
		gitSync(main, "checkout", "-q", "-b", "detour");
		ship.enqueue({ kind: "merge" });
		expect((await ship.drain(target()))[0]?.item).toMatchObject({
			state: "failed",
			detail: expect.stringContaining("main"),
		});
	});

	it("does not fast-forward a diverged base unless the merge-commit mode is chosen", async () => {
		await commit(work, "a.txt");
		await commit(main, "other.txt");
		const ship = runner();
		ship.enqueue({ kind: "merge" });
		expect((await ship.drain(target()))[0]?.item.state).toBe("failed");
		expect(gitSync(main, "log", "--oneline", "-1", "--format=%s")).toBe("other.txt");
		ship.enqueue({ kind: "merge", mode: "merge_commit" });
		expect((await ship.drain(target()))[0]?.item.state).toBe("done");
		expect(gitSync(main, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
	});

	it("aborts a conflicting merge and leaves the checkout clean", async () => {
		await fs.writeFile(path.join(work, "README.md"), "mine\n");
		gitSync(work, "commit", "-q", "-am", "mine");
		await fs.writeFile(path.join(main, "README.md"), "theirs\n");
		gitSync(main, "commit", "-q", "-am", "theirs");
		const ship = runner();
		ship.enqueue({ kind: "merge", mode: "merge_commit" });
		const [result] = await ship.drain(target());
		expect(result?.item.state).toBe("failed");
		expect(gitSync(main, "status", "--porcelain")).toBe("");
		expect((await fs.readFile(path.join(main, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("theirs\n");
	});
});

describe("revert", () => {
	it("reverts the cycle's commit as a new commit and reports the cycle reverted", async () => {
		const sha = await commit(work, "a.txt");
		const before = gitSync(work, "rev-parse", "HEAD");
		const ship = runner();
		ship.enqueue({ kind: "revert", cycle: 4, sha });
		const [result] = await ship.drain(target());
		expect(result?.item.state).toBe("done");
		expect(gitSync(work, "rev-parse", "HEAD~1")).toBe(before);
		await expect(fs.stat(path.join(work, "a.txt"))).rejects.toThrow();
		expect(reverted).toEqual([4]);
		expect(actions.map(action => action.kind)).toEqual(["revert"]);
	});

	it("aborts a conflicting revert", async () => {
		await fs.writeFile(path.join(work, "README.md"), "one\n");
		gitSync(work, "commit", "-q", "-am", "one");
		const first = gitSync(work, "rev-parse", "HEAD");
		await fs.writeFile(path.join(work, "README.md"), "two\n");
		gitSync(work, "commit", "-q", "-am", "two");
		const ship = runner();
		ship.enqueue({ kind: "revert", cycle: 1, sha: first });
		const [result] = await ship.drain(target());
		expect(result?.item.state).toBe("failed");
		expect(gitSync(work, "status", "--porcelain")).toBe("");
		expect(reverted).toEqual([]);
	});

	it("reverts a merge commit against its first parent", async () => {
		gitSync(work, "checkout", "-q", "-b", "side");
		await commit(work, "side.txt");
		gitSync(work, "checkout", "-q", branch);
		await commit(work, "own.txt");
		gitSync(work, "merge", "-q", "--no-ff", "-m", "merge side", "side");
		const merge = gitSync(work, "rev-parse", "HEAD");
		const ship = runner();
		ship.enqueue({ kind: "revert", cycle: 2, sha: merge });
		const [result] = await ship.drain(target());
		expect(result?.item.state).toBe("done");
		await expect(fs.stat(path.join(work, "side.txt"))).rejects.toThrow();
		await expect(fs.stat(path.join(work, "own.txt"))).resolves.toBeDefined();
	});
});
