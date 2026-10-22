import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewItem } from "../../../../shared/agent-control";
import { I18nProvider } from "../../../lib/i18n";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { useClosedChildrenStore } from "../../../stores/closed-children";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore } from "../../../stores/work-board";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const item = (patch: Partial<AgentReviewItem> = {}): AgentReviewItem => ({
	tabId: "child1",
	title: "Alpha",
	state: "needs-review",
	branch: "omp/agent/a",
	baseBranch: "main",
	commitsAhead: 2,
	files: 3,
	added: 20,
	removed: 4,
	uncommitted: 0,
	answer: "Done: tests pass",
	...patch,
});

let listed: AgentReviewItem[] = [];
const commandForTab = vi.fn(async (_tab: string, _command: { type: string }) => ({
	type: "response",
	success: true,
	data: { items: listed },
}));
const getJobs = vi.fn(async () => ({ type: "response", success: true, data: { rows: [] } }));
const getGoal = vi.fn(async () => ({ type: "response", success: true, data: { enabled: false } }));
const getUsage = vi.fn(async () => ({ type: "response", success: true, data: { reports: [] } }));
Reflect.set(window, "omp", {
	rpc: {
		getJobs,
		getGoal,
		getUsage,
		commandForTab,
		getGitUnlanded: vi.fn(async () => ({ type: "response", success: false, error: "no git" })),
	},
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

type Entries = { target: Element; contentRect: { width: number } }[];
const observers: Array<{ element: Element; callback: (entries: Entries) => void }> = [];
class FakeResizeObserver {
	constructor(private readonly callback: (entries: Entries) => void) {}
	observe(element: Element) {
		observers.push({ element, callback: this.callback });
	}
	disconnect() {}
}
Reflect.set(globalThis, "ResizeObserver", FakeResizeObserver);

const { createRoot } = await import("react-dom/client");
const { WorkBoardHost } = await import("./WorkBoard");
// The board's lazy chunks, loaded (and transformed) here once, so React.lazy finds them in the module cache and a
// mount never races a first transform: on a slow runner that took longer than any fixed wait.
await Promise.all([import("./WorkBoardOpened"), import("./WorkBoardSession"), import("./SessionSpendLine")]);

let container: HTMLElement;
let root: Root;
let pane: HTMLElement;

async function mount(more: Array<Record<string, unknown>> = []): Promise<void> {
	useTabsStore.setState({
		tabs: [
			{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false, sessionPath: "/s/t1.jsonl" },
			...more,
		] as never,
		activeTabId: "t1",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	pane = document.createElement("section") as unknown as HTMLElement;
	pane.className = "omp-session-pane";
	container.appendChild(pane as never);
	document.body.appendChild(container as never);
	root = createRoot(pane as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<WorkBoardHost />
			</I18nProvider>,
		);
	});
	await act(async () => {
		for (const observer of observers)
			if (observer.element === (pane as unknown as Element))
				observer.callback([{ target: pane as unknown as Element, contentRect: { width: 1600 } }]);
	});
	// The lazy chunks are already loaded above: one macrotask lets React.lazy resolve from the module cache.
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

const section = () => pane.querySelector('[data-board-section="review"]');
const buttons = () => [...pane.querySelectorAll(".omp-work-board-actions button")] as unknown as HTMLButtonElement[];

beforeEach(() => {
	observers.length = 0;
	listed = [];
	commandForTab.mockClear();
	useUiStore.setState({ panelVisible: false });
	useWorkBoardStore.getState().reset();
	useAgentReviewStore.getState().reset();
	useClosedChildrenStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

describe("work board without a review section", () => {
	const unmerged = {
		id: "child1",
		cwd: "/w",
		status: "ready",
		kind: "agent",
		unreadDone: false,
		openedBy: "t1",
		title: "Alpha",
		lastRun: { stopReason: "stop", text: "ok" },
		worktree: { name: "a", branch: "omp/agent/a", baseCwd: "/w", path: "/wt/a" },
	};

	it("asks for the list when it mounts and shows a finished, unmerged child as a plain row with no buttons", async () => {
		listed = [item()];
		await mount([unmerged]);
		expect(commandForTab).toHaveBeenCalledWith("t1", { type: "agent_control_review" });
		expect(section()).toBeNull();
		expect(pane.textContent).not.toContain("Needs review");
		expect(pane.querySelector('[data-board-opened="child1"]')?.textContent).toContain("Alpha");
		expect(buttons()).toEqual([]);
		for (const label of ["Approve", "Discard", "Accept"]) expect(pane.textContent).not.toContain(label);
	});

	it("keeps a running, a failed and a conflicted child out of any review section", async () => {
		await mount();
		for (const patch of [
			{ state: "running" as const },
			{ branch: undefined, commitsAhead: 0, failed: true as const },
			{ state: "conflict" as const, note: "src/a.ts" },
		]) {
			await act(async () => useAgentReviewStore.getState().apply({ tabId: "t1", items: [item(patch)] }));
			expect(section()).toBeNull();
			expect(buttons()).toEqual([]);
		}
	});
});

describe("work board opened sessions", () => {
	const opened = () => pane.querySelector('[data-board-section="opened"]');
	const child = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		cwd: "/w",
		status: "ready",
		kind: "agent",
		unreadDone: false,
		openedBy: "t1",
		...extra,
	});

	it("lists the unfinished ones as children, waiting first; the finished ones fold into one 'n done' row", async () => {
		listed = [
			item({ tabId: "c-run", state: "running", step: "running bash (vitest)", runningSince: Date.now() - 5_000 }),
			item({ tabId: "c-merge", branch: "omp/agent/m", baseBranch: "main", commitsAhead: 1 }),
		];
		await mount([
			child("c-done", { title: "Landed work", lastRun: { stopReason: "stop", text: "ok" } }),
			child("c-run", { status: "running", task: "Run the suite" }),
			child("c-ask", { title: "Needs an answer", awaitingInput: "input" }),
			child("c-merge", {
				title: "Unmerged work",
				lastRun: { stopReason: "stop", text: "ok" },
				worktree: { name: "m", branch: "omp/agent/m", baseCwd: "/w", path: "/wt/m" },
			}),
		]);
		// One main closed after its work landed: no tab, the same fold.
		await act(async () =>
			useClosedChildrenStore.setState({
				rows: [
					{
						path: "/s/closed.jsonl",
						openedBySession: "/s/t1.jsonl",
						title: "Closed work",
						cwd: "/w",
						closedAt: 1,
					},
				],
			}),
		);
		expect(opened()?.textContent).toContain("Child sessions");
		const listedRows = () => [...(opened()?.querySelectorAll("[data-board-opened]") ?? [])];
		const rows = listedRows();
		expect(rows.map(row => [row.getAttribute("data-board-opened"), row.getAttribute("data-status")])).toEqual([
			["c-ask", "waiting"],
			["c-merge", "problem"],
			["c-run", "running"],
		]);
		expect(opened()?.querySelector("[data-board-more]")).toBeNull();
		// The section counts what is left to look at; the finished tab and the closed session are one row, worded as
		// the plan's fold, with no "closed" count beside the title.
		expect(opened()?.querySelector(".omp-work-board-count")?.textContent).toBe("3");
		const fold = opened()?.querySelector("[data-board-opened-done]") as HTMLElement | null;
		expect(fold?.textContent).toBe("2 done");
		expect(fold?.getAttribute("data-open")).toBe("false");
		expect(opened()?.textContent).not.toContain("closed");
		// A tap lists them in place (the phone's strip stays open for it), each still opening its session.
		expect(fold?.hasAttribute("data-board-expands")).toBe(true);
		await act(async () => fold?.click());
		expect(fold?.getAttribute("data-open")).toBe("true");
		expect(listedRows().map(row => [row.getAttribute("data-board-opened"), row.getAttribute("data-status")])).toEqual(
			[
				["c-ask", "waiting"],
				["c-merge", "problem"],
				["c-run", "running"],
				["c-done", "done"],
				["/s/closed.jsonl", "done"],
			],
		);
		// Only the waiting child is marked; the list itself never takes the warning tone (it tinted every row).
		expect(opened()?.hasAttribute("data-tone")).toBe(false);
		// One line each: the title on the row; what it does now, its branch and merge state in the tooltip.
		expect(rows[2]?.textContent).toContain("Run the suite");
		expect(rows[2]?.getAttribute("title")).toContain("running bash (vitest)");
		expect(rows[1]?.getAttribute("title")).toContain("omp/agent/m → main");
		expect(rows[1]?.getAttribute("title")).toContain("Not merged");
	});

	it("shows only the fold when every child finished", async () => {
		await mount([child("c-done", { title: "Landed work", lastRun: { stopReason: "stop", text: "ok" } })]);
		expect(opened()?.querySelectorAll("[data-board-opened]")).toHaveLength(0);
		expect(opened()?.querySelector("[data-board-opened-done]")?.textContent).toBe("1 done");
		expect(opened()?.querySelector(".omp-work-board-count")).toBeNull();
	});

	it("shows four running opened sessions as one-line rows named by their task, none under Needs review", async () => {
		const tasks = ["Fix upload", "Port the parser", "Write docs", "Audit deps"];
		// Main pushes each running child with the stored title still empty.
		listed = tasks.map((_, index) => item({ tabId: `c${index}`, title: "", state: "running", step: "running bash" }));
		await mount(tasks.map((task, index) => child(`c${index}`, { status: "running", task })));
		expect(section()).toBeNull();
		expect(pane.textContent).not.toContain("Needs review");
		expect(pane.textContent).not.toContain("Untitled session");
		const rows = [...(opened()?.querySelectorAll("[data-board-opened]") ?? [])];
		expect(rows.map(row => row.getAttribute("data-status"))).toEqual(["running", "running", "running"]);
		expect(rows.map(row => row.textContent)).toEqual(tasks.slice(0, 3).map(task => expect.stringContaining(task)));
		for (const row of rows) expect(row.getAttribute("title")).toContain("running bash");
		// The section's count names all four.
		expect(opened()?.querySelector(".omp-work-board-count")?.textContent).toBe("4");
	});

	it("taps a row to show that session, and is absent without children", async () => {
		const applyAgentView = vi.fn(async () => {});
		useTabsStore.setState({ applyAgentView } as never);
		await mount();
		expect(opened()).toBeNull();
		await act(async () => root.unmount());
		container.remove();
		await mount([child("c1", { title: "One", status: "running" })]);
		await act(async () =>
			(opened()?.querySelector("[data-board-opened]") as unknown as HTMLButtonElement | null)?.click(),
		);
		expect(applyAgentView).toHaveBeenCalledWith({ tabId: "c1", how: "focus" });
	});
});
