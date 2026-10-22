/**
 * An Autopilot tab's work board is the run's home (there is no side panel view for it): the head names the run and
 * its state, then the cycle in flight with the controls, the cycles, the follow-ups and shipping, above the board's other
 * sections. Wherever the board cannot dock (a narrow window, a split pane, the side panel open, the board dismissed
 * with ✕) the pane keeps the status strip, and the composer's "show the run" expands it into the board.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AutopilotAction,
	AutopilotCycleRecord,
	AutopilotStatus,
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
		getGitUnlanded: vi.fn(async () => ok("get_git_unlanded", null)),
		autopilotBranchStatus: vi.fn(async () => ok("autopilot_branch_status", { ahead: 12, behind: 0 })),
		setAutopilot,
	},
	prefs: { get: vi.fn(async () => undefined), set: prefsSet },
	system: { openExternal: vi.fn(async () => {}) },
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
// The board loads the run's sections lazily; loaded once here, the lazy() of every mount resolves within a tick.
await import("../../autopilot/AutopilotBoard");

/** Mounts the board host in a session pane `width` px wide (1600 docks the board beside the transcript). */
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
	await act(async () => {
		for (const observer of observers) {
			if (observer.element === (pane as unknown as Element))
				observer.callback([{ target: pane as unknown as Element, contentRect: { width } }]);
		}
	});
	await act(async () => {});
	await settle();
}

/** Lets the run's lazily loaded board pieces resolve and render. */
async function settle(): Promise<void> {
	for (let index = 0; index < 5; index++)
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
}

