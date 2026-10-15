import { describe, expect, it } from "vitest";
import { worktreeBranchPrefix } from "./worktree-branch";

describe("worktreeBranchPrefix", () => {
	it("keeps prefixes git accepts before a branch name", () => {
		for (const prefix of ["alice/", "feat-", "team/alice/", "wip_", "v1.2/", " alice/ "]) {
			expect(worktreeBranchPrefix(prefix)).toBe(prefix.trim());
		}
	});

	it("refuses what git would reject or what would run into the name", () => {
		for (const prefix of [
			"",
			"alice",
			"/alice/",
			"-alice/",
			"a//b/",
			"a/../b/",
			".hidden/",
			"a/.x-",
			"x.lock/",
			"has space/",
			"a~b/",
			"a:b/",
			"x".repeat(40).concat("/"),
			42,
			null,
		]) {
			expect(worktreeBranchPrefix(prefix)).toBeNull();
		}
	});
});
