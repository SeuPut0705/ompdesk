import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, RpcGoalState, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { usePlanApprovalStore } from "../../stores/plan-approval";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let jobs: RpcAsyncJobItem[] = [];
let goal: RpcGoalState = { enabled: false };
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { jobs } }));
const getGoal = vi.fn(async () => ({ type: "response", command: "get_goal", success: true, data: goal }));
Reflect.set(window, "omp", {
	rpc: { getJobs, getGoal },
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

/** The pane's size, as a ResizeObserver reports it; the test drives it. */
const observers: Array<{ element: Element; callback: (entries: { contentRect: { width: number } }[]) => void }> = [];
class FakeResizeObserver {
	constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
	observe(element: Element) {
		observers.push({ element, callback: this.callback });
	}
	disconnect() {}
}
Reflect.set(globalThis, "ResizeObserver", FakeResizeObserver);

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { WorkBoardHost } = await import("./WorkBoard");

let container: HTMLElement;
let root: Root;
let pane: HTMLElement;

function agent(id: string, status: string, index: number, patch: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return { id, index, agent: "task", status, lastUpdate: Date.now(), ...patch };
}

async function mount(width = 1600): Promise<void> {
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
	await resize(width);
	// The first jobs and goal reads land.
	await act(async () => {});
}

async function resize(width: number): Promise<void> {
	await act(async () => {
		for (const observer of observers) {
			if (observer.element === (pane as unknown as Element)) observer.callback([{ contentRect: { width } }]);
		}
	});
}

const board = () => pane.querySelector("[data-work-board-panel]");
const text = () => board()?.textContent ?? "";
const click = (selector: string) =>
	act(async () => (pane.querySelector(selector) as unknown as HTMLButtonElement).click());

function liveTool(patch: Partial<ToolEntry>): ToolEntry {
	return {
		toolName: "bash",
		args: {},
		status: "running",
		streamingArgs: "",
		result: null,
		isError: false,
		startTime: 1,
		endTime: null,
		...patch,
	};
}

beforeEach(() => {
	observers.length = 0;
	useUiStore.setState({ workBoard: true, panelVisible: false });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	jobs = [];
	goal = { enabled: false };
	getJobs.mockClear();
	getGoal.mockClear();
	useSubagentsStore.getState().reset();
	useExtensionUiStore.getState().clearAll();
	usePlanApprovalStore.getState().clearProposal();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ workBoard: true, panelVisible: false });
});

describe("WorkBoard visibility", () => {
	it("shows in a pane with 300px spare beside the transcript column, named and sectioned", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount(1600);
		const aside = board();
		expect(aside?.tagName).toBe("ASIDE");
		expect(aside?.getAttribute("aria-label")).toBe("Work board");
		expect(pane.hasAttribute("data-work-board")).toBe(true);
		expect(pane.hasAttribute("data-work-board-running")).toBe(true);
		expect(pane.hasAttribute("data-work-board-todo")).toBe(false);
	});

	it("hides in a pane too narrow for it and returns when the pane widens", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount(1100);
		expect(board()).toBeNull();
		expect(pane.hasAttribute("data-work-board")).toBe(false);
		await resize(1600);
		expect(board()).not.toBeNull();
		await resize(900);
		expect(board()).toBeNull();
		expect(pane.hasAttribute("data-work-board")).toBe(false);
	});

	it("hides while the side panel is open and when the pref is off", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount();
		expect(board()).not.toBeNull();
		await act(async () => useUiStore.setState({ panelVisible: true }));
		expect(board()).toBeNull();
		expect(pane.hasAttribute("data-work-board")).toBe(false);
		await act(async () => useUiStore.setState({ panelVisible: false }));
		expect(board()).not.toBeNull();
		await act(async () => useUiStore.getState().setWorkBoard(false));
		expect(board()).toBeNull();
	});

	it("takes no room while it has nothing to show", async () => {
		await mount();
		expect(board()).toBeNull();
		expect(pane.hasAttribute("data-work-board")).toBe(false);
	});

	it("hides itself from its own button and saves the pref", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount();
		const hide = [...pane.querySelectorAll("button")].find(
			button => button.getAttribute("aria-label") === "Hide work board",
		) as unknown as HTMLButtonElement;
		await act(async () => hide.click());
		expect(useUiStore.getState().workBoard).toBe(false);
		expect(board()).toBeNull();
	});
});

