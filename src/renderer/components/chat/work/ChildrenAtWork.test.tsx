import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewItem } from "../../../../shared/agent-control";
import { formatElapsed } from "../../../lib/format";
import { I18nProvider } from "../../../lib/i18n";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { type SessionTab, useTabsStore } from "../../../stores/tabs";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
const command = vi.fn(async (_sent: { type: string; live?: boolean }) => ({ success: true, data: null }));
Object.assign(window, {
	innerWidth: 1280,
	innerHeight: 900,
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
	omp: { rpc: { command } },
});
// React DOM loads after the linkedom globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("../LiveStepPeek");
const { ChildrenAtWork } = await import("./ChildrenAtWork");

const NOW = 1_000_000;
const tab = (over: Partial<SessionTab>): SessionTab => ({
	id: "x",
	cwd: "/w",
	status: "ready",
	kind: "agent",
	unreadDone: false,
	...over,
});
const item = (over: Partial<AgentReviewItem> & Pick<AgentReviewItem, "tabId" | "title">): AgentReviewItem => ({
	state: "running",
	commitsAhead: 0,
	files: 0,
	added: 0,
	removed: 0,
	uncommitted: 0,
	answer: "",
	...over,
});
/** The parent's agent waiting on its children, as stock presents the host tool (an `xd://` device write). */
const waiting: ToolEntry = {
	toolName: "write",
	args: { path: "xd://ompdesk_session_result", content: '{"sessions":["c1","c2"],"wait":true}' },
	streamingArgs: "",
	result: undefined,
	isError: false,
	endTime: null,
	status: "running",
	startTime: NOW - 5_000,
};
const editing: ToolEntry = { ...waiting, toolName: "edit", args: { path: "src/a.ts" } };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	useTabsStore.setState({
		tabs: [
			tab({ id: "p", title: "Boss" }),
			tab({ id: "c1", status: "running", openedBy: "p", task: "Login form", runningSince: NOW - 70_000 }),
			tab({ id: "c2", status: "running", openedBy: "p", task: "Settings page", runningSince: NOW - 20_000 }),
			tab({ id: "c3", openedBy: "p", task: "Old one", lastRun: { stopReason: "stop" } }),
			tab({ id: "u", status: "running", task: "Someone else" }),
		],
		activeTabId: "p",
		bundles: new Map(),
	});
	useAgentReviewStore.getState().apply({
		tabId: "p",
		items: [
			item({ tabId: "c1", title: "Login form", step: "bun run check:changed", runningSince: NOW - 70_000 }),
			item({ tabId: "c2", title: "Settings page", step: "Editing Sidebar.tsx", runningSince: NOW - 20_000 }),
		],
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useToolsStore.getState().reset();
	useTabsStore.getState().reset();
	useAgentReviewStore.getState().reset();
	command.mockClear();
	vi.useRealTimers();
});

const rows = () => [...container.querySelectorAll("[data-child-at-work]")];
const text = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim();

describe("the parent's live work card while it waits on its children", () => {
	async function card(entry: ToolEntry) {
		useToolsStore.setState(toolEntriesState([["w", entry]]));
		await act(async () =>
			root.render(
				<I18nProvider>
					<LiveStepPeek carriesContext thinkingLive={false} toolCallIds={["w"]} />
				</I18nProvider>,
			),
		);
	}

	it("lists each running child with its step and clock, and no session it did not open", async () => {
		await card(waiting);
		expect(rows().map(row => row.getAttribute("data-child-at-work"))).toEqual(["c1", "c2"]);
		expect(text(rows()[0] as Element)).toContain("Login form");
		expect(text(rows()[0] as Element)).toContain("bun run check:changed");
		expect(text(rows()[0] as Element)).toContain(formatElapsed(70_000));
		expect(text(rows()[1] as Element)).toContain("Editing Sidebar.tsx");
		expect(container.textContent).not.toContain("Someone else");
		expect(container.textContent).not.toContain("Old one");
	});

	it("leaves the card alone while the parent does its own work", async () => {
		await card(editing);
		expect(rows()).toHaveLength(0);
	});

	it("asks main for the live steps the board would ask for, once however many show them", async () => {
		useToolsStore.setState(toolEntriesState([["w", waiting]]));
		await act(async () =>
			root.render(
				<I18nProvider>
					<LiveStepPeek carriesContext thinkingLive={false} toolCallIds={["w"]} />
					<ChildrenAtWork />
				</I18nProvider>,
			),
		);
		await act(async () => vi.advanceTimersByTime(2_000));
		expect(command.mock.calls.filter(([sent]) => sent.type === "agent_control_review" && sent.live)).toHaveLength(1);
	});
});

describe("between the parent's turns", () => {
	it("shows the children still at work, and nothing once none is", async () => {
		await act(async () =>
			root.render(
				<I18nProvider>
					<ChildrenAtWork />
				</I18nProvider>,
			),
		);
		expect(rows()).toHaveLength(2);
		await act(async () => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(entry =>
					entry.id === "c1" || entry.id === "c2"
						? { ...entry, status: "ready", runningSince: undefined, lastRun: { stopReason: "stop" } }
						: entry,
				),
			}));
			useAgentReviewStore.getState().apply({ tabId: "p", items: [] });
		});
		expect(rows()).toHaveLength(0);
	});
});
