/**
 * The ship runner's merge into the default checkout and its revert of a cycle, on real temp repos. Split from
 * `autopilot-ship.test.ts` (queue, push, PR) so the two files' git runs go side by side: one file of 24 cases was 44 s
 * on the Windows platform job.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	actions,
	branch,
	commit,
	installShipRig,
	main,
	reverted,
	runner,
	target,
	work,
} from "./autopilot-ship-test-rig";
import { gitSync } from "./local/git/test-repos";

installShipRig();

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
