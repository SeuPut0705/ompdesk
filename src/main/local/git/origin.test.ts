import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectOrigin, resetProjectOriginCache } from "./origin";
import { gitSync, initRepo } from "./test-repos";

let root: string;
let repo: string;

beforeEach(async () => {
	resetProjectOriginCache();
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-origin-")));
	repo = path.join(root, "acme-web");
	await initRepo(repo);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Like `worktree_create`: `<root>/gui-<name>-<hash7>` on `<branch>`. */
function linked(name: string, branch: string): string {
	const dir = path.join(root, `gui-${name}-1ccaba4`);
	gitSync(repo, "worktree", "add", "-q", "-b", branch, dir);
	return dir;
}

describe("readProjectOrigin", () => {
	it("a main checkout is its folder name with no worktree, from a subfolder too", async () => {
		await fs.mkdir(path.join(repo, "src"));
		expect(await readProjectOrigin(repo)).toEqual({ project: "acme-web", root: repo, worktree: null });
		expect(await readProjectOrigin(path.join(repo, "src"))).toEqual({
			project: "acme-web",
			root: repo,
			worktree: null,
		});
	});

	it("an Autopilot worktree names the project and the run, never its own folder", async () => {
		const dir = linked("2026-10-17", "autopilot/2026-10-17");
		expect(await readProjectOrigin(dir)).toEqual({
			project: "acme-web",
			root: repo,
			worktree: { kind: "autopilot", branch: "autopilot/2026-10-17", slug: "2026-10-17" },
		});
	});

	it("a parallel child's worktree is an agent worktree", async () => {
		const dir = linked("agent-5wxp8i", "omp/agent/agent-5wxp8i");
		const origin = await readProjectOrigin(dir);
		expect(origin?.project).toBe("acme-web");
		expect(origin?.worktree).toMatchObject({ kind: "agent", branch: "omp/agent/agent-5wxp8i" });
	});

	it("a manual worktree on any other branch is `other`; detached HEAD has no branch", async () => {
		const manual = linked("feature", "omp/gui/feature");
		expect((await readProjectOrigin(manual))?.worktree).toMatchObject({ kind: "other", branch: "omp/gui/feature" });
		const detached = path.join(root, "gui-detached-0123456");
		gitSync(repo, "worktree", "add", "-q", "--detach", detached);
		expect((await readProjectOrigin(detached))?.worktree).toEqual({ kind: "other", branch: null, slug: "detached" });
	});

	it("is null for a folder git cannot place: not a repository, a removed worktree, a missing folder", async () => {
		const plain = path.join(root, "plain");
		await fs.mkdir(plain);
		expect(await readProjectOrigin(plain)).toBeNull();
		const dir = linked("gone", "autopilot/gone");
		gitSync(repo, "worktree", "remove", "--force", dir);
		expect(await readProjectOrigin(dir)).toBeNull();
		expect(await readProjectOrigin(path.join(root, "never-existed"))).toBeNull();
	});

	it("a bare repository's worktree names the project from the first listed checkout", async () => {
		const bare = path.join(root, "acme-api.git");
		gitSync(root, "clone", "-q", "--bare", repo, bare);
		const dir = path.join(root, "gui-bare-1234567");
		gitSync(bare, "worktree", "add", "-q", "-b", "autopilot/b", dir);
		const origin = await readProjectOrigin(dir);
		expect(origin?.project).toBe("acme-api");
		expect(origin?.worktree).toMatchObject({ kind: "autopilot" });
	});

	it("answers a folder from the cache until its time is up", async () => {
		let clock = 1_000;
		const dir = linked("cached", "autopilot/cached");
		const first = await readProjectOrigin(dir, () => clock);
		gitSync(dir, "switch", "-q", "-c", "omp/agent/renamed");
		clock += 1_000;
		expect(await readProjectOrigin(dir, () => clock)).toBe(first);
		clock += 60_000;
		expect((await readProjectOrigin(dir, () => clock))?.worktree?.kind).toBe("agent");
	});
});
