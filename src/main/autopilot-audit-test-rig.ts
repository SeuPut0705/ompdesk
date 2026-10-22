// Shared world of the autopilot-audit*.test.ts files: a repository with a remote and the run's worktree.
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { type AuditScope, type AuditSnapshot, auditCycle, takeSnapshot } from "./autopilot-audit";
import { gitSync, initRepoWithRemote } from "./local/git/test-repos";

export let tmp = "";
export let main = "";
export let remote = "";
export let work = "";

export const scope = (over: Partial<AuditScope> = {}): AuditScope => ({
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

export async function commit(cwd: string, file: string): Promise<string> {
	await fs.writeFile(path.join(cwd, file), `${file}\n`);
	gitSync(cwd, "add", file);
	gitSync(cwd, "commit", "-q", "-m", file);
	return gitSync(cwd, "rev-parse", "HEAD");
}

export async function audit(before: AuditSnapshot, over: Partial<AuditScope> = {}) {
	const after = await takeSnapshot(work, main);
	return auditCycle(work, before, after, scope(over));
}

export function installAuditRig(): void {
	beforeEach(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "autopilot-audit-")));
		main = path.join(tmp, "main");
		remote = path.join(tmp, "remote.git");
		work = path.join(tmp, "work");
		await initRepoWithRemote(main, remote);
		gitSync(main, "worktree", "add", "-q", "-b", "autopilot/2026-10-17", work);
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});
}
