/** The family rules: which session an opened session nests under, how a roster becomes rows (finished ones are not listed). */
import { describe, expect, it } from "vitest";
import {
	assignmentHeadline,
	stripTitlePrefix,
} from "../../../../../resources/gui-bridge/modes/subagent-title-contracts";
import { wrapAgentMessage } from "../../../../shared/agent-control";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { type FamilySession, type FamilyTab, openerOfSessions } from "../../../../shared/sidebar-rows";
import {
	buildSubagentFamilyRows,
	CHILD_TOKEN,
	type ChildFacts,
	childUsageText,
	familyCounts,
	isFoldedSubagent,
	isShownOpened,
	openedChildStatus,
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
	it("leaves finished agents out, keeps failed and stale ones as rows, and nests by spawn parent", () => {
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
		const { rows } = buildSubagentFamilyRows(roster, new Map());
		expect(rows.map(row => [row.agent.id, row.depth])).toEqual([
			["a", 0],
			["d", 1],
			["c", 0],
			["f", 0],
			// Its parent is finished and not listed: a top-level spawn.
			["g", 0],
		]);
		// Finished agents (b, e) are not rows.
		expect(rows.some(row => ["b", "e"].includes(row.agent.id))).toBe(false);
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
	it("counts the subagents and opened sessions that show, the running ones and the ones waiting for the person", () => {
		const roster = [
			agent("a", 1, "running"),
			agent("b", 2, "parked"),
			agent("c", 3, "completed"),
			agent("d", 4, "stale"),
			agent("e", 5, "aborted"),
		];
		// Finished subagents are not listed, so they are not counted either.
		expect(familyCounts(roster, [{ state: "running" }, { state: "waiting" }])).toEqual({
			agents: 3,
			sessions: 2,
			running: 2,
			waiting: 2,
		});
		// Hidden subagents count for nothing; the opened sessions stay.
		expect(familyCounts(roster, [{ state: "idle" }], false)).toEqual({
			agents: 0,
			sessions: 1,
			running: 0,
			waiting: 0,
		});
		// A roster of finished agents only is no family.
		expect(familyCounts([agent("x", 1, "completed")], [])).toEqual({
			agents: 0,
			sessions: 0,
			running: 0,
			waiting: 0,
		});
	});
});

describe("childUsageText", () => {
	it("reads model and role as one tooltip line, leaving out what is unknown", () => {
		expect(childUsageText("anthropic/claude-sonnet-5", "task")).toBe("anthropic/claude-sonnet-5 · @task");
		expect(childUsageText("openai/gpt-z")).toBe("openai/gpt-z");
		expect(childUsageText()).toBe("");
	});
});

describe("isShownOpened", () => {
	it("hides only a finished session that landed clean", () => {
		expect(isShownOpened({ status: "done" })).toBe(false);
		expect(isShownOpened({ status: "running" })).toBe(true);
		expect(isShownOpened({ status: "waiting" })).toBe(true);
		expect(isShownOpened({ status: "failed" })).toBe(true);
		expect(isShownOpened({ status: "unmerged" })).toBe(true);
		expect(isShownOpened({ status: null })).toBe(true);
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

describe("openedChildStatus: one status per opened session", () => {
	const idle: ChildFacts = { waiting: false, running: false, finished: false, failed: false, unmerged: false };
	const status = (patch: Partial<ChildFacts>) => openedChildStatus({ ...idle, ...patch });

	it("reads running, waiting, done, failed and unmerged, and nothing for a session that has not run", () => {
		expect(status({})).toBeNull();
		expect(status({ running: true })).toBe("running");
		expect(status({ waiting: true, running: true })).toBe("waiting");
		expect(status({ finished: true })).toBe("done");
		expect(status({ finished: true, failed: true })).toBe("failed");
		expect(status({ finished: true, unmerged: true })).toBe("unmerged");
	});

	it("tells a clean finish with unmerged work from a failed ending, and never folds either as done", () => {
		// 29 Oct 2026: a session that finished well with commits nobody merged yet read as a failure (red ✕).
		expect(status({ finished: true, unmerged: true, failed: false })).toBe("unmerged");
		expect(status({ finished: true, failed: true, unmerged: true })).toBe("failed");
		// Unmerged work of a session still at work is not a verdict yet.
		expect(status({ running: true, unmerged: true })).toBe("running");
		expect(status({ unmerged: true })).toBeNull();
	});

	it("shows each status as its own token: failed is the ✕, unmerged is the ready-to-merge mark", () => {
		expect(CHILD_TOKEN).toEqual({
			running: "running",
			waiting: "waiting",
			done: "done",
			failed: "failed",
			unmerged: "unmerged",
		});
	});
});

describe("openerOfSessions: opened sessions main closed", () => {
	const sessions = [session("/s/boss"), session("/s/a"), session("/s/b"), session("/s/other")];

	it("nests a session with no tab under the opener its closed record names, whatever its folder", () => {
		const tabs: FamilyTab[] = [{ id: "t1", sessionPath: "/s/boss" }];
		const closed = new Map([["/s/a", "/s/boss"]]);
		expect([...openerOfSessions(tabs, sessions, closed)]).toEqual([["/s/a", "/s/boss"]]);
	});

	it("keeps it there when the person reopens it in a tab of their own, and ignores a record whose opener is gone", () => {
		const tabs: FamilyTab[] = [
			{ id: "t1", sessionPath: "/s/boss" },
			{ id: "t2", sessionPath: "/s/a" },
		];
		const closed = new Map([
			["/s/a", "/s/boss"],
			["/s/b", "/s/vanished"],
		]);
		const roots = openerOfSessions(tabs, sessions, closed);
		expect(roots.get("/s/a")).toBe("/s/boss");
		expect(roots.has("/s/b")).toBe(false);
	});

	it("lets a live tab's own opener win over a record", () => {
		const tabs: FamilyTab[] = [
			{ id: "t1", sessionPath: "/s/boss" },
			{ id: "t2", sessionPath: "/s/other" },
			{ id: "t3", sessionPath: "/s/a", openedBy: "t2" },
		];
		expect(openerOfSessions(tabs, sessions, new Map([["/s/a", "/s/boss"]])).get("/s/a")).toBe("/s/other");
	});
});

describe("openerOfSessions: legacy and stored provenance", () => {
	const brief = (from: string) => wrapAgentMessage("Title: job\nDetails.", from);
	const sessions = [
		session("/s/boss", { title: "Boss", created: "2026-01-01T00:00:00Z" }),
		session("/s/old-boss", { title: "Boss", created: "2025-12-01T00:00:00Z" }),
		session("/s/legacy", { firstMessage: brief("Boss"), created: "2026-01-02T00:00:00Z" }),
		session("/s/stranger", { firstMessage: brief("Nobody"), created: "2026-01-02T00:00:00Z" }),
		session("/s/untitled", { firstMessage: brief(""), created: "2026-01-02T00:00:00Z" }),
		session("/s/person", { firstMessage: "Boss", created: "2026-01-02T00:00:00Z" }),
		session("/s/early", { firstMessage: brief("Boss"), created: "2025-11-01T00:00:00Z" }),
	];

	it("nests a session by the sender its first message's agent brief names: the newest session of that title before it", () => {
		const roots = openerOfSessions([], sessions);
		expect(roots.get("/s/legacy")).toBe("/s/boss");
	});

	it("leaves a brief whose sender is unknown, blank or newer, and a person's own prompt, unnested", () => {
		const roots = openerOfSessions([], sessions);
		for (const path of ["/s/stranger", "/s/untitled", "/s/person", "/s/early"]) expect(roots.has(path)).toBe(false);
	});

	it("finds a stored opener (no tab) from the opener's session file a restored tab names", () => {
		const tabs: FamilyTab[] = [{ id: "n1", sessionPath: "/s/kid", openedBy: "t-gone", openedBySession: "/s/boss" }];
		const rows = [session("/s/boss"), session("/s/kid")];
		expect(openerOfSessions(tabs, rows).get("/s/kid")).toBe("/s/boss");
	});

	it("lets a record win over the brief", () => {
		const roots = openerOfSessions([], sessions, new Map([["/s/legacy", "/s/old-boss"]]));
		expect(roots.get("/s/legacy")).toBe("/s/old-boss");
	});
});
