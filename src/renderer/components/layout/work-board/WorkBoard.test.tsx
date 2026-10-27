import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, RpcGoalState, RpcJobRow, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { EMPTY_TURN_METER } from "../../../lib/turn-meter";
import { accountWindows, shortWindowLabel } from "../../../lib/usage-windows";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useProjectOrigins } from "../../../stores/project-origins";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore } from "../../../stores/work-board";
import { bareEmail, shortAccountLabel } from "../AccountLimit";

const { document, window, Element, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Element,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// The board's frame-batched store reads (`useFrameSelector`) schedule on the window's animation frame.
Object.assign(window, {
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});

let rows: RpcJobRow[] = [];
let goal: RpcGoalState = { enabled: false };
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows } }));
const jobRow = (job: RpcAsyncJobItem, depth = 0): RpcJobRow => ({
	kind: "job",
	depth,
	cancellable: depth === 0,
	job,
});
const getGoal = vi.fn(async () => ({ type: "response", command: "get_goal", success: true, data: goal }));
let usageReports: unknown[] = [];
const getUsage = vi.fn(async () => ({
	type: "response",
	command: "get_usage",
	success: true,
	data: { reports: usageReports },
}));
let sessionSpend: unknown = null;
const getSessionSpend = vi.fn(async () =>
	sessionSpend
		? { type: "response", command: "get_session_spend", success: true, data: sessionSpend }
		: { type: "response", command: "get_session_spend", success: false, error: "unsupported_omp" },
);
const prefsSet = vi.fn(async () => {});
Reflect.set(window, "omp", {
	// Not a repository: the "Not in main yet" row stays out of these tests (WorkBoardSession.test.tsx has it).
	rpc: {
		getJobs,
		getGoal,
		getUsage,
		getSessionSpend,
		getGitUnlanded: vi.fn(async () => ({
			type: "response",
			command: "get_git_unlanded",
			success: false,
			error: "no git",
		})),
	},
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
	useUiStore.setState({ panelVisible: false });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	rows = [];
	goal = { enabled: false };
	getJobs.mockClear();
	getGoal.mockClear();
	prefsSet.mockClear();
	usageReports = [];
	sessionSpend = null;
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
	useProjectOrigins.getState().reset();
	useUiStore.setState({ panelVisible: false });
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
		await mount(760);
		expect(board()).toBeNull();
		expect(pane.hasAttribute("data-work-board")).toBe(false);
		// Too narrow to dock: the status strip says the same essentials and expands into the board.
		expect(pane.querySelector("[data-work-strip]")).not.toBeNull();
		await resize(1600);
		expect(board()).not.toBeNull();
		await resize(760);
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
		// The side panel open, the pane shows the status strip instead of nothing.
		expect(pane.querySelector("[data-work-strip]")).not.toBeNull();
		await act(async () => useUiStore.setState({ panelVisible: false }));
		expect(board()).not.toBeNull();
		expect(pane.querySelector("[data-work-strip]")).toBeNull();
	});

	it("takes no room while it has nothing to show", async () => {
		await mount();
		expect(board()).toBeNull();
		expect(pane.hasAttribute("data-work-board")).toBe(false);
	});

	it("has no close: nothing would open it again", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount();
		expect(board()).not.toBeNull();
		const labels = [...pane.querySelectorAll("[data-work-board-panel] button[aria-label]")].map(
			button => button.getAttribute("aria-label") ?? "",
		);
		expect(labels.filter(label => /hide|close/i.test(label))).toEqual([]);
	});
});

