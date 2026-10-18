import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchProblem } from "../shared/autopilot-branch";
import { readBranchEntries, readBranchInfo } from "./autopilot-branches";
import { gitSync, initRepo } from "./local/git/test-repos";

let tmp: string;
let main: string;
let bare: string;

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-ap-branches-")));
	main = path.join(tmp, "app");
	bare = path.join(tmp, "remote.git");
	await initRepo(main);
	gitSync(tmp, "init", "-q", "--bare", bare);
	gitSync(main, "remote", "add", "origin", bare);
	gitSync(main, "push", "-q", "origin", "main");
	gitSync(main, "remote", "set-head", "origin", "main");
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("the repository's branches as the picker sees them", () => {
	it("lists local and remote branches once each, the default first, with where each is checked out", async () => {
		gitSync(main, "branch", "feature/a");
		gitSync(main, "branch", "feature/b");
		gitSync(main, "push", "-q", "origin", "feature/b", "feature/a:remote-only");
		gitSync(main, "branch", "-D", "feature/b");
		gitSync(main, "fetch", "-q", "origin");
		gitSync(main, "switch", "-q", "-c", "dev");
		const work = path.join(tmp, "wt-a");
		gitSync(main, "worktree", "add", "-q", work, "feature/a");

		const { entries, defaultBranch } = await readBranchEntries(main, "origin");
		expect(defaultBranch).toBe("main");
		// The default branch first, then the folder's own branch, then the rest in git's order.
		expect(entries.slice(0, 2).map(entry => entry.name)).toEqual(["main", "dev"]);
		const byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));
		expect(byName.main).toMatchObject({ local: true, remote: true, default: true, current: false });
		expect(byName.main).not.toHaveProperty("checkedOutAt");
		expect(byName.dev).toMatchObject({ local: true, remote: false, current: true, checkedOutAt: main });
		expect(byName["feature/a"]).toMatchObject({ local: true, remote: false, checkedOutAt: work });
		expect(byName["feature/b"]).toMatchObject({ local: false, remote: true });
		expect(entries.map(entry => entry.name).sort()).toEqual(["dev", "feature/a", "feature/b", "main", "remote-only"]);
		expect(entries).toHaveLength(5);
	});

	it("refuses the branch the user's folder is on and one a run's worktree holds, but not a free one", async () => {
		gitSync(main, "branch", "free");
		gitSync(main, "branch", "held");
		gitSync(main, "worktree", "add", "-q", path.join(tmp, "wt-held"), "held");
		const { entries } = await readBranchEntries(main, "origin");
		expect(branchProblem({ kind: "existing", name: "main" }, entries)).toEqual({ code: "checked_out", path: main });
		expect(branchProblem({ kind: "existing", name: "held" }, entries)).toEqual({
			code: "checked_out",
			path: path.join(tmp, "wt-held"),
		});
		expect(branchProblem({ kind: "existing", name: "free" }, entries)).toBeNull();
	});

	it("allows the default branch once the folder has moved off it", async () => {
		gitSync(main, "switch", "-q", "-c", "dev");
		const { entries } = await readBranchEntries(main, "origin");
		expect(branchProblem({ kind: "existing", name: "main" }, entries)).toBeNull();
	});

	it("finds the default branch without a remote HEAD, and none in a repository without main or master", async () => {
		gitSync(main, "remote", "set-head", "origin", "--delete");
		expect((await readBranchEntries(main, "origin")).defaultBranch).toBe("main");
		gitSync(main, "branch", "-m", "trunk");
		const none = await readBranchEntries(main, "nowhere");
		expect(none.defaultBranch).toBeNull();
		expect(none.entries.map(entry => entry.name)).toEqual(["trunk"]);
	});

	it("hands the sheet the repository key, a free suggestion and the remembered choice", async () => {
		gitSync(main, "branch", "autopilot/2026-10-18");
		const pref = { [main]: { kind: "existing", name: "autopilot/2026-10-18" }, "/elsewhere": { kind: "new" } };
		const info = await readBranchInfo(main, { toplevel: main, remote: "origin", date: "2026-10-18", pref });
		expect(info).toMatchObject({
			repo: main,
			remote: "origin",
			defaultBranch: "main",
			suggested: "autopilot/2026-10-18-2",
			last: { kind: "existing", name: "autopilot/2026-10-18" },
		});
		const bare2 = await readBranchInfo(main, {
			toplevel: main,
			remote: "origin",
			date: "2026-10-18",
			pref: undefined,
		});
		expect(bare2).not.toHaveProperty("last");
	});
});
