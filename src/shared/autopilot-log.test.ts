import { describe, expect, it } from "vitest";
import type { AutopilotCycleRecord } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { autopilotLogTitle, formatAutopilotLog } from "./autopilot-log";

function cycle(partial: Partial<AutopilotCycleRecord> & Pick<AutopilotCycleRecord, "n">): AutopilotCycleRecord {
	return {
		area: "tests",
		title: `Cycle ${partial.n}`,
		summary: "",
		verify: "green",
		followups: [],
		children: [],
		startedAt: 0,
		durationMs: 60_000,
		tokens: 1000,
		usd: 0.1,
		compactions: 0,
		...partial,
	};
}

describe("formatAutopilotLog", () => {
	it("titles the log with the branch and the cycle count", () => {
		expect(autopilotLogTitle("autopilot/2026-10-17", 7)).toBe("autopilot/2026-10-17: 7 cycles");
		expect(autopilotLogTitle("autopilot/2026-10-17", 1)).toBe("autopilot/2026-10-17: 1 cycle");
	});

	it("groups cycles by area in the fixed area order, newest first inside an area", () => {
		const log = formatAutopilotLog({
			branch: "autopilot/2026-10-17",
			cycles: [
				cycle({ n: 1, area: "tests", title: "Add resume e2e", commit: "9f3c0e1aaaa" }),
				cycle({ n: 2, area: "design", title: "Tighten spacing", commit: "3a9f1c2bbbb" }),
				cycle({ n: 3, area: "tests", title: "Fix flaky test", verify: "red" }),
			],
		});
		const design = log.indexOf("## Design");
		const tests = log.indexOf("## Tests");
		expect(design).toBeGreaterThan(-1);
		expect(tests).toBeGreaterThan(design);
		expect(log.indexOf("**#3** Fix flaky test")).toBeLessThan(log.indexOf("**#1** Add resume e2e"));
		expect(log).toContain("`9f3c0e1`");
		expect(log).toContain("red");
	});

	it("counts commits and red cycles in the summary line", () => {
		const log = formatAutopilotLog({
			branch: "autopilot/x",
			cycles: [
				cycle({ n: 1, commit: "abcdef1234" }),
				cycle({ n: 2, verify: "red" }),
				cycle({ n: 3, commit: "1234567" }),
			],
		});
		expect(log).toContain("3 cycles · 2 commits · 1 red");
	});

	it("lists summaries, follow-ups, children and a revert mark", () => {
		const log = formatAutopilotLog({
			branch: "autopilot/x",
			cycles: [
				cycle({
					n: 4,
					area: "bugs",
					summary: "Closed the tab race.",
					followups: ["Cover the same race on Windows"],
					reverted: true,
					children: [{ session: "s1", branch: "autopilot/x-c4-bugs", outcome: "merged", sha: "deadbeef00" }],
				}),
			],
		});
		expect(log).toContain("Closed the tab race.");
		expect(log).toContain("Follow-up: Cover the same race on Windows");
		expect(log).toContain("autopilot/x-c4-bugs");
		expect(log).toContain("merged");
		expect(log).toContain("reverted");
	});

	it("keeps unreported and user/release cycles after the named areas", () => {
		const log = formatAutopilotLog({
			branch: "b",
			cycles: [
				cycle({ n: 1, area: "unreported", verify: "unreported", title: "" }),
				cycle({ n: 2, area: "release", title: "Release v1" }),
				cycle({ n: 3, area: "docs", title: "Update README" }),
			],
		});
		expect(log.indexOf("## Docs")).toBeLessThan(log.indexOf("## Release"));
		expect(log.indexOf("## Release")).toBeLessThan(log.indexOf("## Unreported"));
	});

	it("collects the follow-ups of every cycle once under one heading", () => {
		const log = formatAutopilotLog({
			branch: "b",
			cycles: [cycle({ n: 1, followups: ["A", "B"] }), cycle({ n: 2, followups: ["B", "C"] })],
		});
		const open = log.slice(log.indexOf("## Open follow-ups"));
		expect(open.match(/- B/g)?.length).toBe(1);
		expect(open).toContain("- A");
		expect(open).toContain("- C");
	});
});
