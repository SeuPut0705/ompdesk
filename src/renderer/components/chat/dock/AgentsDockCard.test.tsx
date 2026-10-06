/**
 * AgentsDockCard: the center-dock subagent roster. Renders nothing while the
 * store is empty, summarizes large rosters while retaining urgent agents,
 * exposes the full roster through focus mode, and polls get_subagents while a
 * turn streams (parked/idle transitions emit no wire frame, so the store
 * goes stale mid-run without it).
 */
import { parseHTML } from "linkedom";
import { ListTodo } from "lucide-react";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentProgress, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
import { useSessionStore } from "../../../stores/session";
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
const { DockCard } = await import("./DockCard");
const { WorkspaceDockFocusProvider } = await import("./WorkspaceDockFocus");

const getSubagents: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagents",
	success: true,
	data: { subagents: [] },
}));
const getSubagentMessages: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagent_messages",
	success: true,
	data: { messages: [] },
}));
// Window carries the omp bridge at runtime; named cast keeps the mock wiring typed.
const ompWindow = window as unknown as { omp: { rpc: { getSubagents: Mock; getSubagentMessages: Mock } } };
ompWindow.omp = { rpc: { getSubagents, getSubagentMessages } };

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

function progress(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 1,
		id: "a1",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "audit",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 12_345,
		cost: 0.4321,
		durationMs: 60_000,
		...overrides,
	};
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
	useSubagentsStore.getState().reset();
	useSessionStore.setState({ isStreaming: false });
	useTabsStore.getState().reset();
	resetTabRoute();
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

function containerText(): string {
	return container.textContent ?? "";
}

describe("AgentsDockCard", () => {
	it("renders nothing when the roster is empty", async () => {
		await mount(<AgentsDockCard />);
		expect(containerText()).toBe("");
	});

	it("lists every known agent with the live/total count badge", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "a1", status: "running" }),
				snap({ id: "a2", index: 2, status: "parked" }),
				snap({ id: "a3", index: 3, status: "parked" }),
				snap({ id: "a4", index: 4, status: "completed" }),
			]);
		await mount(<AgentsDockCard />);

		// Live = running + parked; the terminal completed row stays listed.
		expect(containerText()).toContain("3/4");
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(4);
		expect(containerText()).toContain("scout");
	});

	it("shows each agent's resolved model, tokens, and cost", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([snap({ progress: progress({ resolvedModel: "openai-codex/gpt-5.6-sol:max" }) })]);
		await mount(<AgentsDockCard />);

		expect(containerText()).toContain("openai-codex/gpt-5.6-sol:max");
		expect(containerText()).toContain("12.3k tokens");
		expect(containerText()).toContain("$0.4321");
	});

	it("summarizes rosters above five agents and expands them in focus mode", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "a1", index: 1, status: "running" }),
				snap({ id: "a2", index: 2, status: "failed" }),
				snap({ id: "a3", index: 3, status: "completed", lastUpdate: 3 }),
				snap({ id: "a4", index: 4, status: "completed", lastUpdate: 4 }),
				snap({ id: "a5", index: 5, status: "completed", lastUpdate: 5 }),
				snap({ id: "a6", index: 6, status: "completed", lastUpdate: 6 }),
				snap({ id: "a7", index: 7, status: "completed", lastUpdate: 7 }),
			]);
		await mount(
			<WorkspaceDockFocusProvider>
				<DockCard icon={ListTodo} id="todo" title="Todo">
					<div data-testid="other-card-body">other card body</div>
				</DockCard>
				<AgentsDockCard />
			</WorkspaceDockFocusProvider>,
		);

		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(5);
		expect(containerText()).toContain("2 more · View all 7 agents");
		expect(container.querySelector('[data-testid="other-card-body"]')).not.toBeNull();

		const viewAll = [...container.querySelectorAll("button")].find(button =>
			button.textContent?.includes("View all 7 agents"),
		);
		await act(async () => {
			(viewAll as unknown as { click: () => void }).click();
		});
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(7);
		expect(containerText()).toContain("Back to summary");
		expect(containerText()).toContain("Todo");
		expect(container.querySelector('[data-testid="other-card-body"]')).toBeNull();

		const agentsHeader = container.querySelector('section[aria-label="Agents"] button[aria-label="Collapse"]');
		const agentsChevron = agentsHeader?.querySelectorAll("svg").item(1);
		await act(async () => {
			agentsChevron?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(container.querySelector('[role="tree"]')).toBeNull();
		expect(useUiStore.getState().dockCollapsed.agents).toBe(true);
		expect(container.querySelector('[data-testid="other-card-body"]')).not.toBeNull();
	});

	it("collapses to the header via the ui store and re-expands on focusDockCard", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		useUiStore.setState({ dockCollapsed: { agents: true } });
		await mount(<AgentsDockCard />);
		expect(container.querySelector('[role="tree"]')).toBeNull();

		await act(async () => {
			useUiStore.getState().focusDockCard("agents");
		});
		expect(useUiStore.getState().dockCollapsed.agents).toBe(false);
		expect(container.querySelector('[role="tree"]')).not.toBeNull();
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
});