function cycle(n: number, partial: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord {
	return {
		n,
		area: "tests",
		title: `Cycle ${n} title`,
		summary: "",
		verify: "green",
		commit: `${n}a9f1c2deadbeef`,
		followups: [],
		children: [],
		startedAt: n,
		durationMs: 252_000,
		tokens: 212_000,
		usd: 0.4,
		compactions: 0,
		...partial,
	};
}

const running: AutopilotStatus = {
	active: true,
	state: "running",
	cycle: 8,
	run: "2026-10-21",
	root: "/w/wt",
	branch: "autopilot/2026-10-21",
	baseBranch: "main",
	now: { n: 8, area: "performance", title: "Cache the session list's first read", startedAt: Date.now() },
	activeMs: 3_600_000,
	cycles: [1, 2, 3, 4, 5, 6, 7].map(n =>
		cycle(
			n,
			n === 7 ? { verify: "red", commit: undefined, verifyNote: { kind: "check_failed", command: "bun test" } } : {},
		),
	),
	redStreak: 2,
	totals: { tokens: 1_840_000, usd: 6.2 },
	ship: {
		policy: { autoPush: false, autoRelease: { on: false, cadence: { kind: "agent" } }, remote: "origin", land: true },
		queue: [],
		landing: { via: "pr", url: "https://github.com/acme/web/pull/42", reason: "protected" },
	},
	children: [{ tabId: "c1", area: "performance", branch: "autopilot/2026-10-21-c8-performance", status: "running" }],
};

const $ = (selector: string) => pane.querySelector(selector);
const click = (selector: string) =>
	act(async () => (pane.querySelector(selector) as unknown as HTMLButtonElement).click());
const sections = () =>
	[...pane.querySelectorAll("[data-board-section]")].map(item => item.getAttribute("data-board-section"));

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

describe("an Autopilot tab's work board", () => {
	it("is the run's home: the head names the run and its state, then the cycle in flight, the cycles and shipping", async () => {
		useSessionStore.setState({ goal: { objective: "Autopilot: keep developing" }, goalState: { status: "active" } });
		useAutopilotStore.getState().apply(running);
		await mount();
		expect($(".omp-work-board-name")?.textContent).toBe(translate("autopilot.name"));
		expect($("[data-autopilot-state]")?.getAttribute("data-autopilot-state")).toBe("running");
		expect($("[data-board-autopilot-text]")?.textContent).toBe(
			translate("autopilot.cycleArea", { n: 8, area: translate("autopilot.area.performance") }),
		);
		expect(sections().slice(0, 2)).toEqual(["autopilot", "cycles"]);
		expect(sections()).not.toContain("backlog");
		expect($("[data-autopilot-cycle-live]")?.textContent).toContain("Cache the session list's first read");
		expect($("[data-autopilot-child]")).not.toBeNull();
		expect($("[data-autopilot-red-streak]")?.getAttribute("data-autopilot-red-streak")).toBe("2");
		expect($("[data-ship-land]")?.getAttribute("data-ship-land")).toBe("pr");
		expect($("[data-autopilot-totals]")?.textContent).toContain("1.8M");
		// The newest cycles, the older ones folded behind one row.
		expect(
			[...pane.querySelectorAll("[data-autopilot-cycle]")].map(row => row.getAttribute("data-autopilot-cycle")),
		).toEqual(["7", "6", "5", "4", "3"]);
		expect($('[data-board-section="cycles"] [data-board-more]')?.getAttribute("data-board-more")).toBe("2");
		// The Goal under the run is not shown a second time.
		expect($("[data-board-goal]")).toBeNull();
		expect(useUiStore.getState().panelVisible).toBe(false);
	});

	it("says it is picking an item before the cycle has one", async () => {
		useAutopilotStore.getState().apply({ ...running, now: { n: 8, startedAt: Date.now() } });
		await mount();
		expect($("[data-autopilot-cycle-live]")?.textContent).toContain(translate("autopilot.picking"));
	});

	it("opens a cycle's details in place: why a green was not taken, and its revert", async () => {
		useAutopilotStore.getState().apply(running);
		await mount();
		expect($('[data-autopilot-verify-note="check_failed"]')).toBeNull();
		await click('[data-autopilot-cycle="7"] button[data-board-expands]');
		expect($('[data-autopilot-verify-note="check_failed"]')).not.toBeNull();
		await click('[data-autopilot-cycle="6"] button[data-board-expands]');
		expect($('[data-autopilot-revert="6"]')).not.toBeNull();
	});

	it("sends one action per control", async () => {
		useAutopilotStore.getState().apply(running);
		await mount();
		await click("[data-autopilot-pause]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "pause" });
		await click("[data-autopilot-stop]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "stop" });
		await click("[data-autopilot-abort]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "abort" });
		expect($('[data-ship-button="push"]')).toBeNull();
	});

	it("keeps an ended run's cycles and reason, with no controls", async () => {
		useAutopilotStore.getState().apply({ ...running, state: "ended", reason: "user", now: undefined });
		await mount();
		expect($("[data-autopilot-state]")?.getAttribute("data-autopilot-state")).toBe("ended");
		expect($("[data-autopilot-reason]")?.getAttribute("data-autopilot-reason")).toBe("user");
		expect($("[data-autopilot-cycle]")).not.toBeNull();
		expect($("[data-autopilot-stop]")).toBeNull();
		expect($("[data-autopilot-pause]")).toBeNull();
	});

	it("folds the run's section to its header like the other sections and remembers it", async () => {
		useAutopilotStore.getState().apply(running);
		await mount();
		await click('[data-board-section="autopilot"] .omp-work-board-fold');
		expect($("[data-autopilot-cycle-live]")).toBeNull();
		expect(prefsSet).toHaveBeenCalledWith("workBoardCollapsed", { autopilot: true });
	});

	it("shows the run's section again when the run is revealed", async () => {
		useAutopilotStore.getState().apply(running);
		await mount();
		await click('[data-board-section="autopilot"] .omp-work-board-fold');
		await act(async () => useUiStore.getState().revealWorkBoard("t1"));
		await settle();
		expect($("[data-autopilot-cycle-live]")).not.toBeNull();
		expect(useUiStore.getState().panelVisible).toBe(false);
	});

	it("is the plain board for a session that is no run", async () => {
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } });
		await mount();
		expect($(".omp-work-board-name")?.textContent).toBe(translate("workBoard.label"));
		expect($('[data-board-section="autopilot"]')).toBeNull();
	});
});

describe("the run is reachable in every layout", () => {
	const cases: { name: string; width: number; setup?: () => void }[] = [
		{ name: "a narrow window", width: 780 },
		{ name: "a split pane too narrow for the board", width: 700 },
		{
			name: "the side panel open on Terminal",
			width: 1600,
			setup: () => useUiStore.setState({ panelVisible: true, panelTab: "terminal" }),
		},
		{ name: "the board dismissed with ✕", width: 1600, setup: () => useUiStore.setState({ workBoard: false }) },
	];
	for (const { name, width, setup } of cases)
		it(`in ${name}: the strip names the run and "show the run" expands it into the board`, async () => {
			setup?.();
			const before = { panelVisible: useUiStore.getState().panelVisible, panelTab: useUiStore.getState().panelTab };
			useAutopilotStore.getState().apply(running);
			await mount(width);
			expect($("[data-work-board-panel]")).toBeNull();
			expect($("[data-work-chip]")?.textContent).toContain(translate("autopilot.name"));
			await act(async () => useUiStore.getState().revealWorkBoard("t1"));
			await settle();
			expect($("[data-work-strip-panel] [data-autopilot-stop]")).not.toBeNull();
			expect($("[data-work-strip-panel] [data-autopilot-cycle-live]")).not.toBeNull();
			// Never the side panel: what it showed stays.
			expect({ panelVisible: useUiStore.getState().panelVisible, panelTab: useUiStore.getState().panelTab }).toEqual(
				before,
			);
		});

	it("a reveal for another tab leaves this pane's strip closed", async () => {
		useAutopilotStore.getState().apply(running);
		await mount(760);
		await act(async () => useUiStore.getState().revealWorkBoard("t2"));
		await settle();
		expect($("[data-work-strip-panel]")).toBeNull();
	});

	it("the dismissed board stays off for a session that is no run", async () => {
		useUiStore.setState({ workBoard: false });
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } });
		await mount(1600);
		expect($("[data-work-chip]")).toBeNull();
		expect($("[data-work-board-panel]")).toBeNull();
	});
});
