import { describe, expect, it } from "vitest";
import type { AgentReviewItem, ClosedChild } from "../../../../shared/agent-control";
import type { SessionTab } from "../../../stores/tabs";
import { openedChildCounts, openedChildRows } from "./opened-children";

const tab = (id: string, extra: Partial<SessionTab> = {}): SessionTab => ({
	id,
	cwd: "/w",
	status: "ready",
	kind: "agent",
	unreadDone: false,
	...extra,
});

const review = (tabId: string, extra: Partial<AgentReviewItem> = {}): AgentReviewItem => ({
	tabId,
	title: "",
	state: "needs-review",
	commitsAhead: 0,
	files: 0,
	added: 0,
	removed: 0,
	uncommitted: 0,
	answer: "",
	...extra,
});

const parent = { id: "boss", sessionPath: "/s/boss.jsonl" };
const stop = { stopReason: "stop" };

describe("openedChildRows: the sessions an agent opened as children of its session", () => {
	it("reads each child's status, step, clock and branch; waiting first, finished last", () => {
		const rows = openedChildRows({
			parent,
			tabs: [
				tab("boss", { sessionPath: "/s/boss.jsonl" }),
				tab("done", { openedBy: "boss", task: "Finished", lastRun: stop }),
				tab("run", { openedBy: "boss", status: "running", task: "Running" }),
				tab("ask", { openedBy: "boss", awaitingInput: "input", title: "Asking" }),
				tab("bad", { openedBy: "boss", lastRun: { stopReason: "error" }, task: "Broken" }),
				tab("elsewhere", { openedBy: "someone-else" }),
			],
			review: new Map([
				["run", review("run", { state: "running", step: "running bash (vitest)", runningSince: 1000 })],
			]),
			closed: [],
		});
		expect(rows.map(row => [row.key, row.status])).toEqual([
			["ask", "waiting"],
			["bad", "problem"],
			["run", "running"],
			["done", "done"],
		]);
		const running = rows.find(row => row.key === "run");
		expect(running).toMatchObject({ title: "Running", step: "running bash (vitest)", since: 1000 });
	});

	it("starts a running child's clock from its tab's own status, before main's review list reaches the board", () => {
		const rows = openedChildRows({
			parent,
			tabs: [tab("run", { openedBy: "boss", status: "running", task: "Running", runningSince: 2000 })],
			review: new Map(),
			closed: [],
		});
		expect(rows[0]).toMatchObject({ status: "running", since: 2000 });
	});

	it("names the paired device a child runs on, as a child on this computer otherwise", () => {
		const rows = openedChildRows({
			parent,
			tabs: [
				tab("boss", { sessionPath: "/s/boss.jsonl" }),
				tab("win", { openedBy: "boss", status: "running", task: "On Windows", device: "dev-win" }),
				tab("here", { openedBy: "boss", status: "running", task: "Here" }),
			],
			review: new Map(),
			closed: [],
			deviceName: id => (id === "dev-win" ? "DESKTOP-PC" : id),
		});
		expect(rows.find(row => row.key === "win")).toMatchObject({ status: "running", device: "DESKTOP-PC" });
		expect(rows.find(row => row.key === "here")?.device).toBeUndefined();
	});

	it("lists children this window holds no tab of from main's review list: a phone viewing a desktop's session", () => {
		const rows = openedChildRows({
			parent,
			// The phone's own tab list: only the opener it views.
			tabs: [tab("boss", { sessionPath: "/s/boss.jsonl" })],
			review: new Map([
				[
					"kid1",
					review("kid1", { title: "Fix the upload", state: "running", step: "running bash", runningSince: 5 }),
				],
				["kid2", review("kid2", { title: "Asks", state: "running", waiting: true })],
				["kid3", review("kid3", { title: "Done" })],
			]),
			closed: [],
		});
		expect(rows.map(row => [row.key, row.status])).toEqual([
			["kid2", "waiting"],
			["kid1", "running"],
			["kid3", "done"],
		]);
		expect(rows.find(row => row.key === "kid1")).toMatchObject({
			title: "Fix the upload",
			step: "running bash",
			since: 5,
		});
		expect(openedChildCounts(rows)).toMatchObject({ total: 3, running: 1, waiting: 1 });
	});

	it("puts a child whose question waits on the opener first, with its last report", () => {
		const rows = openedChildRows({
			parent,
			tabs: [
				tab("boss"),
				tab("busy", { openedBy: "boss", status: "running", task: "Busy" }),
				tab("asks", { openedBy: "boss", lastRun: stop, task: "Asks" }),
			],
			review: new Map([
				["asks", review("asks", { waiting: true, report: { kind: "question", text: "Keep it?", at: 5 } })],
			]),
			closed: [],
		});
		expect(rows[0]).toMatchObject({ key: "asks", status: "waiting", report: { kind: "question", text: "Keep it?" } });
	});

	it("reads a branch's merge state: unmerged commits are a problem, a settled review is merged", () => {
		const worktree = { name: "w", branch: "omp/agent/w", baseCwd: "/w", path: "/wt/w" };
		const rows = openedChildRows({
			parent,
			tabs: [
				tab("a", { openedBy: "boss", lastRun: stop, worktree }),
				tab("b", { openedBy: "boss", lastRun: stop, worktree }),
			],
			review: new Map([["a", review("a", { branch: "omp/agent/w", baseBranch: "main", commitsAhead: 2 })]]),
			closed: [],
		});
		expect(rows.find(row => row.key === "a")).toMatchObject({
			status: "problem",
			merge: "unmerged",
			branch: "omp/agent/w",
			base: "main",
		});
		// No review item left: it was approved or accepted.
		expect(rows.find(row => row.key === "b")).toMatchObject({ status: "done", merge: "merged" });
	});

	it("finds a child by the opener's session file after a relaunch, and adds the stored ones main closed", () => {
		const closed: ClosedChild[] = [
			{ path: "/s/landed.jsonl", openedBySession: "/s/boss.jsonl", title: "Landed", cwd: "/w", closedAt: 1 },
			{ path: "/s/other.jsonl", openedBySession: "/s/someone.jsonl", title: "Not mine", cwd: "/w", closedAt: 2 },
			{ path: "/s/reopened.jsonl", openedBySession: "/s/boss.jsonl", title: "Reopened", cwd: "/w", closedAt: 3 },
		];
		const rows = openedChildRows({
			parent,
			tabs: [
				tab("new-id", { openedBy: "old-id", openedBySession: "/s/boss.jsonl", task: "Restored" }),
				tab("again", { sessionPath: "/s/reopened.jsonl", lastRun: stop }),
			],
			review: new Map(),
			closed,
		});
		expect(rows.map(row => [row.key, row.tabId])).toEqual([
			["new-id", "new-id"],
			["/s/landed.jsonl", null],
			["/s/reopened.jsonl", null],
		]);
		expect(rows.at(-1)).toMatchObject({ title: "Reopened", cwd: "/w", status: "done" });
	});
});

describe("openedChildCounts", () => {
	it("counts the live children by status and the stored ones apart", () => {
		const rows = openedChildRows({
			parent,
			tabs: [
				tab("a", { openedBy: "boss", status: "running" }),
				tab("b", { openedBy: "boss", status: "running" }),
				tab("c", { openedBy: "boss", awaitingInput: "approval" }),
				tab("d", { openedBy: "boss", lastRun: stop }),
			],
			review: new Map(),
			closed: [{ path: "/s/x.jsonl", openedBySession: "/s/boss.jsonl", title: "", cwd: "", closedAt: 0 }],
		});
		expect(openedChildCounts(rows)).toEqual({ total: 4, running: 2, waiting: 1, done: 1, closed: 1 });
	});
});
