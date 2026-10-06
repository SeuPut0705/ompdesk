import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
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

const setGoal: Mock<(args: { action?: "pause" | "resume" | "drop" }) => Promise<RpcResponse>> = vi.fn(async () => ({
	type: "response",
	command: "set_goal",
	success: true,
	data: {},
}));
(window as unknown as { omp: { rpc: { setGoal: typeof setGoal } } }).omp = { rpc: { setGoal } };

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
	useSessionStore.setState({ sessionId: "s1" });
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

function button(label: string): HTMLButtonElement {
	return container.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setGoal.mockClear();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	useUiStore.setState({ modesOpen: false, modesTab: "vibe" });
});

describe("GoalDockBar", () => {
	it("keeps the objective on one compact control strip and opens goal editing", async () => {
		useSessionStore.setState({ goal: { objective: "Ship the compact renderer" }, goalState: { status: "active" } });
		await mount();

		expect(container.textContent).toContain("Active goal");
		expect(container.textContent).toContain("Ship the compact renderer");
		await act(async () => button("Edit goal").click());
		expect(useUiStore.getState()).toMatchObject({ modesOpen: true, modesTab: "goal" });
	});

	it("pauses the live goal in place and sends the native goal action", async () => {
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } });
		await mount();

		await act(async () => button("Pause").click());
		expect(setGoal).toHaveBeenCalledWith({ action: "pause" });
		expect(useSessionStore.getState().goalState?.status).toBe("paused");
		expect(container.textContent).toContain("Paused goal");
	});
});
