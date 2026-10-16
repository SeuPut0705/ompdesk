import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, RpcGoalState, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { EMPTY_TURN_METER } from "../../../lib/turn-meter";
import { accountWindows, shortWindowLabel } from "../../../lib/usage-windows";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore } from "../../../stores/work-board";
import { shortAccountLabel } from "../AccountLimit";

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
let usageReports: unknown[] = [];
const getUsage = vi.fn(async () => ({
	type: "response",
	command: "get_usage",
	success: true,
	data: { reports: usageReports },
}));
const prefsSet = vi.fn(async () => {});
Reflect.set(window, "omp", {
	rpc: { getJobs, getGoal, getUsage },
	prefs: { get: vi.fn(async () => undefined), set: prefsSet },
});

/** The pane's size, as a ResizeObserver reports it; the test drives it. */
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
			if (observer.element === (pane as unknown as Element))
				observer.callback([{ target: pane as unknown as Element, contentRect: { width } }]);
		}
	});
}

const board = () => pane.querySelector("[data-work-board-panel]");
const section = (id: string) => pane.querySelector(`[data-board-section="${id}"]`);
const click = (selector: string) =>
	act(async () => (pane.querySelector(selector) as unknown as HTMLButtonElement).click());

function tool(patch: Partial<ToolEntry>): ToolEntry {
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
	prefsSet.mockClear();
	usageReports = [];
	useModelStore.getState().reset();
	useMessagesStore.getState().reset();
	useWorkBoardStore.getState().reset();
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

describe("WorkBoard header", () => {
	it("sums the session up in one line and shows the todo progress as a bar", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0), agent("a2", "running", 1)]);
		useExtensionUiStore
			.getState()
			.pushRequest({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Go?", message: "" });
		useTodoStore.getState().setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "in_progress" },
					{ content: "c", status: "pending" },
				],
			},
		]);
		await mount();
		// What the sections already say is not repeated in a status line.
		expect(pane.querySelector(".omp-work-board-status")).toBeNull();
		expect(pane.querySelector(".omp-work-board-pulse")?.getAttribute("data-state")).toBe("waiting");
		const bar = pane.querySelector(".omp-work-board-segments");
		expect(bar?.getAttribute("aria-label")).toBe("1 of 3 done");
		expect([...(bar?.children ?? [])].map(segment => segment.getAttribute("data-status"))).toEqual([
			"completed",
			"in_progress",
			"pending",
		]);
		expect(pane.querySelector(".omp-work-board-progress")?.textContent).toContain("1/3 done");
	});

	it("says it is idle when only the last turn is left", async () => {
		await mount();
		await act(async () => useTodoStore.getState().setTurnActive(true, Date.now() - 3000));
		await act(async () => useTodoStore.getState().setTurnActive(false));
		expect(pane.querySelector(".omp-work-board-status")).toBeNull();
		expect(pane.querySelector(".omp-work-board-pulse")?.getAttribute("data-state")).toBe("idle");
	});
});

