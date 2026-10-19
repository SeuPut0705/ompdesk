import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewItem } from "../../../../shared/agent-control";
import { I18nProvider } from "../../../lib/i18n";
import { useAgentReviewStore } from "../../../stores/agent-review";
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
const commandForTab = vi.fn(async (_tab: string, command: { action?: string }) => ({
	type: "response",
	success: true,
	data: command.action === "list" ? { items: listed } : { items: [], outcome: "merged" },
}));
const getJobs = vi.fn(async () => ({ type: "response", success: true, data: { jobs: [] } }));
const getGoal = vi.fn(async () => ({ type: "response", success: true, data: { enabled: false } }));
const getUsage = vi.fn(async () => ({ type: "response", success: true, data: { reports: [] } }));
Reflect.set(window, "omp", {
	rpc: { getJobs, getGoal, getUsage, commandForTab },
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

let container: HTMLElement;
let root: Root;
let pane: HTMLElement;

async function mount(more: Array<Record<string, unknown>> = []): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }, ...more] as never,
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
	await act(async () => {});
}

const section = () => pane.querySelector('[data-board-section="review"]');
const buttons = () => [...pane.querySelectorAll(".omp-work-board-actions button")] as unknown as HTMLButtonElement[];
const button = (label: string) => buttons().find(entry => (entry.textContent ?? "").includes(label));

beforeEach(() => {
	observers.length = 0;
	listed = [];
	commandForTab.mockClear();
	useUiStore.setState({ workBoard: true, panelVisible: false });
	useWorkBoardStore.getState().reset();
	useAgentReviewStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

describe("work board review queue", () => {
	it("asks for the list when it mounts and shows a finished child with its branch, diff stat and buttons", async () => {
		listed = [item()];
		await mount();
		expect(commandForTab).toHaveBeenCalledWith("t1", { type: "agent_control_review", action: "list" });
		expect(section()?.textContent).toContain("Needs review");
		expect(section()?.textContent).toContain("Alpha");
		expect(section()?.textContent).toContain("3 files · +20 −4");
		expect(section()?.textContent).toContain("omp/agent/a → main");
		expect(buttons().map(entry => entry.textContent)).toEqual(["Review", "Approve", "Discard"]);
	});

	it("keeps a running child out of the review queue, and a finished one with nothing to settle", async () => {
		await mount();
		expect(section()).toBeNull();
		await act(async () => useAgentReviewStore.getState().apply({ tabId: "t1", items: [item({ state: "running" })] }));
		expect(section()).toBeNull();
		await act(async () =>
			useAgentReviewStore.getState().apply({
				tabId: "t1",
				items: [item({ branch: undefined, baseBranch: undefined, commitsAhead: 0, uncommitted: 0 })],
			}),
		);
		expect(section()).toBeNull();
	});

	it("lists a failed ending as an exception", async () => {
		await mount();
		await act(async () =>
			useAgentReviewStore
				.getState()
				.apply({ tabId: "t1", items: [item({ branch: undefined, commitsAhead: 0, failed: true })] }),
		);
		expect(section()?.textContent).toContain("Alpha");
	});

	it("Approve sends the approve action for that child, and a merged outcome says so", async () => {
		listed = [item()];
		await mount();
		await act(async () => (button("Approve") as HTMLButtonElement).click());
		expect(commandForTab).toHaveBeenLastCalledWith(
			"t1",
			{ type: "agent_control_review", action: "approve", child: "child1" },
			300_000,
		);
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain("Merged the work of “Alpha”");
		expect(section()).toBeNull();
	});

	it("Discard needs a second click, and a session without a branch offers Accept", async () => {
		listed = [item(), item({ tabId: "child2", title: "Plain", branch: undefined, baseBranch: undefined })];
		await mount();
		expect(buttons().map(entry => entry.textContent)).toEqual([
			"Review",
			"Approve",
			"Discard",
			"Review",
			"Accept",
			"Discard",
		]);
		await act(async () => (button("Discard") as HTMLButtonElement).click());
		expect(commandForTab).toHaveBeenCalledTimes(1);
		expect(button("Discard for good?")).toBeDefined();
		await act(async () => (button("Discard for good?") as HTMLButtonElement).click());
		expect(commandForTab).toHaveBeenLastCalledWith(
			"t1",
			{ type: "agent_control_review", action: "discard", child: "child1" },
			300_000,
		);
	});

	it("a conflict keeps the item and names the files", async () => {
		await mount();
		await act(async () =>
			useAgentReviewStore.getState().apply({ tabId: "t1", items: [item({ state: "conflict", note: "src/a.ts" })] }),
		);
		expect(section()?.textContent).toContain("Conflict in src/a.ts. Nothing was merged.");
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

	it("lists them beside the running agents as children: waiting first, each with its status, step and branch", async () => {
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
		expect(opened()?.textContent).toContain("Opened sessions");
		const rows = [...(opened()?.querySelectorAll("[data-board-opened]") ?? [])];
		expect(rows.map(row => [row.getAttribute("data-board-opened"), row.getAttribute("data-status")])).toEqual([
			["c-ask", "waiting"],
			["c-merge", "problem"],
			["c-run", "running"],
			["c-done", "done"],
		]);
		expect(opened()?.getAttribute("data-tone")).toBe("warning");
		expect(rows[2]?.textContent).toContain("Run the suite");
		expect(rows[2]?.textContent).toContain("running bash (vitest)");
		expect(rows[1]?.textContent).toContain("omp/agent/m → main");
		expect(rows[1]?.textContent).toContain("Not merged");
	});

	it("shows four running opened sessions as four one-line rows named by their task, none under Needs review", async () => {
		const tasks = ["Fix upload", "Port the parser", "Write docs", "Audit deps"];
		// Main pushes each running child with the stored title still empty.
		listed = tasks.map((_, index) => item({ tabId: `c${index}`, title: "", state: "running", step: "running bash" }));
		await mount(tasks.map((task, index) => child(`c${index}`, { status: "running", task })));
		expect(section()).toBeNull();
		expect(pane.textContent).not.toContain("Needs review");
		expect(pane.textContent).not.toContain("Untitled session");
		const rows = [...(opened()?.querySelectorAll("[data-board-opened]") ?? [])];
		expect(rows.map(row => row.getAttribute("data-status"))).toEqual(["running", "running", "running", "running"]);
		expect(rows.map(row => row.textContent)).toEqual(tasks.map(task => expect.stringContaining(task)));
		for (const row of rows) expect(row.textContent).toContain("running bash");
		expect(opened()?.textContent).toContain("4");
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
