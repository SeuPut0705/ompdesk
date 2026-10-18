import { describe, expect, it } from "vitest";
import {
	branchEntries,
	branchProblem,
	branchSlug,
	initialChoice,
	isDefaultBranchChoice,
	isValidBranchName,
	lastChoiceOf,
	parseChoice,
	parseWorktreeBranches,
	pickDefaultBranch,
	runIdFor,
	suggestBranchName,
	validBranchPref,
	worktreeModeFor,
} from "./autopilot-branch";

const facts = {
	locals: ["feature/login", "dev", "main", "release/1"],
	remotes: ["main", "hotfix", "feature/login"],
	worktrees: { dev: "/work/app", "release/1": "/wt/gui-r" },
	current: "dev",
	defaultBranch: "main",
};

describe("the picker list", () => {
	it("puts the default branch first, then the folder's own branch, and merges local and remote rows", () => {
		const entries = branchEntries(facts);
		expect(entries.map(entry => entry.name)).toEqual(["main", "dev", "feature/login", "release/1", "hotfix"]);
		expect(entries[0]).toMatchObject({ name: "main", local: true, remote: true, default: true, current: false });
		expect(entries[2]).toMatchObject({ name: "feature/login", local: true, remote: true, default: false });
		expect(entries[4]).toMatchObject({ name: "hotfix", local: false, remote: true });
	});

	it("marks a branch another worktree has checked out, with where", () => {
		const entries = branchEntries(facts);
		expect(entries.find(entry => entry.name === "dev")).toMatchObject({ current: true, checkedOutAt: "/work/app" });
		expect(entries.find(entry => entry.name === "release/1")).toMatchObject({ checkedOutAt: "/wt/gui-r" });
		expect(entries.find(entry => entry.name === "main")).not.toHaveProperty("checkedOutAt");
	});

	it("reads the branch of each worktree from `git worktree list --porcelain`", () => {
		const porcelain = [
			"worktree /work/app",
			"HEAD aaa",
			"branch refs/heads/dev",
			"",
			"worktree /wt/gui-r",
			"HEAD bbb",
			"branch refs/heads/release/1",
			"",
			"worktree /wt/detached",
			"HEAD ccc",
			"detached",
			"",
		].join("\n");
		expect(parseWorktreeBranches(porcelain)).toEqual({ dev: "/work/app", "release/1": "/wt/gui-r" });
	});

	it("finds the default branch: the remote's HEAD, else main, else master, else none", () => {
		expect(pickDefaultBranch("trunk", ["main"])).toBe("trunk");
		expect(pickDefaultBranch(null, ["x", "master", "main"])).toBe("main");
		expect(pickDefaultBranch(null, ["x", "master"])).toBe("master");
		expect(pickDefaultBranch(null, ["x"])).toBeNull();
	});
});

describe("what a run may take", () => {
	const entries = branchEntries(facts);

	it("refuses a branch another worktree has checked out, naming the folder", () => {
		expect(branchProblem({ kind: "existing", name: "dev" }, entries)).toEqual({
			code: "checked_out",
			path: "/work/app",
		});
		expect(branchProblem({ kind: "existing", name: "release/1" }, entries)).toEqual({
			code: "checked_out",
			path: "/wt/gui-r",
		});
	});

	it("takes a free local branch, a remote-only branch and the default branch when it is free", () => {
		expect(branchProblem({ kind: "existing", name: "feature/login" }, entries)).toBeNull();
		expect(branchProblem({ kind: "existing", name: "hotfix" }, entries)).toBeNull();
		expect(branchProblem({ kind: "existing", name: "main" }, entries)).toBeNull();
		expect(worktreeModeFor({ kind: "existing", name: "feature/login" }, entries)).toBe("local");
		expect(worktreeModeFor({ kind: "existing", name: "hotfix" }, entries)).toBe("remote");
		expect(worktreeModeFor({ kind: "new" }, entries)).toBe("new");
	});

	it("refuses a branch that is gone", () => {
		expect(branchProblem({ kind: "existing", name: "nope" }, entries)).toEqual({ code: "missing" });
	});

	it("a new branch needs a valid name that nobody has", () => {
		expect(branchProblem({ kind: "new" }, entries)).toBeNull();
		expect(branchProblem({ kind: "new", name: "autopilot/x" }, entries)).toBeNull();
		expect(branchProblem({ kind: "new", name: "dev" }, entries)).toEqual({ code: "exists" });
		expect(branchProblem({ kind: "new", name: "hotfix" }, entries)).toEqual({ code: "exists" });
		expect(branchProblem({ kind: "new", name: "bad name" }, entries)).toEqual({ code: "invalid_name" });
	});

	it("warns only for the default branch, and only when it was picked explicitly", () => {
		expect(isDefaultBranchChoice({ kind: "existing", name: "main" }, entries)).toBe(true);
		expect(isDefaultBranchChoice({ kind: "existing", name: "feature/login" }, entries)).toBe(false);
		expect(isDefaultBranchChoice({ kind: "new" }, entries)).toBe(false);
		expect(isDefaultBranchChoice({ kind: "new", name: "main" }, entries)).toBe(false);
	});

	it("names branches the way git does", () => {
		for (const good of ["main", "feature/login", "autopilot/2026-10-18", "a.b", "v1.2"]) {
			expect(isValidBranchName(good), good).toBe(true);
		}
		for (const bad of [
			"",
			"-x",
			"a b",
			"a..b",
			"a~1",
			"a^",
			"a:b",
			"a?",
			"a*",
			"a[",
			"a\\b",
			"/a",
			"a/",
			"a//b",
			"a.lock",
			"a.",
			"@",
			"a@{b",
			".a",
			"a/.b",
		]) {
			expect(isValidBranchName(bad), bad).toBe(false);
		}
	});
});

