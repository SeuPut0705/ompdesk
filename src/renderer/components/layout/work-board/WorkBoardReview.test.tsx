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

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
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

	it("shows a running child as working with no buttons, and nothing at all without children", async () => {
		await mount();
		expect(section()).toBeNull();
		await act(async () => useAgentReviewStore.getState().apply({ tabId: "t1", items: [item({ state: "running" })] }));
		expect(section()?.textContent).toContain("Working…");
		expect(buttons()).toHaveLength(0);
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