describe("WorkBoard sections", () => {
	it("lists running and waiting subagents and background jobs, and opens a subagent in the side panel", async () => {
		useSubagentsStore.getState().setSnapshots([
			agent("a1", "running", 0, {
				description: "Review the diff",
				progress: {
					tokens: 12_300,
					durationMs: 65_000,
					currentToolIntent: "Reading the diff",
					resolvedModel: "anthropic/claude-sonnet-4-5",
				} as never,
			}),
			agent("a2", "parked", 1, { description: "Wait for CI" }),
			agent("a3", "completed", 2, { description: "Old" }),
		]);
		jobs = [
			{ id: "j1", type: "bash", status: "running", label: "bun run dev", startTime: Date.now() - 65_000 },
			{ id: "j2", type: "task", status: "running", label: "a task job", startTime: 0 },
			{ id: "j3", type: "bash", status: "completed", label: "done", startTime: 0 },
		];
		await mount();
		expect(section("running")?.textContent).toContain("Running3");
		const first = pane.querySelector('[data-board-agent="a1"]');
		expect(first?.textContent).toContain("Review the diff");
		expect(first?.textContent).toContain("Reading the diff");
		expect(first?.textContent).toContain("12.3k tokens");
		expect(first?.textContent).toMatch(/1m/);
		expect(first?.querySelector('[data-provider-mark="anthropic"]')).not.toBeNull();
		expect(pane.querySelector('[data-board-agent="a2"]')?.getAttribute("data-status")).toBe("parked");
		expect(pane.querySelector('[data-board-agent="a3"]')).toBeNull();
		expect(pane.querySelector('[data-board-job="j1"]')?.textContent).toContain("bun run dev");
		expect(pane.querySelector('[data-board-job="j1"]')?.textContent).toMatch(/1m/);
		expect(pane.querySelector('[data-board-job="j2"]')).toBeNull();
		// Only the head pulse moves: running rows carry no animated mark (flow-performance `daily`: each one cost
		// the GPU process about 2% of a core while the transcript streamed).
		expect(pane.querySelector(".omp-work-board-pulse")?.getAttribute("data-state")).toBe("working");
		expect(pane.querySelectorAll("[data-live], .omp-work-board-sweep")).toHaveLength(0);

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

	it("shows the todo list with its active item, folds the done ones and scrolls to the card on a click", async () => {
		const tasks = [
			...Array.from({ length: 5 }, (_, index) => ({ content: `Done ${index}`, status: "completed" as const })),
			{ content: "Write the board", status: "in_progress" as const },
			{ content: "Test it", status: "pending" as const },
		];
		useTodoStore.getState().setPhases([{ name: "Work", tasks }]);
		await mount();
		expect(pane.hasAttribute("data-work-board-todo")).toBe(true);
		expect(pane.hasAttribute("data-work-board-running")).toBe(false);
		const plan = section("todos");
		expect(plan?.textContent).toContain("5/7");
		expect(plan?.textContent).toContain("5 done");
		expect(plan?.querySelector('[data-todo-status="in_progress"]')?.textContent).toContain("Write the board");
		// Every finished task folds into one "5 done" row; none is left struck through above the active one.
		expect([...pane.querySelectorAll("[data-todo-status]")].map(row => row.getAttribute("data-todo-status"))).toEqual(
			["in_progress", "pending"],
		);
		expect(pane.querySelectorAll("[data-board-done-folded]")).toHaveLength(1);

		const card = document.createElement("div") as unknown as HTMLElement;
		card.setAttribute("data-todo-snapshot", "s1");
		const scroll = vi.fn();
		Object.assign(card, { scrollIntoView: scroll });
		pane.appendChild(card as never);
		await click('[data-todo-status="in_progress"]');
		expect(scroll).toHaveBeenCalled();
	});

	it("shows the turn's token speed beside its elapsed time only while the turn streams", async () => {
		await mount();
		await act(async () => {
			useTodoStore.getState().setTurnActive(true, Date.now() - 4000);
			useMessagesStore.setState({ turnMeter: { ...EMPTY_TURN_METER, startedAt: Date.now() - 4000, rate: 70.4 } });
		});
		expect(section("turn")?.querySelector(".omp-work-board-aside")?.textContent).toMatch(/^\d+s · 70 tok\/s$/);
		await act(async () =>
			useMessagesStore.setState({
				turnMeter: { ...EMPTY_TURN_METER, startedAt: Date.now() - 4000, endedAt: Date.now(), rate: 70.4 },
			}),
		);
		expect(section("turn")?.textContent ?? "").not.toContain("tok/s");
	});

	it("exits a finished agent's row with an animation flag, then removes it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0), agent("a2", "running", 1)]);
			await mount();
			await act(async () =>
				useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0), agent("a2", "completed", 1)]),
			);
			const leaving = pane.querySelector('[data-board-agent="a2"]')?.closest("li");
			expect(leaving?.getAttribute("data-exiting")).toBe("true");
			expect(pane.querySelector('[data-board-agent="a1"]')?.closest("li")?.hasAttribute("data-exiting")).toBe(false);
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(pane.querySelector('[data-board-agent="a2"]')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the goal with its status and a budget and a time meter", async () => {
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
		const meters = [...(row?.querySelectorAll('[role="progressbar"]') ?? [])];
		expect(meters.map(meter => meter.getAttribute("aria-valuenow"))).toEqual(["25", "5"]);
		expect(getGoal).toHaveBeenCalled();
	});

	it("puts the questions waiting on the user first and announces them politely", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
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
		const sections = [...pane.querySelectorAll("[data-board-section]")].map(el =>
			el.getAttribute("data-board-section"),
		);
		expect(sections[0]).toBe("waiting");
		expect(section("waiting")?.textContent).toContain("Waiting on you2");
		expect(section("waiting")?.querySelector("kbd")?.textContent).toBe("⌥B");
		expect(pane.querySelector('[data-board-waiting="ap1"]')?.textContent).toContain("Allow bash?");
		expect(pane.querySelector('[data-board-waiting="plan"]')?.textContent).toContain("Plan ready for review");
		expect(pane.querySelector('[data-board-waiting="n1"]')).toBeNull();
		const live = pane.querySelector('[aria-live="polite"]');
		expect(live?.getAttribute("role")).toBe("status");
		expect(live?.textContent).toBe("2 waiting on you");
		expect(live?.closest("[data-board-section]")?.getAttribute("data-board-section")).toBe("waiting");
		// Nothing else on the board is a live region.
		expect(pane.querySelectorAll("[aria-live]")).toHaveLength(1);
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

	it("shows the turn's current step, its recent steps with durations and the elapsed time", async () => {
		await mount();
		const startedAt = Date.now() - 12_000;
		await act(async () => {
			useTodoStore.getState().setTurnActive(true, startedAt);
			useToolsStore.setState({
				finishedTools: new Map([
					[
						"r1",
						tool({
							toolName: "read",
							args: { path: "src/a.ts" },
							status: "done",
							startTime: startedAt + 1000,
							endTime: startedAt + 1700,
						}),
					],
				]),
				liveTools: new Map([["c1", tool({ intent: "Run the unit tests", startTime: startedAt + 3000 })]]),
			});
		});
		expect(section("turn")?.textContent).toMatch(/12s|13s/);
		expect(pane.querySelectorAll("[data-board-step]")).toHaveLength(2);
		const done = pane.querySelector('[data-board-step="done"]');
		expect(done?.textContent).toContain("src/a.ts");
		expect(done?.textContent).toContain("700ms");
		const current = pane.querySelector("[data-board-turn]");
		expect(current?.getAttribute("data-board-step")).toBe("running");
		expect(current?.textContent).toContain("Run the unit tests");
	});

	it("sums the last turn up once it is over: duration, files and lines, and opens Changes", async () => {
		await mount();
		const startedAt = Date.now() - 5000;
		await act(async () => useTodoStore.getState().setTurnActive(true, startedAt));
		expect(pane.querySelector("[data-board-last-turn]")).toBeNull();
		await act(async () => {
			useToolsStore.setState({
				finishedTools: new Map([
					[
						"e1",
						tool({
							toolName: "write",
							args: { path: "src/a.ts", content: "one\ntwo\nthree\n" },
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
		expect(section("last")?.textContent).toMatch(/5\.\ds/);
		expect(last?.textContent).toContain("1 file changed");
		expect(last?.textContent).toContain("+3");
		expect(pane.querySelector("[data-board-turn]")).toBeNull();
		await click("[data-board-last-turn]");
		expect(useUiStore.getState().panelTab).toBe("diff");
	});
});

describe("WorkBoard folds", () => {
	it("folds a section to its header and remembers it", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount();
		const fold = () =>
			section("running")?.querySelector("button.omp-work-board-fold") as unknown as HTMLButtonElement;
		expect(fold().getAttribute("aria-expanded")).toBe("true");
		expect(pane.querySelector('[data-board-agent="a1"]')).not.toBeNull();
		await act(async () => fold().click());
		expect(fold().getAttribute("aria-expanded")).toBe("false");
		expect(fold().getAttribute("title")).toBe("Expand Running");
		expect(pane.querySelector('[data-board-agent="a1"]')).toBeNull();
		expect(prefsSet).toHaveBeenCalledWith("workBoardCollapsed", { running: true });
		await act(async () => fold().click());
		expect(pane.querySelector('[data-board-agent="a1"]')).not.toBeNull();
		expect(prefsSet).toHaveBeenLastCalledWith("workBoardCollapsed", {});
	});
});

describe("WorkBoard account limit", () => {
	const report = (patch: Record<string, unknown> = {}) => ({
		provider: "anthropic",
		fetchedAt: Date.now(),
		account: "work@example.com",
		active: true,
		limits: [
			{
				id: "anthropic:5h",
				label: "5 hour",
				windowId: "5h",
				usedFraction: 0.62,
				resetsAt: Date.now() + 2 * 3_600_000 + 60_000,
			},
			{
				id: "anthropic:7d",
				label: "7 day",
				windowId: "7d",
				usedFraction: 0.4,
				resetsAt: Date.now() + 4 * 86_400_000,
			},
		],
		...patch,
	});
	const withAgent = () => {
		useSessionStore.setState({ status: "ready" });
		useModelStore.setState({ model: { provider: "anthropic", id: "claude" } as never });
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
	};

	it("shows the account in use with its tightest window, the others in the tooltip, and opens the accounts page", async () => {
		usageReports = [report({ account: "other@example.com", active: false }), report()];
		withAgent();
		await mount();
		const row = pane.querySelector("[data-board-account]");
		expect(row?.getAttribute("data-board-account")).toBe("anthropic");
		expect(row?.querySelector(".omp-work-board-account-name")?.textContent).toBe("work@example.com");
		// Two gauges, shortest window first, each with its label and used share inside and its reset beneath.
		const gauges = [...(row?.querySelectorAll(".omp-usage-gauge") ?? [])];
		expect(gauges.map(gauge => gauge.querySelector(".omp-usage-gauge-text")?.textContent)).toEqual([
			"5H62%",
			"7D40%",
		]);
		expect(gauges[0]?.querySelector(".omp-usage-gauge-reset")?.textContent).toContain("resets in 2h");
		expect(gauges[0]?.getAttribute("data-state")).toBe("ok");
		expect(gauges[0]?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("62");
		expect(row?.querySelector("[data-provider-mark]")).not.toBeNull();
		const tip = row?.getAttribute("title") ?? "";
		expect(tip).toContain("work@example.com");
		expect(tip).toContain("40%");
		await click("[data-board-account]");
		expect(useUiStore.getState().settingsTab).toBe("models:accounts");
	});

	it("tints each gauge near its limit and at it", async () => {
		usageReports = [
			report({
				limits: [
					{ id: "anthropic:5h", label: "5 hour", windowId: "5h", usedFraction: 0.85 },
					{ id: "anthropic:7d", label: "7 day", windowId: "7d", usedFraction: 1 },
				],
			}),
		];
		withAgent();
		await mount();
		const state = (window: string) => pane.querySelector(`[data-window="${window}"]`)?.getAttribute("data-state");
		expect(state("5h")).toBe("near");
		expect(state("7d")).toBe("limit");
	});

	it("shows one full-width gauge for one window and the two tightest of more, shortest first", async () => {
		usageReports = [report({ limits: [{ id: "anthropic:5h", label: "5 hour", windowId: "5h", usedFraction: 0.3 }] })];
		withAgent();
		await mount();
		expect(pane.querySelector(".omp-usage-gauges")?.getAttribute("data-count")).toBe("1");
		expect(accountWindows([]).length).toBe(0);
		const many = [
			{ id: "p:monthly", label: "Monthly", windowId: "monthly", usedFraction: 0.5 },
			{ id: "p:5h", label: "5 hour", windowId: "5h", usedFraction: 0.2 },
			{ id: "p:7d", label: "7 day", windowId: "7d", usedFraction: 0.9 },
			{ id: "p:7d:opus", label: "7 Day (Opus)", windowId: "7d", usedFraction: 0.99 },
		];
		expect(accountWindows(many).map(entry => entry.limit.id)).toEqual(["p:7d", "p:monthly"]);
		expect(many.map(limit => shortWindowLabel(limit))).toEqual(["30D", "5H", "7D", "7D"]);
	});

	it("hides for a provider with no usage windows", async () => {
		usageReports = [report({ provider: "openai", limits: [] })];
		withAgent();
		await mount();
		expect(pane.querySelector("[data-board-account]")).toBeNull();
		expect(board()).not.toBeNull();
	});
});

describe("shortAccountLabel", () => {
	it("drops a parenthesized name that repeats the address and keeps any other", () => {
		expect(shortAccountLabel("user7616@example.com (user7616)")).toBe("user7616@example.com");
		expect(shortAccountLabel("user7616@example.com (use…")).toBe("user7616@example.com");
		expect(shortAccountLabel("work@example.com (Work account)")).toBe("work@example.com (Work account)");
		expect(shortAccountLabel("plain label")).toBe("plain label");
	});
});
