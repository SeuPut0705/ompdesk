/** The work tree: one family per session with children, live rows listed, finished ones folded, cost summed once. */
import { describe, expect, it } from "vitest";
import type { AgentChildUsage, AgentReviewItem, ClosedChild } from "../../../../shared/agent-control";
import type { IpcHostedSession } from "../../../../shared/ipc-types";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import type { SessionTab } from "../../../stores/tabs";
import { buildWorkTree, type WorkTreeInput } from "./work-tree";

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
		kid: { tabId: "kid", model: "openai/gpt-z", cost: 0.05 },
		done: { tabId: "done", cost: 0.02 },
	};
	const closed: ClosedChild[] = [
		{ path: "/s/old.jsonl", openedBySession: "/s/boss.jsonl", title: "Old", cwd: "/repo", closedAt: 1, cost: 0.07 },
	];
	return {
		tabs,
		subagents: new Map([
			[
				"boss",
				new Map([
					["a", agent("a", 1, "running", 0.1, "task")],
					["b", agent("b", 2, "completed", 0.2)],
				]),
			],
			["kid", new Map([["x", agent("x", 1, "running", 0.01)]])],
		]),
		review: new Map([
			["kid", item("kid", { branch: "omp/agent/a", baseBranch: "main", state: "running", commitsAhead: 1 })],
		]),
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

	it("folds what finished, at any depth, and still counts its cost once", () => {
		const [family] = buildWorkTree(input());
		expect(family?.finished.map(row => row.key)).toEqual(["agent:boss:b", "tab:done", "session:/s/old.jsonl"]);
		expect(family?.finished[2]?.target).toEqual({ kind: "stored", sessionPath: "/s/old.jsonl", cwd: "/repo" });
		// 0.1 + 0.2 (subagents) + 0.05 + 0.01 (kid and its subagent) + 0.02 + 0.07 (done, closed)
		expect(family?.cost).toBeCloseTo(0.45, 10);
	});

	it("lists a paired device's session at work on this computer as a root of its own, and nothing idle", () => {
		const hosted: IpcHostedSession[] = [
			{
				sessionPath: "/s/h1.jsonl",
				title: "From phone",
				cwd: "/repo",
				kind: "agent",
				status: "running",
				device: "Phone",
			},
			{ sessionPath: "/s/h2.jsonl", title: "Idle", cwd: "/repo", kind: "agent", status: "ready", device: "Phone" },
		];
		const families = buildWorkTree(input({ tabs: [tab("solo")], hosted }));
		expect(families.map(family => [family.root.key, family.root.device, family.root.state])).toEqual([
			["hosted:/s/h1.jsonl", "Phone", "running"],
		]);
	});

	it("never loops on an opener cycle", () => {
		const tabs = [tab("p", { openedBy: "q" }), tab("q", { openedBy: "p" }), tab("r", { title: "R" })];
		expect(() => buildWorkTree(input({ tabs, subagents: new Map(), closed: [] }))).not.toThrow();
	});
});
