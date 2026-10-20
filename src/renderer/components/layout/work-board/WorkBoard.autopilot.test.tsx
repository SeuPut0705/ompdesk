import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AutopilotAction,
	AutopilotCycleRecord,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useToolsStore } from "../../../stores/tools";
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

const ok = (command: string, data: unknown) => ({ type: "response", command, success: true, data });
const setAutopilot = vi.fn(async (_action: AutopilotAction) => ok("set_autopilot", undefined));
const prefsSet = vi.fn(async () => {});
Reflect.set(window, "omp", {
	rpc: {
		getJobs: vi.fn(async () => ok("get_jobs", { rows: [] })),
		getGoal: vi.fn(async () => ok("get_goal", { enabled: false })),
		getUsage: vi.fn(async () => ok("get_usage", { reports: [] })),
		getGitSessionChanges: vi.fn(async () =>
			ok("get_git_session_changes", { isRepo: false, root: null, base: null, files: [] }),
		),
		setAutopilot,
	},
	prefs: { get: vi.fn(async () => undefined), set: prefsSet },
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
		for (const observer of observers) {
			if (observer.element === (pane as unknown as Element))
				observer.callback([{ target: pane as unknown as Element, contentRect: { width: 1600 } }]);
		}
	});
	await act(async () => {});
}

function cycle(n: number, partial: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord {
	return {
		n,
		area: "tests",
		title: `Cycle ${n} title`,
		summary: "",
		verify: "green",
		followups: [],
		children: [],
		startedAt: n,
		durationMs: 1,
		tokens: 1,
		usd: 0,
		compactions: 0,
		...partial,
	};
}

const click = (selector: string) =>
	act(async () => (pane.querySelector(selector) as unknown as HTMLButtonElement).click());

beforeEach(() => {
	observers.length = 0;
	useUiStore.setState({ workBoard: true, panelVisible: false, panelTab: "diff" });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setAutopilot.mockClear();
	prefsSet.mockClear();
	useAutopilotStore.getState().reset();
	useWorkBoardStore.getState().reset();
	useToolsStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ workBoard: true, panelVisible: false, panelTab: "diff" });
});

describe("WorkBoard Autopilot card", () => {
	it("is the first section: the state, the last three cycles, the cost and the shipping line", async () => {
		useSessionStore.setState({ goal: { objective: "Autopilot: keep developing" }, goalState: { status: "active" } });
		useAutopilotStore.getState().apply({
			active: true,
			state: "running",
			cycle: 7,
			now: { n: 7, area: "performance", startedAt: Date.now() },
			cycles: [1, 2, 3, 4].map(n => cycle(n, n === 3 ? { verify: "red" } : {})),
			totals: { tokens: 1_840_000, usd: 6.2 },
			ship: {
				policy: { autoPush: true, autoRelease: { on: false, cadence: { kind: "every", n: 5 } }, remote: "origin" },
				queue: [],
			},
		});
		await mount();
		const sections = [...pane.querySelectorAll("[data-board-section]")].map(item =>
			item.getAttribute("data-board-section"),
		);
		expect(sections[0]).toBe("autopilot");
		expect(pane.querySelector("[data-board-autopilot-text]")?.textContent).toBe(
			translate("autopilot.cycleArea", { n: 7, area: translate("autopilot.area.performance") }),
		);
		expect([...pane.querySelectorAll("[data-board-cycle]")].map(row => row.getAttribute("data-board-cycle"))).toEqual(
			["4", "3", "2"],
		);
		expect(pane.querySelector("[data-board-autopilot-totals]")?.textContent).toContain("1.8M");
		expect(pane.querySelector("[data-board-autopilot-totals]")?.textContent).toContain(
			translate("autopilot.board.shipPush"),
		);
		// The Goal under the run is not shown a second time.
		expect(pane.querySelector("[data-board-goal]")).toBeNull();
	});

	it("ends or stops the run and opens the screen from the card", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "running", cycle: 1 });
		await mount();
		await click("[data-autopilot-stop]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "stop" });
		await click("[data-autopilot-abort]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "abort" });
		await click("[data-board-autopilot-open]");
		expect(useUiStore.getState().panelTab).toBe("autopilot");
	});

	it("folds to its header like the other sections and remembers it", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "running", cycle: 1 });
		await mount();
		await click('[data-board-section="autopilot"] .omp-work-board-fold');
		expect(pane.querySelector("[data-board-autopilot-text]")).toBeNull();
		expect(prefsSet).toHaveBeenCalledWith("workBoardCollapsed", { autopilot: true });
	});

	it("is absent for a session that is no run and for an ended one", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "ended", reason: "user" });
		await mount();
		expect(pane.querySelector('[data-board-section="autopilot"]')).toBeNull();
	});
});
