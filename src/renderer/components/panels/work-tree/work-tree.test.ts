/** The work tree: one family per session with children, live rows listed, finished ones folded, cost summed once. */
import { describe, expect, it } from "vitest";
import type { AgentChildUsage, AgentReviewItem, ClosedChild } from "../../../../shared/agent-control";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import type { SessionSummary, SummaryAgent } from "../../../../shared/session-summary";
import type { SessionTab } from "../../../stores/tabs";
import { buildWorkTree, familySpend, type WorkTreeInput } from "./work-tree";

/** A summary as the computer running the session builds it (`session-summaries.ts`). */
const summary = (sessionPath: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	sessionPath,
	tabId: sessionPath,
	cwd: "/repo",
	kind: "agent",
	status: "ready",
	agents: [],
	...extra,
});

const atWork = (id: string, index: number, cost: number, role?: string): SummaryAgent => ({
	id,
	index,
	agent: "task",
	status: "running",
	title: `Agent ${id}`,
	startedAt: 0,
	cost,
	...(role ? { role, model: "anthropic/claude-x" } : {}),
});

/** `summaryOf` over summaries by session file. */
const summariesBy =
	(...summaries: SessionSummary[]) =>
	(tab: SessionTab) =>
		summaries.find(entry => entry.sessionPath === tab.sessionPath);

const tab = (id: string, extra: Partial<SessionTab> = {}): SessionTab =>
	({ id, cwd: "/repo", status: "ready", kind: "agent", sessionPath: `/s/${id}.jsonl`, ...extra }) as SessionTab;

const agent = (id: string, index: number, status: string, cost: number, role?: string): SubagentSnapshot =>
	({
		id,
		index,
		agent: "task",
		status,
		lastUpdate: 0,
		description: `Agent ${id}`,
		progress: { cost, ...(role ? { modelRole: role, resolvedModel: "anthropic/claude-x" } : {}) },
	}) as SubagentSnapshot;

const item = (tabId: string, extra: Partial<AgentReviewItem> = {}): AgentReviewItem => ({
	tabId,
	title: tabId,
	state: "running",
	commitsAhead: 0,
	files: 0,
	added: 0,
	removed: 0,
	uncommitted: 0,
	answer: "",
	...extra,
});

function input(overrides: Partial<WorkTreeInput> = {}): WorkTreeInput {
	const tabs = [
		tab("boss", { title: "Boss" }),
		tab("kid", {
			title: "Fix parser",
			status: "running",
			openedBy: "boss",
			worktree: { name: "a", path: "/wt/a", branch: "omp/agent/a", baseCwd: "/repo" },
		}),
		tab("done", { title: "Docs", openedBy: "boss", lastRun: { stopReason: "stop" } }),
		tab("far", { title: "On the PC", status: "running", openedBy: "boss", device: "pc1" }),
		tab("solo", { title: "Alone" }),
	];
	const usage: Record<string, AgentChildUsage> = {
		// The session itself: its journal, its finished subagents' spend included.
		"/s/boss.jsonl": { cost: 1 },
		"/s/kid.jsonl": { model: "openai/gpt-z", cost: 0.05 },
		"/s/done.jsonl": { cost: 0.02 },
	};
	const closed: ClosedChild[] = [
		{ path: "/s/old.jsonl", openedBySession: "/s/boss.jsonl", title: "Old", cwd: "/repo", closedAt: 1, cost: 0.07 },
	];
	return {
		tabs,
		// This window's record: only the finished subagent is read from it.
		subagents: new Map([["boss", new Map([["b", agent("b", 2, "completed", 0.2)]])]]),
		summaryOf: summariesBy(
			summary("/s/boss.jsonl", { agents: [atWork("a", 1, 0.1, "task")] }),
			summary("/s/kid.jsonl", { status: "running", agents: [atWork("x", 1, 0.01)] }),
		),
		review: {
			boss: [item("kid", { branch: "omp/agent/a", baseBranch: "main", state: "running", commitsAhead: 1 })],
		},
		usage,
		closed,
		hosted: [],
		deviceName: id => (id === "pc1" ? "Desktop PC" : id),
		...overrides,
	};
}