describe("WorkBoard header", () => {
	it("says what runs and waits in one sentence and shows the plan as one bar", async () => {
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
		// What needs the person first, one thing by its word; what runs is a figure beside it.
		expect(pane.querySelector("[data-board-status]")?.textContent).toBe(translate("attention.question"));
		expect(pane.querySelector(".omp-work-board-figure")?.textContent).toBe("2 running");
		expect(pane.querySelector(".omp-work-board-pulse")?.getAttribute("data-state")).toBe("waiting");
		const bar = pane.querySelector(".omp-work-board-segments");
		expect(bar?.getAttribute("aria-label")).toBe("1 of 3 done");
		expect([...(bar?.children ?? [])].map(segment => segment.getAttribute("data-status"))).toEqual([
			"completed",
			"in_progress",
			"pending",
		]);
		// The plan's bar and figure are said once, in the plan's own header; the section carries no count.
		expect(section("plan")?.querySelector(".omp-work-board-progress")?.textContent).toBe("1/3");
		expect(pane.querySelectorAll(".omp-work-board-progress")).toHaveLength(1);
		expect(section("plan")?.querySelector(".omp-work-board-count")).toBeNull();
	});

	it("says what the last turn left, not that it is idle, once the turn ended", async () => {
		await mount();
		await act(async () => useTodoStore.getState().setTurnActive(true, Date.now() - 3000));
		await act(async () => useTodoStore.getState().setTurnActive(false));
		expect(pane.querySelector("[data-board-status]")?.textContent).toBe("Turn finished");
		expect(pane.querySelector(".omp-work-board-pulse")?.getAttribute("data-state")).toBe("idle");
	});

	it("says it is idle when a plan is all there is", async () => {
		useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "a", status: "pending" }] }]);
		await mount();
		expect(pane.querySelector("[data-board-status]")?.textContent).toBe("Idle");
	});

	it("counts what needs the person once: the head, the section and its rows say the same figure", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0), agent("a2", "parked", 1)]);
		rows = [jobRow({ id: "j1", type: "bash", status: "running", label: "watch", startTime: Date.now() })];
		useExtensionUiStore
			.getState()
			.pushRequest({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Go?", message: "" });
		usePlanApprovalStore.getState().showProposal({ planFilePath: "/w/PLAN.md", planContent: "# Plan", options: [] });
		useToolsStore.setState({
			finishedTools: new Map([
				[
					"b1",
					tool({
						args: { command: "bun test" },
						status: "error",
						isError: true,
						endTime: 9,
						result: { content: [{ type: "text", text: "1 fail" }], details: { exitCode: 1 } },
					}),
				],
			]),
		});
		await mount();
		await vi.waitFor(() =>
			expect(pane.querySelector('[data-board-section="current"] [data-board-session="check"]')).not.toBeNull(),
		);
		const needs = section("needs");
		// Two asks (a question, a plan up for review): one figure, in the head, the section's count and the strip's
		// label; what runs is its own figure. The failed check is a Current work row and counts for nothing here.
		expect(needs?.querySelector(".omp-work-board-count")?.textContent).toBe("2");
		expect(needs?.querySelectorAll("li")).toHaveLength(2);
		expect(pane.querySelector("[data-board-status]")?.textContent).toBe("2 need you");
		expect(pane.querySelector(".omp-work-board-figure")?.textContent).toBe("3 running");
		expect(needs?.querySelector('[aria-live="polite"]')?.textContent).toBe("2 need you");
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
		rows = [
			jobRow({ id: "j1", type: "bash", status: "running", label: "bun run dev", startTime: Date.now() - 65_000 }),
			jobRow({ id: "j2", type: "task", status: "running", label: "a task job", startTime: 0, agentId: "a1" }),
			jobRow({ id: "j4", type: "bash", status: "running", label: "nested watch", startTime: 0 }, 1),
			jobRow({ id: "j3", type: "bash", status: "completed", label: "done", startTime: 0 }),
		];
		await mount();
		expect(pane.querySelectorAll("[data-board-agent], [data-board-job]")).toHaveLength(4);
		expect(section("now")?.textContent).toContain("Now");
		expect(pane.querySelector('[data-board-job="j4"]')?.textContent).toContain("nested watch");
		const first = pane.querySelector('[data-board-agent="a1"]');
		// One line: its title and how long it has run; what it does now, its tokens and model are the tooltip.
		expect(first?.textContent).toContain("Review the diff");
		expect(first?.textContent).not.toContain("Reading the diff");
		expect(first?.textContent).toMatch(/1m/);
		expect(first?.getAttribute("title")).toContain("Reading the diff");
		expect(first?.getAttribute("title")).toContain("12.3k tokens");
		expect(first?.getAttribute("title")).toContain("anthropic/claude-sonnet-4-5");
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

	// 27 Oct 2026: after an update restart the revived subagents' first requests took minutes; nothing said why.
	it("says a subagent a restart revived resumes after the restart until it makes a call", async () => {
		useMessagesStore.setState({
			messages: [
				{
					role: "custom",
					customType: "ompdesk-restart-subagents",
					timestamp: 1,
					display: true,
					content: "These background agents you started are working again",
					details: { jobs: [], subagents: [{ id: "a1" }] },
				},
			],
		});
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0), agent("a2", "running", 1)]);
		await mount();
		expect(pane.querySelector('[data-board-agent="a1"]')?.getAttribute("title")).toContain(
			"Resuming after the restart",
		);
		expect(pane.querySelector('[data-board-agent="a2"]')?.getAttribute("title")).not.toContain("restart");
		await act(async () =>
			useSubagentsStore
				.getState()
				.setSnapshots([
					agent("a1", "running", 0, { progress: { currentToolIntent: "Reading" } as never }),
					agent("a2", "running", 1),
				]),
		);
		expect(pane.querySelector('[data-board-agent="a1"]')?.getAttribute("title")).toContain("Reading");
		expect(pane.querySelector('[data-board-agent="a1"]')?.getAttribute("title")).not.toContain("restart");
	});

	it("opens Background tasks from a job row", async () => {
		rows = [jobRow({ id: "j1", type: "bash", status: "running", label: "watch", startTime: Date.now() })];
		await mount();
		await click('[data-board-job="j1"]');
		expect(useUiStore.getState().viewSheet?.view).toBe("jobs");
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
		const plan = section("plan");
		// The plan's figure is its header's one bar; the section lists the work and carries no count.
		expect(plan?.querySelector(".omp-work-board-progress")?.textContent).toBe("5/7");
		expect(plan?.querySelector(".omp-work-board-count")).toBeNull();
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
			useTodoStore.getState().setTurnActive(true, Date.now() - 24_000);
			useMessagesStore.setState({ turnMeter: { ...EMPTY_TURN_METER, startedAt: Date.now() - 24_000, rate: 70.4 } });
		});
		// The turn's clock reads in ten-second steps (24 s of it, or 25 s on a slow run, shows as 20s).
		expect(section("now")?.querySelector(".omp-work-board-aside")?.textContent).toMatch(/^20s · 70 tok\/s$/);
		await act(async () =>
			useMessagesStore.setState({
				turnMeter: { ...EMPTY_TURN_METER, startedAt: Date.now() - 24_000, endedAt: Date.now(), rate: 70.4 },
			}),
		);
		expect(section("now")?.textContent ?? "").not.toContain("tok/s");
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

	it("keeps Now until the last agent's row has faded out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
			await mount();
			await act(async () => useSubagentsStore.getState().setSnapshots([agent("a1", "completed", 0)]));
			// Nothing runs any more, but the row is still fading out inside its section.
			expect(section("now")).not.toBeNull();
			expect(pane.querySelector('[data-board-agent="a1"]')?.closest("li")?.getAttribute("data-exiting")).toBe(
				"true",
			);
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(section("now")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows a failed check as a Current work row, not a need, and names the plan's section for what it holds", async () => {
		useToolsStore.setState({
			finishedTools: new Map([
				[
					"b1",
					tool({
						args: { command: "bun test" },
						status: "error",
						isError: true,
						endTime: 9,
						result: { content: [{ type: "text", text: "1 fail" }], details: { exitCode: 1 } },
					}),
				],
			]),
		});
		useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "a", status: "pending" }] }]);
		await mount();
		// A failed check is a fact of the turn for Current work, never an attention: no Needs you, no danger pulse, no head clause.
		await vi.waitFor(() => expect(section("current")?.querySelector('[data-board-session="check"]')).not.toBeNull());
		expect(section("current")?.querySelector('[data-board-session="check"]')?.getAttribute("data-state")).toBe(
			"failed",
		);
		expect(section("needs")).toBeNull();
		expect(pane.querySelector(".omp-work-board-pulse")?.getAttribute("data-state")).toBe("idle");
		expect(pane.querySelector("[data-board-status]")?.textContent).not.toContain("Check failed");
		// Todos alone: "Todos", not "Plan" (the plan-mode card's word, which Needs you's "plan ready for review" says).
		expect(section("plan")?.querySelector(".omp-work-board-title")?.textContent).toContain("Todos");
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } });
		goal = { enabled: true, status: "active", objective: "Ship it" };
		await act(async () => {});
		expect(section("plan")?.querySelector(".omp-work-board-title")?.textContent).toContain("Goal & todos");
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
		// The goal is the plan's lead line, in the plan's section.
		expect(section("plan")?.querySelector("[data-board-goal]")).toBe(row);
		// One line: the objective and the larger share used (25% of the budget, 5% of the time); both in words in the
		// tooltip.
		expect(row?.textContent).toContain("Ship the release");
		expect(row?.querySelector(".omp-work-board-meta")?.textContent).toBe("25%");
		expect(row?.getAttribute("title")).toContain("50.0k / 200.0k tokens");
		expect(row?.getAttribute("title")).toContain("1m 30s / 30m");
		expect(getGoal).toHaveBeenCalled();
	});

	it("names an Autopilot run's worktree by its project and the rocket, the word only for screen readers", async () => {
		useProjectOrigins.setState({
			origins: {
				"/wt/run": {
					project: "acme-web",
					root: "/repo/acme-web",
					worktree: { kind: "autopilot", branch: "autopilot/2026-10-23", slug: "2026-10-23" },
				},
			},
		});
		useSessionStore.setState({
			cwd: "/wt/run",
			goal: { objective: "Ship the release" },
			goalState: { status: "active" },
		});
		goal = { enabled: true, status: "active", objective: "Ship the release" };
		await mount();
		const line = pane.querySelector("[data-board-project]");
		expect(line?.querySelector("svg")).not.toBeNull();
		expect(line?.querySelector(".sr-only")?.textContent).toBe(" · Autopilot");
		expect(line?.textContent).toBe("acme-web · Autopilot");
	});

	it("moves the goal's budget as stock's goal frames arrive inside a turn", async () => {
		useSessionStore.setState({ goal: { objective: "Ship the release" }, goalState: { status: "active" } });
		goal = {
			enabled: true,
			status: "active",
			objective: "Ship the release",
			tokenBudget: 200_000,
			tokensUsed: 50_000,
		};
		await mount();
		const meta = () => pane.querySelector("[data-board-goal] .omp-work-board-meta")?.textContent;
		expect(meta()).toBe("25%");
		// A tool call of the running turn: stock flushes the usage and sends goal_updated (the same status).
		goal = { ...goal, tokensUsed: 150_000 };
		await act(async () => {
			useSessionStore.setState({ goalState: { status: "active" } });
		});
		await act(async () => {});
		expect(meta()).toBe("75%");
	});

	it("puts what needs the person first, each row saying what kind it is, and announces them politely", async () => {
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
		expect(sections[0]).toBe("needs");
		expect(section("needs")?.textContent).toContain("Needs you2");
		expect(section("needs")?.querySelector("kbd")?.textContent).toBe("⌥B");
		expect(pane.querySelector('[data-board-waiting="ap1"]')?.textContent).toMatch(/^Ask.*Allow bash\?/);
		expect(pane.querySelector('[data-board-waiting="plan"]')?.textContent).toMatch(/^Review.*Plan ready for review/);
		expect(pane.querySelector('[data-board-waiting="n1"]')).toBeNull();
		const live = pane.querySelector('[aria-live="polite"]');
		expect(live?.getAttribute("role")).toBe("status");
		expect(live?.textContent).toBe("2 need you");
		expect(live?.closest("[data-board-section]")?.getAttribute("data-board-section")).toBe("needs");
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

	it("shows the turn's current step and the elapsed time under Now", async () => {
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
		// 12 s into the turn the clock reads 10s: steps of ten seconds, not a count that moves every second.
		expect(section("now")?.textContent).toContain("10s");
		// One step: the live one; the finished calls are the work card's list, which is on screen beside the board.
		expect(pane.querySelectorAll("[data-board-step]")).toHaveLength(1);
		expect(pane.querySelector('[data-board-step="done"]')).toBeNull();
		const current = pane.querySelector("[data-board-turn]");
		expect(current?.getAttribute("data-board-step")).toBe("running");
		expect(current?.textContent).toContain("Run the unit tests");
	});

	it("shows the finished turn's changes under Current work with its duration, and opens Changes", async () => {
		await mount();
		const startedAt = Date.now() - 5000;
		await act(async () => useTodoStore.getState().setTurnActive(true, startedAt));
		expect(pane.querySelector('[data-board-session="changes"]')).toBeNull();
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
		// The rows come from a lazy chunk.
		await expect.poll(() => pane.querySelector('[data-board-session="changes"]')).not.toBeNull();
		const changed = pane.querySelector('[data-board-session="changes"]');
		expect(section("current")?.querySelector(".omp-work-board-title")?.textContent).toMatch(/^Current work5\.\ds$/);
		expect(changed?.textContent).toContain("1 file changed");
		expect(changed?.textContent).toContain("+3");
		expect(section("now")).toBeNull();
		await click('[data-board-session="changes"]');
		expect(useUiStore.getState().panelTab).toBe("diff");
	});

	it("counts the finished turn when the board mounts only after it ended (a phone opening its strip)", async () => {
		const startedAt = Date.now() - 5000;
		useTodoStore.getState().setTurnActive(true, startedAt);
		useToolsStore.setState({
			finishedTools: new Map([
				[
					"e1",
					tool({
						toolName: "write",
						args: { path: "src/a.ts", content: "one\ntwo\n" },
						status: "done",
						result: { details: { path: "src/a.ts" } },
						startTime: startedAt + 1000,
						endTime: startedAt + 2000,
					}),
				],
			]),
		});
		useTodoStore.getState().setTurnActive(false);
		await mount();
		await expect.poll(() => pane.querySelector('[data-board-session="changes"]')).not.toBeNull();
		expect(pane.querySelector('[data-board-session="changes"]')?.textContent).toContain("1 file changed");
	});
});

