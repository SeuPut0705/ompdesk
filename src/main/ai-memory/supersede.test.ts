import { describe, expect, it } from "vitest";
import { pageToReplace } from "./supersede";

const known = [
	{ path: "_rules/run-the-checks-before-pushing.md", title: "Run the checks before pushing", global: false },
	{ path: "decisions/tailscale-only.md", title: "Computers share over Tailscale only", global: false },
	{ path: "preferences/one-line-rows.md", title: "Settings rows read on one line", global: true },
	{ path: "_rules/pinned.md", title: "Pinned rule", global: false, pinned: true },
];

describe("pageToReplace", () => {
	it("replaces only the page the model named, within the proposal's own scope, never a pinned one", () => {
		expect(pageToReplace({ kind: "rule" }, known)).toBeNull();
		expect(pageToReplace({ kind: "decision", supersedes: "decisions/tailscale-only.md" }, known)?.path).toBe(
			"decisions/tailscale-only.md",
		);
		expect(pageToReplace({ kind: "correction", supersedes: "preferences/one-line-rows.md" }, known)?.path).toBe(
			"preferences/one-line-rows.md",
		);
		expect(pageToReplace({ kind: "decision", supersedes: "preferences/one-line-rows.md" }, known)).toBeNull();
		expect(pageToReplace({ kind: "rule", supersedes: "_rules/pinned.md" }, known)).toBeNull();
		expect(pageToReplace({ kind: "rule", supersedes: "_rules/not-shown.md" }, known)).toBeNull();
	});
});
