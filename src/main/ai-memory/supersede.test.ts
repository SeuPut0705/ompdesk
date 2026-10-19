import { describe, expect, it } from "vitest";
import { pageToReplace, titleSimilarity } from "./supersede";

const known = [
	{ path: "decisions/use-sqlite-for-the-cache.md", title: "Use SQLite for the cache", global: false },
	{ path: "gotchas/use-sqlite-for-the-sessions.md", title: "Use SQLite for the sessions cache", global: false },
	{ path: "decisions/tailscale-only.md", title: "Computers share over Tailscale only", global: false },
	{ path: "preferences/one-line-rows.md", title: "Settings rows read on one line", global: true },
];

describe("pageToReplace", () => {
	it("without a named page, takes the same-kind page whose title is close enough, not an unrelated or other-kind one", () => {
		expect(titleSimilarity("Use SQLite for the cache", "Use SQLite for the session cache")).toBeGreaterThanOrEqual(
			0.6,
		);
		expect(pageToReplace({ kind: "decision", title: "Use SQLite for the session cache" }, known)?.path).toBe(
			"decisions/use-sqlite-for-the-cache.md",
		);
		expect(pageToReplace({ kind: "decision", title: "Pin the judge model to 1.14" }, known)).toBeNull();
		// The gotcha with a nearer title is another kind; a project page never stands in for a preference.
		expect(pageToReplace({ kind: "rule", title: "Use SQLite for the session cache" }, known)).toBeNull();
		expect(pageToReplace({ kind: "preference", title: "Use SQLite for the session cache" }, known)).toBeNull();
	});

	it("a named page wins over the title rule, within the proposal's own scope", () => {
		expect(
			pageToReplace(
				{ kind: "decision", title: "Phones pair with a code", supersedes: "decisions/tailscale-only.md" },
				known,
			)?.path,
		).toBe("decisions/tailscale-only.md");
		expect(
			pageToReplace({ kind: "correction", title: "x", supersedes: "preferences/one-line-rows.md" }, known)?.path,
		).toBe("preferences/one-line-rows.md");
		expect(
			pageToReplace({ kind: "decision", title: "x", supersedes: "preferences/one-line-rows.md" }, known),
		).toBeNull();
	});

	it("a tie keeps the newer page (memory lists newest first)", () => {
		const twins = [
			{ path: "decisions/a.md", title: "Use SQLite for the cache", global: false },
			{ path: "decisions/b.md", title: "Use SQLite for the cache", global: false },
		];
		expect(pageToReplace({ kind: "decision", title: "Use SQLite for the session cache" }, twins)?.path).toBe(
			"decisions/a.md",
		);
	});
});