describe("WorkBoard folds", () => {
	it("folds a section to its header and remembers it", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0)]);
		await mount();
		const fold = () => section("now")?.querySelector("button.omp-work-board-fold") as unknown as HTMLButtonElement;
		expect(fold().getAttribute("aria-expanded")).toBe("true");
		expect(pane.querySelector('[data-board-agent="a1"]')).not.toBeNull();
		await act(async () => fold().click());
		expect(fold().getAttribute("aria-expanded")).toBe("false");
		expect(fold().getAttribute("title")).toBe("Expand Now");
		expect(pane.querySelector('[data-board-agent="a1"]')).toBeNull();
		expect(prefsSet).toHaveBeenCalledWith("workBoardCollapsed", { now: true });
		await act(async () => fold().click());
		expect(pane.querySelector('[data-board-agent="a1"]')).not.toBeNull();
		expect(prefsSet).toHaveBeenLastCalledWith("workBoardCollapsed", {});
	});
});

describe("the strip panel's summary", () => {
	const phases = [
		{
			name: "Work",
			tasks: [
				{ content: "Reproduce", status: "completed" as const },
				{ content: "Fix the strip", status: "in_progress" as const },
				{ content: "Run the suite", status: "pending" as const },
			],
		},
	];
	/** A question, two subagents at work and a plan, on a pane too narrow to dock: the strip with its panel open. */
	async function openStrip(): Promise<void> {
		useExtensionUiStore
			.getState()
			.pushRequest({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Go?", message: "" });
		useSubagentsStore.getState().setSnapshots([agent("a1", "running", 0), agent("a2", "running", 1)]);
		useTodoStore.getState().setPhases(phases);
		await mount(390);
		await click("[data-work-chip]");
	}
	const panel = () => pane.querySelector("[data-work-strip-panel]:not([data-leaving])");
	const line = (id: string) => pane.querySelector(`[data-work-strip-panel] [data-board-summary="${id}"]`);

	it("lists Needs you and shows every other zone as one line with its lead and its figure", async () => {
		await openStrip();
		expect(panel()?.querySelector('[data-board-waiting="c1"]')).not.toBeNull();
		expect(line("needs")).toBeNull();
		expect(line("now")?.querySelector(".omp-work-board-count")?.textContent).toBe("2");
		expect(panel()?.querySelector("[data-board-agent]")).toBeNull();
		expect(line("plan")?.querySelector(".omp-work-board-count")?.textContent).toBe("1/3");
		expect(line("plan")?.textContent).toContain("Fix the strip");
		expect(panel()?.querySelector("[data-todo-status]")).toBeNull();
	});

	it("leads Now with the turn's live step while a turn runs", async () => {
		const startedAt = Date.now() - 12_000;
		useTodoStore.getState().setTurnActive(true, startedAt);
		useToolsStore.setState({
			liveTools: new Map([["c1", tool({ intent: "Run the unit tests", startTime: startedAt + 3000 })]]),
		});
		await mount(390);
		await click("[data-work-chip]");
		expect(line("now")?.textContent).toContain("Run the unit tests");
		expect(panel()?.querySelector("[data-board-step]")).toBeNull();
	});

	it("leads Current work with its first row's words", async () => {
		const startedAt = Date.now() - 5000;
		useTodoStore.getState().setTurnActive(true, startedAt);
		useToolsStore.setState({
			finishedTools: new Map([
				[
					"e1",
					tool({
						toolName: "write",
						args: { path: "src/a.ts", content: "one\ntwo\n" },
						status: "done",
						result: { details: { path: "src/a.ts" } },
						startTime: startedAt + 1000,
						endTime: startedAt + 2000,
					}),
				],
			]),
		});
		useTodoStore.getState().setTurnActive(false);
		// The strip shows only while it has something to say: the plan gives it its label.
		useTodoStore.getState().setPhases(phases);
		await mount(390);
		await click("[data-work-chip]");
		await expect.poll(() => line("current")).not.toBeNull();
		expect(line("current")?.textContent).toContain("1 file changed +2 −0");
		expect(panel()?.querySelector('[data-board-session="changes"]')).toBeNull();
		await act(async () => (line("current") as unknown as HTMLButtonElement).click());
		expect(panel()?.querySelector('[data-board-session="changes"]')).not.toBeNull();
	});

	it("says a finished plan's figure once", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Work",
				tasks: [
					{ content: "Reproduce", status: "completed" },
					{ content: "Fix", status: "completed" },
					{ content: "Check", status: "completed" },
				],
			},
		]);
		// A list the agent just finished stays on screen until it is dismissed.
		useTodoStore.setState({ keepClosedVisible: true });
		await mount(390);
		await click("[data-work-chip]");
		expect(line("plan")?.textContent).toContain("3 done");
		expect(line("plan")?.textContent).not.toContain("3/3");
	});

	it("keeps the zones the person opened when the run is revealed into the open panel", async () => {
		await openStrip();
		await act(async () => (line("now") as unknown as HTMLButtonElement).click());
		expect(line("now")).toBeNull();
		await act(async () => useUiStore.getState().revealWorkBoard("t1"));
		expect(panel()?.querySelector('[data-board-agent="a1"]')).not.toBeNull();
		expect(line("now")).toBeNull();
	});

	it("opens a zone in place on a tap and keeps the panel open, never touching the docked board's folds", async () => {
		useWorkBoardStore.setState({ collapsed: { plan: true }, hydrated: true });
		await openStrip();
		await act(async () => (line("now") as unknown as HTMLButtonElement).click());
		expect(panel()?.querySelector('[data-board-agent="a1"]')).not.toBeNull();
		expect(line("now")).toBeNull();
		await act(async () => (line("plan") as unknown as HTMLButtonElement).click());
		expect(panel()?.querySelectorAll("[data-todo-status]").length).toBe(2);
		await click('[data-work-strip-panel] [data-board-section="now"] button.omp-work-board-fold');
		expect(line("now")).not.toBeNull();
		expect(prefsSet).not.toHaveBeenCalled();
		expect(useWorkBoardStore.getState().collapsed).toEqual({ plan: true });
		await resize(1600);
		expect(section("plan")?.querySelector("button.omp-work-board-fold")?.getAttribute("aria-expanded")).toBe("false");
		expect(section("now")?.querySelector("button.omp-work-board-fold")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("starts every open on the summary, a reopen while the panel still leaves too", async () => {
		await openStrip();
		await act(async () => (line("now") as unknown as HTMLButtonElement).click());
		expect(line("now")).toBeNull();
		await click("[data-work-chip]");
		expect(panel()).toBeNull();
		expect(pane.querySelector("[data-work-strip-panel][data-leaving]")).not.toBeNull();
		await click("[data-work-chip]");
		expect(panel()).not.toBeNull();
		expect(line("now")).not.toBeNull();
		expect(line("plan")).not.toBeNull();
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
		// One line: the provider's mark and two gauges, shortest window first, label and used share inside; the
		// address and the resets are the tooltip.
		expect(row?.textContent).not.toContain("work@example.com");
		const gauges = [...(row?.querySelectorAll(".omp-usage-gauge") ?? [])];
		expect(gauges.map(gauge => gauge.querySelector(".omp-usage-gauge-text")?.textContent)).toEqual([
			"5H62%",
			"7D40%",
		]);
		expect(row?.querySelector(".omp-usage-gauge-reset")).toBeNull();
		expect(gauges[0]?.getAttribute("data-state")).toBe("ok");
		expect(gauges[0]?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("62");
		expect(row?.querySelector("[data-provider-mark]")).not.toBeNull();
		const tip = row?.getAttribute("title") ?? "";
		expect(tip).toContain("work@example.com");
		expect(tip).toContain("40%");
		expect(tip).toMatch(/^work@example\.com\n5H 62% · ↻ 2h( 1m)?\n7D 40% · ↻ 3d 23h\nIn use$/);
		// The long localized sentences are the accessible name.
		expect(row?.getAttribute("aria-label")).toContain("resets in 2h");
		await click("[data-board-account]");
		expect(useUiStore.getState().settingsTab).toBe("models:accounts");
	});

	it("lists one row per provider with its last-used account, the current provider first and marked", async () => {
		const codexLimits = [{ id: "openai-codex:5h", label: "5 hour", windowId: "5h", usedFraction: 0.1 }];
		usageReports = [
			report({
				provider: "openai-codex",
				account: "codex@example.com (codex…)",
				active: false,
				limits: codexLimits,
				lastUsedAt: 5,
			}),
			report({
				provider: "openai-codex",
				account: "old@example.com",
				active: false,
				limits: codexLimits,
				lastUsedAt: 1,
			}),
			report({ account: "other@example.com", active: false }),
			report(),
		];
		withAgent();
		await mount();
		const rows = [...pane.querySelectorAll("[data-board-account]")];
		expect(rows.map(row => row.getAttribute("data-board-account"))).toEqual(["anthropic", "openai-codex"]);
		// One line each: the account's address is the tooltip's first line.
		expect(rows.map(row => row.getAttribute("title")?.split("\n")[0])).toEqual([
			"work@example.com",
			"codex@example.com",
		]);
		expect(rows.map(row => row.hasAttribute("data-in-use"))).toEqual([true, false]);
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

	it("shows a metered provider's real charge for the session and today, never summed with a subscription's estimate", async () => {
		usageReports = [report()];
		// The judge's OpenRouter calls and an Anthropic subscription's replies, as `session_spend` answers them.
		sessionSpend = {
			providers: {
				openrouter: { billing: "metered", name: "OpenRouter", cost: 0.000624, today: 0.000146 },
				anthropic: { billing: "subscription", name: "Anthropic (Claude Pro/Max)", cost: 12.5, today: 3 },
				ollama: { billing: "free", name: "Ollama", cost: 0, today: 0 },
			},
			billing: { openrouter: "metered", anthropic: "subscription", ollama: "free" },
		};
		withAgent();
		await mount();
		// The rows are a lazy chunk, loaded once the session spent on a metered provider: it resolves inside act.
		await act(async () => {
			await import("./SessionSpendLine");
		});
		await vi.waitFor(() => expect(pane.querySelector("[data-board-spend-provider]")).not.toBeNull());
		const rows = [...pane.querySelectorAll("[data-board-spend-provider]")];
		expect(rows.map(row => row.getAttribute("data-board-spend-provider"))).toEqual(["openrouter"]);
		// Named as Settings' provider rows name it: stock's display name and the brand mark, never the raw id.
		expect(rows[0]?.querySelector("[data-board-spend-name]")?.textContent).toBe("OpenRouter");
		expect(rows[0]?.querySelector("[data-provider-mark]")?.getAttribute("data-provider-mark")).toBe("openrouter");
		expect(rows[0]?.getAttribute("aria-label")).toBe(
			translate("workBoard.spend.charged", { provider: "OpenRouter", cost: "$0.0006", today: "$0.0001" }),
		);
		expect(rows[0]?.querySelector("[data-board-spend-cost]")?.textContent).toBe("$0.0006");
		// Today's charge is in the words (accessible name and tooltip), not on the one-line item.
		expect(rows[0]?.getAttribute("title")).toContain("$0.0001");
		// The subscription's figure is named as an estimate apart, in the tooltip only; $12.50 never joins the charge.
		const tip = rows[0]?.getAttribute("title") ?? "";
		expect(tip).toContain(translate("workBoard.spend.estimate", { cost: "$12.50" }));
		expect(pane.textContent).not.toContain("12.5");
	});

	it("names a metered provider an older host sent no display name for by its id", async () => {
		usageReports = [report()];
		sessionSpend = {
			providers: { "acme-gateway": { billing: "metered", cost: 0.5, today: 0.5 } },
			billing: { "acme-gateway": "metered" },
		};
		withAgent();
		await mount();
		await vi.waitFor(() => expect(pane.querySelector("[data-board-spend-name]")).not.toBeNull());
		expect(pane.querySelector("[data-board-spend-name]")?.textContent).toBe("acme-gateway");
		expect(pane.querySelector("[data-board-spend] [data-provider-mark]")?.getAttribute("data-provider-mark")).toBe(
			"fallback",
		);
	});

	it("shows no spend line when nothing metered was spent", async () => {
		usageReports = [report()];
		sessionSpend = {
			providers: {
				anthropic: { billing: "subscription", name: "Anthropic (Claude Pro/Max)", cost: 12.5, today: 3 },
			},
			billing: { anthropic: "subscription" },
		};
		withAgent();
		await mount();
		expect(pane.querySelector("[data-board-spend]")).toBeNull();
	});
});

describe("shortAccountLabel", () => {
	it("drops a parenthesized name that repeats the address and keeps any other", () => {
		expect(shortAccountLabel("user7616@example.com (user7616)")).toBe("user7616@example.com");
		expect(shortAccountLabel("user7616@example.com (use…")).toBe("user7616@example.com");
		expect(shortAccountLabel("work@example.com (Work account)")).toBe("work@example.com (Work account)");
		expect(shortAccountLabel("user7616@example.com (user76...")).toBe("user7616@example.com");
		expect(shortAccountLabel("plain label")).toBe("plain label");
	});
});

describe("bareEmail", () => {
	it("keeps the address only, whatever follows it in parentheses", () => {
		expect(bareEmail("user@example.net (user@ex…")).toBe("user@example.net");
		expect(bareEmail("work@example.com (te…")).toBe("work@example.com");
		expect(bareEmail("work@example.com (Work account)")).toBe("work@example.com");
		expect(bareEmail("plain label")).toBe("plain label");
	});
});
