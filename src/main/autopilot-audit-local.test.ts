import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type AuditScope, type AuditSnapshot, auditCycle, takeSnapshot } from "./autopilot-audit";
import { audit, commit, installAuditRig, main, scope, tmp, work } from "./autopilot-audit-test-rig";
import { gitSync } from "./local/git/test-repos";

// Split from autopilot-audit.test.ts so the halves run side by side (each case runs real git dozens of times).
installAuditRig();

describe("auditCycle", () => {
	it("catches tags: any in a local-only run, only new v* tags inside the release scope", async () => {
		const before = await takeSnapshot(work, main);
		gitSync(work, "tag", "v1.2.3");
		expect((await audit(before)).map(v => v.kind)).toEqual(["ref"]);
		expect(await audit(before, { release: true })).toEqual([]);
		gitSync(work, "tag", "stray");
		expect((await audit(before, { release: true })).map(v => v.detail)).toEqual([
			expect.stringContaining("refs/tags/stray"),
		]);
	});

	it("catches a deleted tag even in the release scope", async () => {
		gitSync(work, "tag", "v1.0.0");
		const before = await takeSnapshot(work, main);
		gitSync(work, "tag", "-d", "v1.0.0");
		expect((await audit(before, { release: true })).map(v => v.kind)).toEqual(["ref"]);
	});

	it("allows the remote default branch inside the release scope", async () => {
		const before = await takeSnapshot(work, main);
		await commit(work, "a.txt");
		gitSync(work, "push", "-q", "origin", "HEAD:main");
		expect((await audit(before)).map(v => v.kind)).toEqual(["ref"]);
		expect(await audit(before, { release: true })).toEqual([]);
	});

	it("catches a reset, an amend and a rebase of the own branch (tip is no descendant of the old one)", async () => {
		await commit(work, "a.txt");
		const before = await takeSnapshot(work, main);
		gitSync(work, "reset", "-q", "--hard", "HEAD~1");
		expect(await audit(before)).toEqual([expect.objectContaining({ kind: "history" })]);
		await commit(work, "a.txt");
		const second = await takeSnapshot(work, main);
		gitSync(work, "commit", "-q", "--amend", "-m", "reworded");
		expect(await audit(second)).toEqual([expect.objectContaining({ kind: "history" })]);
	});

	it("accepts a revert as a descendant", async () => {
		await commit(work, "a.txt");
		const before = await takeSnapshot(work, main);
		gitSync(work, "revert", "--no-edit", "HEAD");
		expect(await audit(before)).toEqual([]);
	});

	it("catches a change to a local branch of the user's, and a merge into main unless the ShipRunner did it", async () => {
		await commit(work, "a.txt");
		const before = await takeSnapshot(work, main);
		gitSync(main, "merge", "-q", "--ff-only", "autopilot/2026-10-17");
		const violations = await audit(before);
		expect(violations.map(v => v.kind).sort()).toEqual(["checkout", "ref"]);
		expect(await audit(before, { expectedRefs: ["refs/heads/main"], checkoutMayMove: true })).toEqual([]);
	});

	it("catches a git config write (a remote added, a pushurl changed)", async () => {
		const before = await takeSnapshot(work, main);
		gitSync(work, "config", "remote.origin.pushurl", "/somewhere/else.git");
		expect(await audit(before)).toEqual([expect.objectContaining({ kind: "config" })]);
	});

	it("catches the default checkout switching branches without a ship action", async () => {
		const before = await takeSnapshot(work, main);
		gitSync(main, "checkout", "-q", "-b", "detour");
		const kinds = (await audit(before)).map(v => v.kind);
		expect(kinds).toContain("checkout");
	});

	it("ignores uncommitted edits in the default checkout (the user's own work)", async () => {
		const before = await takeSnapshot(work, main);
		await fs.writeFile(path.join(main, "README.md"), "user typing\n");
		expect(await audit(before)).toEqual([]);
	});
});

describe("auditCycle on a branch the user picked", () => {
	const picked = "feature/x";
	let picked_work = "";

	beforeEach(() => {
		gitSync(main, "branch", picked);
		picked_work = path.join(tmp, "picked");
		gitSync(main, "worktree", "add", "-q", picked_work, picked);
	});

	const auditPicked = async (before: AuditSnapshot, over: Partial<AuditScope> = {}) =>
		auditCycle(picked_work, before, await takeSnapshot(picked_work, main), scope({ branch: picked, ...over }));

	it("passes commits on the chosen branch, whatever its name", async () => {
		const before = await takeSnapshot(picked_work, main);
		await commit(picked_work, "a.txt");
		expect(await auditPicked(before)).toEqual([]);
	});

	it("the `autopilot/` prefix no longer buys anything: a branch under it that is not the chosen one is a violation", async () => {
		const before = await takeSnapshot(picked_work, main);
		gitSync(picked_work, "branch", "autopilot/sneaky");
		expect((await auditPicked(before)).map(v => v.detail)).toEqual(["refs/heads/autopilot/sneaky created"]);
	});

	it("catches a push of the chosen branch the ShipRunner did not journal, and allows the journaled one", async () => {
		const before = await takeSnapshot(picked_work, main);
		await commit(picked_work, "a.txt");
		gitSync(picked_work, "push", "-q", "origin", `HEAD:refs/heads/${picked}`);
		expect((await auditPicked(before)).map(v => v.detail)).toEqual([`refs/remotes/origin/${picked} created`]);
		expect(await auditPicked(before, { expectedRefs: [`refs/remotes/origin/${picked}`] })).toEqual([]);
	});

	it("catches a reset or amend of the chosen branch and its deletion", async () => {
		await commit(picked_work, "a.txt");
		const before = await takeSnapshot(picked_work, main);
		gitSync(picked_work, "reset", "-q", "--hard", "HEAD~1");
		expect((await auditPicked(before)).map(v => v.kind)).toEqual(["history"]);
		const another = await takeSnapshot(picked_work, main);
		gitSync(picked_work, "switch", "-q", "--detach");
		gitSync(main, "branch", "-D", picked);
		expect((await auditPicked(another)).map(v => v.kind)).toContain("history");
	});

	it("on the default branch the audit still lets only the journaled push move the remote main", async () => {
		gitSync(main, "switch", "-q", "-c", "dev");
		gitSync(picked_work, "switch", "-q", "--detach");
		const dir = path.join(tmp, "on-main");
		gitSync(main, "worktree", "add", "-q", dir, "main");
		const before = await takeSnapshot(dir, main);
		await commit(dir, "a.txt");
		gitSync(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
		const after = await takeSnapshot(dir, main);
		const own = scope({ branch: "main" });
		expect((await auditCycle(dir, before, after, own)).map(v => v.detail)).toEqual([
			"refs/remotes/origin/main moved",
		]);
		expect(await auditCycle(dir, before, after, { ...own, expectedRefs: ["refs/remotes/origin/main"] })).toEqual([]);
	});
});