describe("names and ids", () => {
	it("suggests autopilot/<date>, then -2, -3 when taken", () => {
		expect(suggestBranchName("2026-10-18", new Set())).toBe("autopilot/2026-10-18");
		expect(suggestBranchName("2026-10-18", new Set(["autopilot/2026-10-18"]))).toBe("autopilot/2026-10-18-2");
		expect(suggestBranchName("2026-10-18", new Set(["autopilot/2026-10-18", "autopilot/2026-10-18-2"]))).toBe(
			"autopilot/2026-10-18-3",
		);
	});

	it("derives the folder slug and the run id from the branch (children are autopilot/<run>-c<N>-<area>)", () => {
		expect(branchSlug("feature/Login Page", "2026-10-18")).toBe("feature-login-page");
		expect(branchSlug("한글", "2026-10-18")).toBe("2026-10-18");
		expect(branchSlug("a".repeat(60), "x")).toHaveLength(41);
		expect(runIdFor("autopilot/2026-10-18-2", "d")).toBe("2026-10-18-2");
		expect(runIdFor("autopilot/team/x", "d")).toBe("team-x");
		expect(runIdFor("main", "2026-10-18")).toBe("2026-10-18");
		expect(runIdFor("feature/login", "2026-10-18")).toBe("2026-10-18");
	});
});

describe("the choice remembered per repository", () => {
	const entries = branchEntries(facts);

	it("prefills the next sheet while the branch is still usable, else a new branch", () => {
		expect(initialChoice({ kind: "existing", name: "feature/login" }, entries)).toEqual({
			kind: "existing",
			name: "feature/login",
		});
		// Checked out elsewhere now, or deleted since: back to the default.
		expect(initialChoice({ kind: "existing", name: "dev" }, entries)).toEqual({ kind: "new" });
		expect(initialChoice({ kind: "existing", name: "gone" }, entries)).toEqual({ kind: "new" });
		expect(initialChoice({ kind: "new", name: "dev" }, entries)).toEqual({ kind: "new" });
		expect(initialChoice({ kind: "new", name: "mine" }, entries)).toEqual({ kind: "new", name: "mine" });
		expect(initialChoice(undefined, entries)).toEqual({ kind: "new" });
	});

	it("reads the pref per repository and tolerates a hand-edited value", () => {
		const pref = { "/repo/a": { kind: "existing", name: "dev" }, "/repo/b": { kind: "nope" }, "/repo/c": 3 };
		expect(lastChoiceOf(pref, "/repo/a")).toEqual({ kind: "existing", name: "dev" });
		expect(lastChoiceOf(pref, "/repo/b")).toBeNull();
		expect(lastChoiceOf(pref, "/repo/c")).toBeNull();
		expect(lastChoiceOf(pref, "/repo/none")).toBeNull();
		expect(lastChoiceOf("x", "/repo/a")).toBeNull();
		expect(parseChoice({ kind: "existing", name: "" })).toBeNull();
	});

	it("accepts only a map of well-formed choices as the pref value", () => {
		expect(validBranchPref({ "/r": { kind: "new" }, "/s": { kind: "existing", name: "dev" } })).toBe(true);
		expect(validBranchPref({})).toBe(true);
		expect(validBranchPref({ "/r": { kind: "existing" } })).toBe(false);
		expect(validBranchPref([])).toBe(false);
		expect(validBranchPref("dev")).toBe(false);
		expect(validBranchPref(null)).toBe(false);
	});
});
