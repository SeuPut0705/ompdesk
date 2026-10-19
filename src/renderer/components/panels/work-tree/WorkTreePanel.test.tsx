/**
 * Side panel › Work tree: one family per session with children (live rows listed, finished ones in a closed fold,
 * model, role and cost on every child row), following each tab's subagent roster as it changes; the unused worktrees
 * of the repository with removal only for the ones whose work landed, after a confirm. linkedom + react-dom harness
 * (ThinkingBlock.test.tsx); `window.omp.rpc.command` answers the two worktree commands.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { RpcCommand, RpcOrphanWorktrees, RpcResponse, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { resetLastReadForTest } from "../../../lib/last-read";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { useClosedChildrenStore } from "../../../stores/closed-children";
import {
	deleteSessionRuntime,
	registerSessionRuntime,
	setFocusedSessionRuntime,
} from "../../../stores/session-runtime-context";
import { type SessionTab, useTabsStore } from "../../../stores/tabs";
import { WorkTreePanel } from "./WorkTreePanel";

const { document, window, Event, HTMLElement, Element, Node, MouseEvent } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, MouseEvent });
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove: () => void;
	click: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

let container: TestElement;
let root: Root;
const sent: RpcCommand[] = [];
let orphans: RpcOrphanWorktrees;

const agent = (id: string, index: number, status: string, cost: number): SubagentSnapshot =>
	({
		id,
		index,
		agent: "task",
		status,
		lastUpdate: 0,
		description: `Agent ${id}`,
		progress: { cost, modelRole: "task", resolvedModel: "anthropic/claude-x" },
	}) as SubagentSnapshot;

const roster = createStore(() => ({
	subagents: new Map([
		["a", agent("a", 1, "running", 0.1)],
		["b", agent("b", 2, "completed", 0.2)],
	]),
}));

const tabs = [
	{ id: "boss", cwd: "/repo", status: "ready", kind: "agent", title: "Boss", sessionPath: "/s/boss.jsonl" },
	{
		id: "kid",
		cwd: "/wt/a",
		status: "running",
		kind: "agent",
		title: "Fix parser",
		openedBy: "boss",
		sessionPath: "/s/kid.jsonl",
	},
	{
		id: "far",
		cwd: "C:\\repo",
		status: "running",
		kind: "agent",
		title: "On the PC",
		openedBy: "boss",
		device: "pc1",
		sessionPath: "C:\\s\\far.jsonl",
	},
] as SessionTab[];

async function settle() {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount() {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<WorkTreePanel />
			</I18nProvider>,
		);
	});
	await settle();
}

beforeEach(() => {
	sent.length = 0;
	orphans = {
		root: "/wt",
		worktrees: [
			{
				path: "/wt/gui-a",
				branch: "omp/agent/a",
				repo: "/repo",
				state: "landed",
				squashed: true,
				commitsAhead: 0,
				dirtyFiles: 0,
				modifiedAt: 1,
			},
			{
				path: "/wt/gui-b",
				branch: "omp/agent/b",
				repo: "/repo",
				state: "unlanded",
				commitsAhead: 2,
				dirtyFiles: 0,
				modifiedAt: 1,
			},
			{
				path: "/wt/gui-c",
				branch: "omp/agent/c",
				repo: "/repo",
				state: "dirty",
				commitsAhead: 0,
				dirtyFiles: 3,
				modifiedAt: 1,
			},
		],
	};
	const command = vi.fn(async (cmd: RpcCommand): Promise<RpcResponse> => {
		sent.push(cmd);
		if (cmd.type === "remove_orphan_worktree") {
			orphans = { ...orphans, worktrees: orphans.worktrees.filter(row => row.path !== cmd.path) };
			return { type: "response", command: cmd.type, success: true, data: { removal: "branch-kept" } };
		}
		return { type: "response", command: cmd.type, success: true, data: orphans };
	});
	Object.assign(window, { omp: { rpc: { command } } });
	registerSessionRuntime({
		tabId: "boss",
		command: command as never,
		stores: new Map([["subagents", roster as never]]),
	});
	setFocusedSessionRuntime("boss");
	useTabsStore.setState({ tabs, activeTabId: "boss" });
	useAgentReviewStore.setState({
		byTab: {},
		usage: {
			"/s/boss.jsonl": { cost: 1 },
			"/s/kid.jsonl": { model: "openai/gpt-z", cost: 0.05 },
			"C:\\s\\far.jsonl": { cost: 0.03 },
		},
	});
	useClosedChildrenStore.setState({
		rows: [
			{
				path: "/s/old.jsonl",
				openedBySession: "/s/boss.jsonl",
				title: "Old",
				cwd: "/repo",
				closedAt: 1,
				cost: 0.07,
			},
		],
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container?.remove();
	deleteSessionRuntime("boss");
	useTabsStore.setState({ tabs: [], activeTabId: null });
	useAgentReviewStore.getState().reset();
	useClosedChildrenStore.getState().reset();
	resetLastReadForTest();
});

const rowKeys = (selector = "[data-work-tree-row]") =>
	container.querySelectorAll(selector).map(row => row.getAttribute("data-work-tree-row"));

describe("WorkTreePanel", () => {
	it("lists the family with model, role and cost on every child, finished ones in a closed fold", async () => {
		await mount();
		expect(rowKeys()).toEqual(["tab:boss", "agent:boss:a", "tab:kid", "tab:far"]);
		const title = (key: string) =>
			container.querySelector(`[data-work-tree-row="${key}"]`)?.getAttribute("title") ?? "";
		expect(title("agent:boss:a")).toContain("anthropic/claude-x · @task · $0.10");
		expect(title("tab:kid")).toContain("openai/gpt-z · $0.05");
		expect(title("tab:far")).toContain("pc1");
		// The whole family: 1 (the session, its finished subagent's 0.2 inside) + 0.1 at work + 0.05 + 0.03 + 0.07 (closed).
		expect(container.querySelector("[data-work-tree-summary]")?.textContent).toBe("$1.25");

		const fold = container.querySelector("[data-work-tree-finished]");
		expect(fold?.getAttribute("aria-expanded")).toBe("false");
		expect(fold?.textContent).toBe("Finished 2");
		await act(async () => fold?.click());
		expect(rowKeys("[data-work-tree-finished-rows] [data-work-tree-row]")).toEqual([
			"agent:boss:b",
			"session:/s/old.jsonl",
		]);
	});

	it("follows a roster that changes after mount", async () => {
		await mount();
		await act(async () => {
			roster.setState({
				subagents: new Map([
					["a", agent("a", 1, "completed", 0.4)],
					["b", agent("b", 2, "completed", 0.2)],
				]),
			});
		});
		expect(rowKeys()).toEqual(["tab:boss", "tab:kid", "tab:far"]);
		// Both finished: their spend is in the session's journal (main's next push), no longer counted on their own.
		expect(container.querySelector("[data-work-tree-summary]")?.textContent).toBe("$1.15");
	});

	it("lists unused worktrees and removes only a landed one, after a confirm, then reads again", async () => {
		await mount();
		const rows = container.querySelectorAll("[data-orphan-worktree]");
		expect(rows.map(row => [row.getAttribute("data-state"), row.getAttribute("data-squashed")])).toEqual([
			["landed", "true"],
			["unlanded", null],
			["dirty", null],
		]);
		expect(rows[0]?.textContent).toContain("Squash-merged");
		expect(rows[1]?.textContent).toContain("2 unlanded");
		expect(container.querySelectorAll("[data-orphan-remove]").map(b => b.getAttribute("data-orphan-remove"))).toEqual(
			["/wt/gui-a"],
		);
		await act(async () => container.querySelector('[data-orphan-remove="/wt/gui-a"]')?.click());
		expect(sent.some(cmd => cmd.type === "remove_orphan_worktree")).toBe(false);
		const confirm = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Remove");
		await act(async () => (confirm as unknown as TestElement).click());
		await settle();
		expect(sent.filter(cmd => cmd.type === "remove_orphan_worktree")).toEqual([
			{ type: "remove_orphan_worktree", path: "/wt/gui-a" },
		]);
		expect(container.querySelectorAll("[data-orphan-worktree]")).toHaveLength(2);
	});
});
