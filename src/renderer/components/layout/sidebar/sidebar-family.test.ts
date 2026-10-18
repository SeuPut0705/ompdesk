/** The family rules: which session an opened session nests under, how a roster splits into rows and "n done". */
import { describe, expect, it } from "vitest";
import {
	assignmentHeadline,
	stripTitlePrefix,
} from "../../../../../resources/gui-bridge/modes/subagent-title-contracts";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import {
	buildSubagentFamilyRows,
	type FamilySession,
	type FamilyTab,
	familyCounts,
	isFoldedSubagent,
	openerOfSessions,
	subagentFamilyState,
} from "./sidebar-family";

const session = (path: string, extra: Partial<FamilySession> = {}): FamilySession => ({
	path,
	id: `id:${path}`,
	...extra,
});

function agent(id: string, index: number, status: string, extra: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return { id, index, agent: "task", status, lastUpdate: 0, ...extra } as SubagentSnapshot;
}

describe("openerOfSessions: an opened session nests under its opener", () => {
	const sessions = [session("/s/boss"), session("/s/a"), session("/s/b"), session("/s/c"), session("/s/solo")];

	it("follows the live tab ids, whatever folder or worktree each session is in", () => {
		const tabs: FamilyTab[] = [
			{ id: "t1", sessionPath: "/s/boss" },
			{ id: "t2", sessionPath: "/s/a", openedBy: "t1" },
			{ id: "t3", sessionPath: "/s/b", openedBy: "t1" },
			{ id: "t4", sessionPath: "/s/solo" },
		];
		expect([...openerOfSessions(tabs, sessions)]).toEqual([
			["/s/a", "/s/boss"],
			["/s/b", "/s/boss"],
		]);
	});

	it("finds the opener by its session file after a relaunch gave every tab a new id", () => {
		const tabs: FamilyTab[] = [
			{ id: "n9", sessionPath: "/s/boss" },
			{ id: "n8", sessionPath: "/s/a", openedBy: "t-gone", openedBySession: "/s/boss" },
		];
		expect(openerOfSessions(tabs, sessions).get("/s/a")).toBe("/s/boss");
	});

	it("keeps the family one level deep: an opened session's own children go under the first opener", () => {
		const tabs: FamilyTab[] = [
			{ id: "t1", sessionPath: "/s/boss" },
			{ id: "t2", sessionPath: "/s/a", openedBy: "t1" },
			{ id: "t3", sessionPath: "/s/b", openedBy: "t2" },
			{ id: "t4", sessionPath: "/s/c", openedBy: "t3" },
		];
		const roots = openerOfSessions(tabs, sessions);
		expect([roots.get("/s/a"), roots.get("/s/b"), roots.get("/s/c")]).toEqual(["/s/boss", "/s/boss", "/s/boss"]);
		expect(roots.has("/s/boss")).toBe(false);
	});

	it("leaves a session without a listed opener where it is, and nests nothing on a cycle", () => {
		const closed: FamilyTab[] = [
			{ id: "t2", sessionPath: "/s/a", openedBy: "t-closed", openedBySession: "/s/closed" },
		];
		expect(openerOfSessions(closed, sessions).size).toBe(0);
		const cycle: FamilyTab[] = [
			{ id: "t1", sessionPath: "/s/a", openedBy: "t2" },
			{ id: "t2", sessionPath: "/s/b", openedBy: "t1" },
			{ id: "t3", sessionPath: "/s/c", openedBy: "t3" },
		];
		expect(openerOfSessions(cycle, sessions).size).toBe(0);
	});

	it("matches a session to its tab by the live tab, the file or the id, like the sidebar rows do", () => {
		const tabs: FamilyTab[] = [
			{ id: "t1", sessionId: "id:/s/boss" },
			{ id: "t2", openedBy: "t1" },
		];
		const rows = [session("/s/boss"), session("tab:t2", { liveTabId: "t2" })];
		expect(openerOfSessions(tabs, rows).get("tab:t2")).toBe("/s/boss");
	});
});

describe("buildSubagentFamilyRows", () => {
	it("folds finished agents, keeps failed and stale ones as rows, and nests by spawn parent", () => {
		const roster = new Map(
			[
				agent("a", 1, "running"),
				agent("b", 2, "completed"),
				agent("c", 3, "failed"),
				agent("d", 4, "running", { parentSubagentId: "a" }),
				agent("e", 5, "aborted"),
				agent("f", 6, "stale"),
				agent("g", 7, "running", { parentSubagentId: "b" }),
			].map(entry => [entry.id, entry]),
		);
		const { rows, done } = buildSubagentFamilyRows(roster, new Map());
		expect(rows.map(row => [row.agent.id, row.depth])).toEqual([
			["a", 0],
			["d", 1],
			["c", 0],
			["f", 0],
			// Its parent is folded away: a top-level spawn.
			["g", 0],
		]);
		expect(done.map(entry => entry.id)).toEqual(["b", "e"]);
	});

	it("reads each status as one token, and folds only what finished quietly", () => {
		expect(
			[
				"running",
				"started",
				"pending",
				"parked",
				"idle",
				"stale",
				"failed",
				"completed",
				"aborted",
				"cancelled",
			].map(subagentFamilyState),
		).toEqual(["running", "running", "running", "idle", "idle", "waiting", "failed", "done", "done", "done"]);
		expect(["completed", "aborted", "cancelled"].every(isFoldedSubagent)).toBe(true);
		expect(["failed", "stale", "running", "parked"].some(isFoldedSubagent)).toBe(false);
	});
});

describe("familyCounts", () => {
	it("counts subagents, opened sessions, the running ones and what keeps the group open", () => {
		const roster = [
			agent("a", 1, "running"),
			agent("b", 2, "parked"),
			agent("c", 3, "completed"),
			agent("d", 4, "stale"),
		];
		expect(familyCounts(roster, [{ state: "running" }, { state: "waiting" }, { state: "done" }])).toEqual({
			agents: 4,
			sessions: 3,
			running: 2,
			active: 4,
		});
		// Hidden subagents count for nothing; the opened sessions stay.
		expect(familyCounts(roster, [{ state: "idle" }], false)).toEqual({
			agents: 0,
			sessions: 1,
			running: 0,
			active: 0,
		});
	});
});

describe("the Title: prefix of a task", () => {
	it("strips the label, takes the title line, else the first line of the task", () => {
		expect(stripTitlePrefix("Title: 휴대폰 테스트")).toBe("휴대폰 테스트");
		expect(stripTitlePrefix("title:x")).toBe("x");
		expect(stripTitlePrefix("A Title: inside")).toBe("A Title: inside");
		expect(assignmentHeadline("Title: Short one\nbody")).toBe("Short one");
		expect(assignmentHeadline("\n\nPlain first line\nsecond")).toBe("Plain first line");
		const long = `Title: ${"a".repeat(130)}`;
		expect(assignmentHeadline(long)).toBe("a".repeat(130));
		expect(assignmentHeadline("  \n ")).toBeUndefined();
		expect(assignmentHeadline(undefined)).toBeUndefined();
	});
});
