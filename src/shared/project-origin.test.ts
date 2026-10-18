import { describe, expect, it } from "vitest";
import { autopilotChildBranch } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	autopilotRunOf,
	deriveProjectOrigin,
	type OriginFacts,
	pathBaseName,
	projectDisplayName,
	type WorktreeKindLabels,
	worktreeFolderSlug,
	worktreeKindOf,
	worktreeLabel,
} from "./project-origin";

const labels: WorktreeKindLabels = { autopilot: "오토파일럿", agent: "병렬 작업" };

function facts(overrides: Partial<OriginFacts> = {}): OriginFacts {
	return {
		commonDir: "/Users/me/acme-web/.git",
		gitDir: "/Users/me/acme-web/.git",
		branch: "main",
		toplevel: "/Users/me/acme-web",
		primary: null,
		...overrides,
	};
}

describe("worktreeKindOf", () => {
	it("tells an Autopilot run and a parallel child from the branch", () => {
		expect(worktreeKindOf("autopilot/2026-10-17")).toBe("autopilot");
		expect(worktreeKindOf("omp/agent/agent-5wxp8i")).toBe("agent");
		expect(worktreeKindOf("omp/gui/feature")).toBe("other");
		expect(worktreeKindOf(null)).toBe("other");
	});
});

describe("autopilotRunOf", () => {
	it("reads the run's own branch and its children's (the bridge's autopilotChildBranch)", () => {
		expect(autopilotRunOf("autopilot/2026-10-17")).toEqual({ run: "2026-10-17", child: false });
		expect(autopilotRunOf("autopilot/2026-10-17-2")).toEqual({ run: "2026-10-17-2", child: false });
		for (const [run, cycle, area] of [
			["2026-10-17", 2, "docs"],
			["2026-10-17-2", 14, "Bugs & UX"],
			["2026-10-17", 1, "!!"],
		] as const)
			expect(autopilotRunOf(autopilotChildBranch(run, cycle, area))).toEqual({ run, child: true });
		expect(autopilotRunOf("omp/agent/agent-5wxp8i")).toBeNull();
		expect(autopilotRunOf(null)).toBeNull();
	});
});

describe("worktreeFolderSlug / pathBaseName", () => {
	it("strips OMPdesk's gui-<name>-<hash7> dressing and nothing else", () => {
		expect(worktreeFolderSlug("/Users/me/.omp/wt/abc/gui-2026-10-17-1ccaba4")).toBe("2026-10-17");
		expect(worktreeFolderSlug("/Users/me/.omp/wt/abc/gui-agent-5wxp8i-23abcde")).toBe("agent-5wxp8i");
		expect(worktreeFolderSlug("/work/acme-web")).toBe("acme-web");
		expect(worktreeFolderSlug("C:\\work\\gui-x-0123456\\")).toBe("x");
	});

	it("reads either separator and ignores trailing ones", () => {
		expect(pathBaseName("/a/b/")).toBe("b");
		expect(pathBaseName("C:\\a\\b")).toBe("b");
		expect(pathBaseName("")).toBe("");
	});
});

describe("deriveProjectOrigin", () => {
	it("a main checkout is its folder name and no worktree", () => {
		expect(deriveProjectOrigin(facts())).toEqual({ project: "acme-web", root: "/Users/me/acme-web", worktree: null });
	});

	it("a linked worktree names the main checkout, not its own folder", () => {
		const origin = deriveProjectOrigin(
			facts({
				gitDir: "/Users/me/acme-web/.git/worktrees/gui-2026-10-17-1ccaba4",
				branch: "autopilot/2026-10-17",
				toplevel: "/Users/me/.omp/wt/h/gui-2026-10-17-1ccaba4",
			}),
		);
		expect(origin).toEqual({
			project: "acme-web",
			root: "/Users/me/acme-web",
			worktree: { kind: "autopilot", branch: "autopilot/2026-10-17", slug: "2026-10-17" },
		});
	});

	it("a detached worktree is still a worktree, with no branch", () => {
		const origin = deriveProjectOrigin(
			facts({
				gitDir: "/Users/me/acme-web/.git/worktrees/x",
				branch: null,
				toplevel: "/Users/me/.omp/wt/h/gui-fix-1234567",
			}),
		);
		expect(origin?.worktree).toEqual({ kind: "other", branch: null, slug: "fix" });
		expect(worktreeLabel(origin as NonNullable<typeof origin>, labels)).toBe("fix");
	});

	it("a bare or relocated git dir takes the first listed worktree", () => {
		expect(
			deriveProjectOrigin(
				facts({
					commonDir: "/srv/git/acme-web.git",
					gitDir: "/srv/git/acme-web.git",
					toplevel: null,
					primary: "/srv/git/acme-web.git",
				}),
			),
		).toEqual({ project: "acme-web", root: "/srv/git/acme-web.git", worktree: null });
		expect(
			deriveProjectOrigin(
				facts({ commonDir: "/srv/elsewhere/store", gitDir: "/srv/elsewhere/store", primary: null }),
			),
		).toBeNull();
	});
});

describe("labels", () => {
	const linked = (branch: string | null) =>
		deriveProjectOrigin(facts({ gitDir: "/Users/me/acme-web/.git/worktrees/w", branch, toplevel: "/wt/w" }));

	it("an Autopilot run reads as its kind, a child as its title (else its kind), another worktree as its branch", () => {
		expect(projectDisplayName(linked("autopilot/x"), "gui-x", labels)).toBe("acme-web · 오토파일럿");
		expect(projectDisplayName(linked("omp/agent/agent-1"), "gui-x", labels, "Approach A")).toBe(
			"acme-web · Approach A",
		);
		expect(projectDisplayName(linked("omp/agent/agent-1"), "gui-x", labels, "  ")).toBe("acme-web · 병렬 작업");
		expect(projectDisplayName(linked("omp/gui/feature"), "gui-x", labels)).toBe("acme-web · omp/gui/feature");
	});

	it("a main checkout and an unknown folder keep the fallback", () => {
		expect(projectDisplayName(deriveProjectOrigin(facts()), "acme-web", labels)).toBe("acme-web");
		expect(projectDisplayName(null, "gone", labels)).toBe("gone");
	});
});