describe("buildWorkTree", () => {
	it("lists a family per session with children: subagents, opened sessions, their subagents, then the branch", () => {
		const [family, ...rest] = buildWorkTree(input());
		expect(rest).toEqual([]);
		expect(family?.root).toMatchObject({ key: "tab:boss", title: "Boss", depth: 0 });
		expect(family?.rows.map(row => [row.key, row.kind, row.depth])).toEqual([
			["agent:boss:a", "subagent", 1],
			["tab:kid", "worktree", 1],
			["agent:kid:x", "subagent", 2],
			["branch:kid", "branch", 2],
			["tab:far", "session", 1],
		]);
		expect(family?.rows.find(row => row.key === "tab:far")?.device).toBe("Desktop PC");
		expect(family?.rows[0]?.usage).toEqual({ model: "anthropic/claude-x", role: "task", cost: 0.1 });
		expect(family?.rows[1]?.usage).toEqual({ model: "openai/gpt-z", cost: 0.05 });
		// Still running: its branch has no merge verdict yet.
		expect(family?.rows[3]).toMatchObject({ title: "omp/agent/a", base: "main" });
		expect(family?.rows[3]?.merge).toBeUndefined();
		expect([family?.running, family?.waiting]).toEqual([4, 0]);
	});

	it("folds what finished, at any depth; the head is the whole family's cost, each kind apart, never one sum", () => {
		const fixture = input({
			billing: { anthropic: "subscription", openai: "subscription", openrouter: "metered" },
			usage: {
				// The session's own journal as its host split it: replies on the subscription, the judge's calls metered.
				"/s/boss.jsonl": { cost: 1, split: { charged: 0.0014, estimate: 0.9986 } },
				// Runs on a subscription model now, but its journal also holds judge calls: its host's split wins.
				"/s/kid.jsonl": { model: "openai/gpt-z", cost: 0.05, split: { charged: 0.01, estimate: 0.04 } },
				// An older host: no split, no model; the figure stays unclassed.
				"/s/done.jsonl": { cost: 0.02 },
			},
			closed: [
				{
					path: "/s/old.jsonl",
					openedBySession: "/s/boss.jsonl",
					title: "Old",
					cwd: "/repo",
					closedAt: 1,
					model: "openrouter/qwen/qwen-4",
					cost: 0.07,
				},
			],
		});
		const [family] = buildWorkTree(fixture);
		expect(family?.finished.map(row => row.key)).toEqual(["agent:boss:b", "tab:done", "session:/s/old.jsonl"]);
		expect(family?.finished[2]?.target).toEqual({ kind: "stored", sessionPath: "/s/old.jsonl", cwd: "/repo" });
		// Charged: the boss's judge 0.0014 + the kid's 0.01 + the closed OpenRouter child 0.07. Estimate: the boss's
		// 0.9986 + its subagent at work on Anthropic 0.1 + the kid's 0.04. The finished subagent is inside the boss's
		// journal; far has no stats yet.
		expect(family?.cost.charged).toBeCloseTo(0.0814, 10);
		expect(family?.cost.estimate).toBeCloseTo(1.1386, 10);
		expect(family?.cost.unknown).toBeCloseTo(0.02, 10);
	});

	it("counts nothing for a cost stock has not reported, rather than poisoning the sum", () => {
		const unpriced = { ...atWork("x", 1, Number.NaN) };
		expect(familySpend({ cost: Number.NaN }, [unpriced], [{ usage: {} }, {}], {})).toEqual({
			charged: 0,
			estimate: 0,
			unknown: 0,
		});
	});

	it("lists the subagents a tab's summary says are at work, though this window heard none of their frames", () => {
		// A tab no pane shows: its omp's frames went to main, which built its summary; this window recorded nothing.
		const [family] = buildWorkTree(
			input({
				tabs: [tab("boss", { title: "Boss" })],
				subagents: new Map(),
				summaryOf: summariesBy(summary("/s/boss.jsonl", { status: "running", agents: [atWork("a", 1, 0.1)] })),
				review: {},
				closed: [],
			}),
		);
		expect(family?.root).toMatchObject({ key: "tab:boss", state: "running" });
		expect(family?.rows.map(row => [row.key, row.state])).toEqual([["agent:boss:a", "running"]]);
		expect(family?.running).toBe(1);
	});

	it("lists a paired device's session at work on this computer as a root of its own, and nothing idle", () => {
		const hosted: SessionSummary[] = [
			{
				sessionPath: "/s/h1.jsonl",
				tabId: "h1",
				title: "From phone",
				cwd: "/repo",
				kind: "agent",
				status: "running",
				openFor: "Phone",
				agents: [],
			},
			{
				sessionPath: "/s/h2.jsonl",
				tabId: "h2",
				title: "Idle",
				cwd: "/repo",
				kind: "agent",
				status: "ready",
				openFor: "Phone",
				agents: [],
			},
		];
		const families = buildWorkTree(input({ tabs: [tab("solo")], hosted }));
		expect(families.map(family => [family.root.key, family.root.device, family.root.state])).toEqual([
			["hosted:/s/h1.jsonl", "Phone", "running"],
		]);
	});

	it("reads the root's run by its sidebar row's rule: a held session and a failed turn are no failed session", () => {
		const root = (fields: Partial<SessionSummary>, extra: Partial<SessionTab> = {}) =>
			buildWorkTree(
				input({
					tabs: [...input().tabs.filter(t => t.id !== "boss"), tab("boss", extra)],
					summaryOf: summariesBy(summary("/s/boss.jsonl", { agents: [atWork("a", 1, 0.1)], ...fields })),
				}),
			)[0]?.root;
		expect(root({ status: "error", sessionHeld: true })).toMatchObject({ key: "tab:boss", state: null });
		expect(root({ status: "error" })).toMatchObject({ key: "tab:boss", state: "failed" });
		expect(root({}, { lastRun: { stopReason: "error" } })).toMatchObject({ key: "tab:boss", state: null });
		// A question on a session that is not up cannot be answered there: the row says restarting, not waiting.
		expect(root({ status: "restarting", ask: "input" })).toMatchObject({ key: "tab:boss", state: null });
		expect(root({ ask: "approval" })).toMatchObject({ key: "tab:boss", state: "waiting" });

		const hosted: SessionSummary[] = [
			{
				sessionPath: "/s/h1.jsonl",
				tabId: "h1",
				cwd: "/repo",
				kind: "agent",
				status: "error",
				sessionHeld: true,
				openFor: "Phone",
				agents: [],
			},
			{
				sessionPath: "/s/h2.jsonl",
				tabId: "h2",
				cwd: "/repo",
				kind: "agent",
				status: "error",
				openFor: "Phone",
				agents: [],
			},
		];
		expect(buildWorkTree(input({ tabs: [tab("solo")], hosted })).map(family => family.root.key)).toEqual([
			"hosted:/s/h2.jsonl",
		]);
	});

	it("never loops on an opener cycle", () => {
		const tabs = [tab("p", { openedBy: "q" }), tab("q", { openedBy: "p" }), tab("r", { title: "R" })];
		expect(() => buildWorkTree(input({ tabs, subagents: new Map(), closed: [] }))).not.toThrow();
	});
});
