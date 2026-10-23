import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AutopilotAction } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const setAutopilot: Mock<(action: AutopilotAction) => Promise<RpcResponse>> = vi.fn(async () => ({
	type: "response",
	command: "set_autopilot",
	success: true,
	data: undefined,
}));
const setGoal = vi.fn();
(window as unknown as { omp: unknown }).omp = { rpc: { setAutopilot, setGoal } };

const { createRoot } = await import("react-dom/client");
const { GoalDockBar } = await import("./GoalDockBar");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	useSessionStore.setState({
		sessionId: "s1",
		goal: { objective: "Autopilot: keep developing this project" },
		goalState: { status: "active" },
	});
	resetTabRoute();
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<GoalDockBar />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setAutopilot.mockClear();
	useAutopilotStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	useUiStore.setState({ panelVisible: false, panelTab: "diff" });
});

describe("GoalDockBar for an Autopilot run", () => {
	it("shows the run's strip instead of the plain Goal controls", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "running", cycle: 4, now: { n: 4, startedAt: 1 } });
		await mount();
		expect(container.querySelector("[data-autopilot-dock]")).not.toBeNull();
		// The rocket says it is a run; its word is only for screen readers.
		expect(container.querySelector("[data-autopilot-dock] .sr-only")?.textContent).toBe(translate("autopilot.name"));
		expect(container.textContent).toContain(translate("autopilot.cycleN", { n: 4 }));
		expect(container.querySelector(`[aria-label="${translate("dock.goal.pause")}"]`)).toBeNull();
		expect(container.querySelector(`[aria-label="${translate("dock.goal.drop")}"]`)).toBeNull();
	});

	it("shows the run on the work board and sends the same stops as the board", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "running", cycle: 4, now: { n: 4, startedAt: 1 } });
		await mount();
		const before = useUiStore.getState().workBoardReveal?.seq ?? 0;
		await act(async () =>
			(container.querySelector(`[aria-label="${translate("autopilot.chip.open")}"]`) as HTMLElement).click(),
		);
		expect(useUiStore.getState().workBoardReveal?.seq).toBe(before + 1);
		expect(useUiStore.getState().panelVisible).toBe(false);
		await act(async () => (container.querySelector("[data-autopilot-stop]") as HTMLElement).click());
		expect(setAutopilot).toHaveBeenCalledWith({ action: "stop" });
		expect(setGoal).not.toHaveBeenCalled();
	});

	it("is the plain Goal strip again once the run has ended", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "ended", reason: "user" });
		await mount();
		expect(container.querySelector("[data-autopilot-dock]")).toBeNull();
		expect(container.textContent).toContain("Autopilot: keep developing this project");
	});
});
