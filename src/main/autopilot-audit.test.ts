import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditScope, type AuditSnapshot, auditCycle, diffRefs, takeSnapshot } from "./autopilot-audit";
import { gitSync, initRepo } from "./local/git/test-repos";

let tmp = "";
let main = "";
let remote = "";
let work = "";

const scope = (over: Partial<AuditScope> = {}): AuditScope => ({
	branch: "autopilot/2026-10-17",
	childBranches: [],
	remote: "origin",
	defaultBranch: "main",
	release: false,
	expectedRefs: [],
	checkoutMayMove: false,
	configMayChange: false,
	...over,
});

async function commit(cwd: string, file: string): Promise<string> {
	await fs.writeFile(path.join(cwd, file), `${file}\n`);
	gitSync(cwd, "add", file);
	gitSync(cwd, "commit", "-q", "-m", file);
	return gitSync(cwd, "rev-parse", "HEAD");
}

async function audit(before: AuditSnapshot, over: Partial<AuditScope> = {}) {
	const after = await takeSnapshot(work, main);
	return auditCycle(work, before, after, scope(over));
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-audit-")));
	main = path.join(tmp, "main");
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	await initRepo(main);
	gitSync(tmp, "init", "-q", "--bare", "-b", "main", remote);
	gitSync(main, "remote", "add", "origin", remote);
	gitSync(main, "push", "-q", "origin", "main");
	gitSync(main, "fetch", "-q", "origin");
	gitSync(main, "worktree", "add", "-q", "-b", "autopilot/2026-10-17", work);
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

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