describe("WorkBoard sections", () => {
	it("lists running and waiting subagents and background jobs, and opens a subagent in the side panel", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				agent("a1", "running", 0, { description: "Review the diff", progress: { tokens: 12_300 } as never }),
				agent("a2", "parked", 1, { description: "Wait for CI" }),
				agent("a3", "completed", 2, { description: "Old" }),
			]);
		jobs = [
			{ id: "j1", type: "bash", status: "running", label: "bun run dev", startTime: Date.now() - 65_000 },
			{ id: "j2", type: "task", status: "running", label: "a task job", startTime: 0 },
			{ id: "j3", type: "bash", status: "completed", label: "done", startTime: 0 },
		];
		await mount();
		expect(text()).toContain("Running3");
		expect(pane.querySelector('[data-board-agent="a1"]')?.textContent).toContain("Review the diff");
		expect(pane.querySelector('[data-board-agent="a1"]')?.textContent).toContain("12.3k tokens");
		expect(pane.querySelector('[data-board-agent="a2"]')?.getAttribute("data-status")).toBe("parked");
		expect(pane.querySelector('[data-board-agent="a3"]')).toBeNull();
		expect(pane.querySelector('[data-board-job="j1"]')?.textContent).toContain("bun run dev");
		expect(pane.querySelector('[data-board-job="j1"]')?.textContent).toMatch(/1m/);
		expect(pane.querySelector('[data-board-job="j2"]')).toBeNull();

		await click('[data-board-agent="a1"]');
		expect(useUiStore.getState().panelTab).toBe("subagent");
		expect(useUiStore.getState().panelSubagent).toEqual({ tabId: "t1", agentId: "a1" });
		// The side panel is open now: the board steps aside.
		expect(board()).toBeNull();
	});

	it("opens Background tasks from a job row", async () => {
		jobs = [{ id: "j1", type: "bash", status: "running", label: "watch", startTime: Date.now() }];
		await mount();
		await click('[data-board-job="j1"]');
		expect(useUiStore.getState().panelTab).toBe("jobs");
	});

	it("shows the todo list with progress and the active item", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Read the code", status: "completed" },
					{ content: "Write the board", status: "in_progress" },
					{ content: "Test it", status: "pending" },
				],
			},
		]);
		await mount();
		expect(pane.hasAttribute("data-work-board-todo")).toBe(true);
		expect(pane.hasAttribute("data-work-board-running")).toBe(false);
		const plan = pane.querySelector("[data-board-plan]");
		expect(plan?.textContent).toContain("Write the board");
		expect(plan?.textContent).toContain("1/3");
		expect([...pane.querySelectorAll("[data-todo-status]")].map(row => row.getAttribute("data-todo-status"))).toEqual(
			["completed", "in_progress", "pending"],
		);
	});

	it("shows the goal with its status, budget and time", async () => {
		useSessionStore.setState({ goal: { objective: "Ship the release" }, goalState: { status: "active" } });
		goal = {
			enabled: true,
			status: "active",
			objective: "Ship the release",
			tokenBudget: 200_000,
			tokensUsed: 50_000,
			timeUsedSeconds: 90,
			timeLimitSeconds: 1800,
		};
		await mount();
		const row = pane.querySelector("[data-board-goal]");
		expect(row?.getAttribute("data-board-goal")).toBe("active");
		expect(row?.textContent).toContain("Ship the release");
		expect(row?.textContent).toContain("50.0k / 200.0k tokens");
		expect(getGoal).toHaveBeenCalled();
	});

	it("lists questions and a plan review waiting on the user", async () => {
		useExtensionUiStore.getState().pushRequest({
			type: "extension_ui_request",
			id: "ap1",
			method: "select",
			title: "Allow tool: bash\nls",
			options: ["Approve", "Deny"],
		});
		useExtensionUiStore
			.getState()
			.pushRequest({ type: "extension_ui_request", id: "n1", method: "notify", message: "fyi" });
		usePlanApprovalStore.getState().showProposal({ planFilePath: "/w/PLAN.md", planContent: "# Plan", options: [] });
		await mount();
		expect(text()).toContain("Waiting on you2");
		expect(pane.querySelector('[data-board-waiting="ap1"]')?.textContent).toContain("Allow bash?");
		expect(pane.querySelector('[data-board-waiting="plan"]')?.textContent).toContain("Plan ready for review");
		expect(pane.querySelector('[data-board-waiting="n1"]')).toBeNull();
	});

	it("focuses the docked card when a waiting row is clicked", async () => {
		useExtensionUiStore.getState().pushRequest({
			type: "extension_ui_request",
			id: "c1",
			method: "confirm",
			title: "Overwrite the file?",
			message: "",
		});
		await mount();
		const card = document.createElement("section") as unknown as HTMLElement;
		card.setAttribute("data-prompt-card", "");
		const input = document.createElement("button") as unknown as HTMLElement;
		const focus = vi.fn();
		Object.assign(input, { focus });
		card.appendChild(input as never);
		pane.appendChild(card as never);
		await click('[data-board-waiting="c1"]');
		expect(focus).toHaveBeenCalled();
	});

	it("shows the current turn's step and elapsed time", async () => {
		await mount();
		await act(async () => {
			useTodoStore.getState().setTurnActive(true, Date.now() - 12_000);
			useToolsStore.setState({ liveTools: new Map([["c1", liveTool({ intent: "Run the unit tests" })]]) });
		});
		const turn = pane.querySelector("[data-board-turn]");
		expect(turn?.textContent).toContain("Run the unit tests");
		expect(turn?.textContent).toMatch(/12s|13s/);
	});

	it("sums the last turn up once it is over: duration and files changed", async () => {
		await mount();
		const startedAt = Date.now() - 5000;
		await act(async () => useTodoStore.getState().setTurnActive(true, startedAt));
		expect(pane.querySelector("[data-board-last-turn]")).toBeNull();
		await act(async () => {
			useToolsStore.setState({
				finishedTools: new Map([
					[
						"e1",
						liveTool({
							toolName: "edit",
							args: { path: "src/a.ts" },
							status: "done",
							result: { details: { path: "src/a.ts" } },
							startTime: startedAt + 1000,
							endTime: startedAt + 2000,
						}),
					],
				]),
			});
			useTodoStore.getState().setTurnActive(false);
		});
		const last = pane.querySelector("[data-board-last-turn]");
		expect(last?.textContent).toMatch(/5\.\ds/);
		expect(last?.textContent).toContain("1 file changed");
		expect(pane.querySelector("[data-board-turn]")).toBeNull();
	});
});
