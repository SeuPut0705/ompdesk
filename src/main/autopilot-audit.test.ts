import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { diffRefs, takeSnapshot } from "./autopilot-audit";
import { audit, commit, installAuditRig, main, remote, tmp, work } from "./autopilot-audit-test-rig";
import { gitSync } from "./local/git/test-repos";

installAuditRig();

describe("diffRefs", () => {
	it("lists created, moved and deleted refs", () => {
		expect(
			diffRefs(
				{ "refs/heads/a": "1", "refs/heads/b": "2", "refs/heads/c": "3" },
				{ "refs/heads/a": "1", "refs/heads/b": "9", "refs/heads/d": "4" },
			),
		).toEqual([
			{ ref: "refs/heads/b", from: "2", to: "9" },
			{ ref: "refs/heads/c", from: "3", to: null },
			{ ref: "refs/heads/d", from: null, to: "4" },
		]);
	});
});

describe("auditCycle", () => {
	it("passes a cycle that only committed on its own branch", async () => {
		const before = await takeSnapshot(work, main);
		await commit(work, "a.txt");
		await commit(work, "b.txt");
		expect(await audit(before)).toEqual([]);
	});

	it("passes children's branches that were named to it", async () => {
		const before = await takeSnapshot(work, main);
		gitSync(work, "branch", "omp/agent/perf");
		expect(await audit(before, { childBranches: ["omp/agent/perf"] })).toEqual([]);
		expect((await audit(before)).map(v => v.kind)).toEqual(["ref"]);
	});

	it("catches a push to the remote the agent was not allowed to make", async () => {
		const before = await takeSnapshot(work, main);
		await commit(work, "a.txt");
		gitSync(work, "push", "-q", "origin", "HEAD:refs/heads/autopilot/2026-10-17");
		const violations = await audit(before);
		expect(violations).toEqual([
			expect.objectContaining({
				kind: "ref",
				detail: expect.stringContaining("refs/remotes/origin/autopilot/2026-10-17"),
			}),
		]);
	});

	it("allows exactly the ref moves the ShipRunner journaled", async () => {
		const before = await takeSnapshot(work, main);
		await commit(work, "a.txt");
		gitSync(work, "push", "-q", "origin", "HEAD:refs/heads/autopilot/2026-10-17");
		expect(await audit(before, { expectedRefs: ["refs/remotes/origin/autopilot/2026-10-17"] })).toEqual([]);
		gitSync(work, "push", "-q", "origin", "HEAD:refs/heads/other");
		expect(
			(await audit(before, { expectedRefs: ["refs/remotes/origin/autopilot/2026-10-17"] })).map(v => v.detail),
		).toEqual([expect.stringContaining("refs/remotes/origin/other")]);
	});

	it("tolerates a fetch that moved a remote-tracking ref", async () => {
		const other = path.join(tmp, "other");
		gitSync(tmp, "clone", "-q", remote, other);
		gitSync(other, "config", "user.email", "t@example.com");
		gitSync(other, "config", "user.name", "T");
		const before = await takeSnapshot(work, main);
		await commit(other, "theirs.txt");
		gitSync(other, "push", "-q", "origin", "main");
		gitSync(main, "fetch", "-q", "origin");
		expect(await audit(before)).toEqual([]);
	});

	it("tolerates a fetch that moved the remote branch origin/HEAD points at (a clone's symbolic ref)", async () => {
		gitSync(main, "remote", "set-head", "origin", "main");
		const other = path.join(tmp, "other");
		gitSync(tmp, "clone", "-q", remote, other);
		gitSync(other, "config", "user.email", "t@example.com");
		gitSync(other, "config", "user.name", "t");
		const before = await takeSnapshot(work, main);
		await commit(other, "theirs.txt");
		gitSync(other, "push", "-q", "origin", "main");
		gitSync(main, "fetch", "-q", "origin");
		expect(await audit(before)).toEqual([]);
	});

	it("tolerates another session's push from another worktree of the repository, and still catches the run's own", async () => {
		const peer = path.join(tmp, "peer");
		gitSync(main, "worktree", "add", "-q", "--detach", peer);
		await commit(work, "mine.txt");
		const before = await takeSnapshot(work, main);
		await commit(peer, "theirs.txt");
		gitSync(peer, "push", "-q", "origin", "HEAD:main");
		gitSync(peer, "push", "-q", "origin", "HEAD:refs/heads/their-feature");
		expect(await audit(before)).toEqual([]);
		await commit(work, "more.txt");
		gitSync(work, "push", "-q", "origin", "HEAD:refs/heads/mine-pushed");
		expect((await audit(before)).map(v => v.detail)).toEqual(["refs/remotes/origin/mine-pushed created"]);
	});

	it("catches the run pushing its unchanged branch to a new remote branch", async () => {
		await commit(work, "mine.txt");
		const before = await takeSnapshot(work, main);
		gitSync(work, "push", "-q", "origin", "HEAD:refs/heads/mine-again");
		expect((await audit(before)).map(v => v.detail)).toEqual(["refs/remotes/origin/mine-again created"]);
	});

	it("still catches a remote-tracking ref moved backwards or deleted", async () => {
		const peer = path.join(tmp, "peer");
		gitSync(main, "worktree", "add", "-q", "--detach", peer);
		await commit(peer, "theirs.txt");
		gitSync(peer, "push", "-q", "origin", "HEAD:refs/heads/side");
		const before = await takeSnapshot(work, main);
		gitSync(peer, "push", "-q", "--force", "origin", "HEAD~1:refs/heads/side");
		expect((await audit(before)).map(v => v.detail)).toEqual(["refs/remotes/origin/side moved"]);
		gitSync(peer, "push", "-q", "origin", ":refs/heads/side");
		expect((await audit(before)).map(v => v.detail)).toEqual(["refs/remotes/origin/side deleted"]);
	});

	it("tolerates another session's branch in its own worktree and the user's pull in the default checkout", async () => {
		await commit(work, "mine.txt");
		const other = path.join(tmp, "other");
		gitSync(tmp, "clone", "-q", remote, other);
		gitSync(other, "config", "user.email", "t@example.com");
		gitSync(other, "config", "user.name", "t");
		const before = await takeSnapshot(work, main);
		const peer = path.join(tmp, "peer");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/peer", peer);
		await commit(peer, "theirs.txt");
		await commit(other, "upstream.txt");
		gitSync(other, "push", "-q", "origin", "main");
		gitSync(main, "pull", "-q", "--ff-only", "origin", "main");
		expect(await audit(before)).toEqual([]);
		gitSync(work, "branch", "sneaky");
		expect((await audit(before)).map(v => v.detail)).toEqual(["refs/heads/sneaky created"]);
	});
});
