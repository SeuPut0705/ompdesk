/**
 * AgentsDockCard: the compact subagent count chip above the composer. Renders
 * nothing unless an agent is live (finished-only rosters stay in the
 * sidebar), shows the running count with the status breakdown in its
 * accessible name, reveals the session's subagent group in the sidebar on
 * click (Agents › Live without a pane tab), and polls get_subagents while a
 * turn streams (parked/idle transitions emit no wire frame, so the store goes
 * stale mid-run without it).
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
import { useSessionStore } from "../../../stores/session";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { AgentsDockCard } = await import("./AgentsDockCard");

const getSubagents: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagents",
	success: true,
	data: { subagents: [] },
}));
// Window carries the omp bridge at runtime; named cast keeps the mock wiring typed.
const ompWindow = window as unknown as { omp: { rpc: { getSubagents: Mock } } };
ompWindow.omp = { rpc: { getSubagents } };

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function activateTab(): void {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	useSessionStore.setState({ sessionId: "s1" });
	resetTabRoute();
}

async function mount(element: ReactElement): Promise<void> {
	activateTab();
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	getSubagents.mockClear();
	setFocusedSessionRuntime(null);
	useSubagentsStore.getState().reset();
	useSidebarSubagentsStore.setState({ reveal: null });
	useSessionStore.setState({ isStreaming: false });
	useTabsStore.getState().reset();
	resetTabRoute();
	useUiStore.setState({ destination: "session" });
});

function chip(): HTMLButtonElement | null {
	return container.querySelector<HTMLButtonElement>('[data-testid="agents-dock-chip"]');
}

describe("AgentsDockCard", () => {
	it("renders nothing when the roster is empty or has no live agent", async () => {
		await mount(<AgentsDockCard />);
		expect(container.textContent).toBe("");

		await act(async () => {
			useSubagentsStore
				.getState()
				.setSnapshots([snap({ id: "a1", status: "completed" }), snap({ id: "a2", index: 2, status: "failed" })]);
		});
		expect(chip()).toBeNull();
	});

	it("shows a compact running-count chip with the status breakdown in its label", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "a1", index: 1, status: "running", lastUpdate: 10, description: "Audit the parser" }),
				snap({ id: "a2", index: 2, status: "running", lastUpdate: 20, description: "Trace the scroll pin" }),
				snap({ id: "a3", index: 3, status: "completed", lastUpdate: 30 }),
				snap({ id: "a4", index: 4, status: "failed", lastUpdate: 5 }),
			]);
		await mount(<AgentsDockCard />);

		// Icon + count only; the word "Subagents" lives in the accessible name.
		expect(chip()?.textContent).toBe("2");
		expect(chip()?.querySelector('[role="status"]')).not.toBeNull();
		const summary = `${translate("dock.agents")}: ${[
			translate("dock.agents.running", { count: 2 }),
			translate("dock.agents.done", { count: 1 }),
			translate("dock.agents.failed", { count: 1 }),
		].join(" · ")}`;
		expect(chip()?.getAttribute("aria-label")).toBe(`${summary}. ${translate("dock.agents.show")}`);
		expect(chip()?.getAttribute("title")).toBe(`${summary} — ${translate("dock.agents.show")}`);
		expect(container.querySelector('[role="tree"]')).toBeNull();
	});

	it("reveals the session's subagent group in the sidebar on click", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		setFocusedSessionRuntime("t1");
		await mount(<AgentsDockCard />);

		await act(async () => chip()?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(useSidebarSubagentsStore.getState().reveal?.tabId).toBe("t1");
		expect(useUiStore.getState().destination).toBe("session");
	});

	it("opens Agents › Live when no pane tab is known", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		await mount(<AgentsDockCard />);

		await act(async () => chip()?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(useSidebarSubagentsStore.getState().reveal).toBeNull();
		expect(useUiStore.getState()).toMatchObject({ destination: "agents", agentsTab: "live" });
	});

	it("polls get_subagents while streaming, stops when the turn ends", async () => {
		// Real timers + a short injected cadence: vi.useFakeTimers/advanceTimers
		// are vitest-only, and this file must also pass under `bun test`.
		const sleep = (ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		};
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		activateTab();
		useSessionStore.setState({ isStreaming: true });
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<AgentsDockCard pollMs={25} />
				</I18nProvider>,
			);
		});
		expect(getSubagents).not.toHaveBeenCalled();

		await act(async () => {
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBeGreaterThanOrEqual(1);

		// Turn ends → interval cleared, no further polls.
		await act(async () => {
			useSessionStore.setState({ isStreaming: false });
		});
		const callsAtStop = getSubagents.mock.calls.length;
		await act(async () => {
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBe(callsAtStop);
	});

	it("does not poll while streaming when no agent is live", async () => {
		const sleep = (ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		};
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "completed" })]);
		activateTab();
		useSessionStore.setState({ isStreaming: true });
		await mount(<AgentsDockCard pollMs={25} />);
		await act(async () => {
			await sleep(60);
		});
		// A finished roster has nothing frame-less to catch up on; a new spawn
		// arrives as a lifecycle frame and starts the poll.
		expect(getSubagents).not.toHaveBeenCalled();

		await act(async () => {
			useSubagentsStore.getState().applyFrame({
				type: "subagent_lifecycle",
				payload: { id: "a2", index: 2, agent: "scout", agentSource: "bundled", status: "started" },
			});
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBeGreaterThanOrEqual(1);
	});
});
