/**
 * Sidebar subagent child rows: a session open in a tab lists only its live
 * subagents as session-style rows nested by spawn parent (max two levels),
 * collapsed behind a live-count disclosure until expanded; a subagent's row
 * disappears once it finishes and the expanded state goes with the last one;
 * closed sessions and sessions without live subagents render nothing;
 * clicking a row opens the live transcript against the owning tab; reveal
 * expands the rows and focuses the first one.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import type { SessionStore } from "../../stores/session";
import { deleteSessionRuntime, sessionRuntimeStore } from "../../stores/session-runtime-context";
import { revealSidebarSubagents, useSidebarSubagentsStore } from "../../stores/sidebar-subagents";
import type { SubagentGraphStore } from "../../stores/subagent-graph";
import type { SubagentsStore } from "../../stores/subagents";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(window as unknown as Record<string, unknown>).setTimeout = setTimeout;
(window as unknown as Record<string, unknown>).clearTimeout = clearTimeout;

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { SidebarSubagents, SidebarSubagentsToggle, formatCompactElapsed } = await import("./SidebarSubagents");

const TAB = "t1";
const SESSION = "/work/alpha/one.jsonl";

interface TestElement {
	dispatchEvent: (event: object) => boolean;
	textContent: string | null;
	className: string;
	parentElement: TestElement | null;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	remove: () => void;
}

let commandForTab: Mock<(tabId: string, command: RpcCommand) => Promise<unknown>>;
let container: TestElement;
let root: Root;

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "task", status: "running", lastUpdate: Date.now(), ...overrides };
}

function seed(agents: SubagentSnapshot[], owners: Record<string, string> = {}): void {
	act(() => {
		sessionRuntimeStore<SubagentsStore>(TAB, "subagents")!.getState().setSnapshots(agents);
		for (const [callId, owner] of Object.entries(owners)) {
			sessionRuntimeStore<SubagentGraphStore>(TAB, "subagentGraph")!
				.getState()
				.registerToolCallOwners(owner, [callId]);
		}
	});
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function click(target: TestElement | null): Promise<void> {
	if (!target) throw new Error("click: element is null");
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

function rowIds(): (string | null)[] {
	return Array.from(document.querySelectorAll("[data-sidebar-subagent]")).map(element =>
		element.getAttribute("data-sidebar-subagent"),
	);
}

function row(id: string): TestElement {
	const found = document.querySelector(`[data-sidebar-subagent="${id}"]`) as unknown as TestElement | null;
	if (!found) throw new Error(`row not found: ${id}`);
	return found;
}

/** Tree depth of a child row (0 = spawned by the session). */
function depth(id: string): string | null | undefined {
	return row(id).parentElement?.getAttribute("data-subagent-depth");
}

function toggle(): TestElement | null {
	return document.querySelector(`[data-sidebar-subagents-toggle="${SESSION}"]`) as unknown as TestElement | null;
}

/** Disclosure + rows, the way the sidebar mounts them for one session row. */
function Session({ sessionKey = SESSION, tabId = TAB }: { sessionKey?: string; tabId?: string }) {
	return (
		<>
			<SidebarSubagentsToggle sessionKey={sessionKey} tabId={tabId} />
			<SidebarSubagents sessionKey={sessionKey} tabId={tabId} />
		</>
	);
}

function expand(): void {
	act(() => useSidebarSubagentsStore.getState().setExpanded(SESSION, true));
}

beforeEach(() => {
	commandForTab = vi.fn(async (_tabId: string, command: RpcCommand) => ({
		type: "response",
		command: command.type,
		success: true,
		data: command.type === "get_subagent_messages" ? { messages: [], nextByte: 0 } : { ok: true, subagents: [] },
	}));
	(window as unknown as { omp: unknown }).omp = { rpc: { commandForTab } };
	ensureTabRuntime(TAB);
	sessionRuntimeStore<SessionStore>(TAB, "session")!.setState({ status: "ready" });
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	deleteSessionRuntime(TAB);
	useSidebarSubagentsStore.setState({ expanded: new Set(), reveal: null });
	useUiStore.setState({ sidebarVisible: true });
});

describe("SidebarSubagents", () => {
	it("starts collapsed behind a live-count disclosure that toggles the rows", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "r2", index: 2, status: "parked" }),
			snap({ id: "r3", index: 3, status: "pending" }),
			snap({ id: "old", index: 4, status: "completed" }),
		]);
		await mount(<Session />);

		expect(rowIds()).toEqual([]);
		expect(document.querySelector("[data-sidebar-subagents]")).toBeNull();
		expect(toggle()?.textContent).toBe("3");
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(toggle()?.getAttribute("aria-label")).toBe(translate("sidebar.subagents.show", { count: 3 }));

		await click(toggle());
		expect(rowIds()).toEqual(["r1", "r2", "r3"]);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(toggle()?.getAttribute("aria-label")).toBe(translate("sidebar.subagents.hide", { count: 3 }));

		await click(toggle());
		expect(rowIds()).toEqual([]);
		expect(useSidebarSubagentsStore.getState().expanded.size).toBe(0);
	});

	it("renders live subagents as session-style child rows nested by spawner; closed sessions show nothing", async () => {
		seed(
			[
				snap({ id: "r1", index: 1, agent: "scout", description: "map the repo", status: "running" }),
				snap({ id: "c1", index: 2, description: "read files", status: "pending", parentSubagentId: "r1" }),
				snap({ id: "g1", index: 3, description: "deep dive", status: "running", parentSubagentId: "c1" }),
				snap({ id: "r2", index: 4, description: "park me", status: "parked" }),
				snap({ id: "c2", index: 5, description: "by tool call", status: "running", parentToolCallId: "call-x" }),
			],
			{ "call-x": "r2" },
		);
		expand();
		await mount(
			<>
				<Session />
				<Session sessionKey="/work/alpha/closed.jsonl" tabId="t-closed" />
			</>,
		);

		expect(rowIds()).toEqual(["r1", "c1", "g1", "r2", "c2"]);
		expect(document.querySelectorAll("[data-sidebar-subagents]").length).toBe(1);
		expect(document.querySelectorAll("[data-sidebar-subagents-toggle]").length).toBe(1);
		// Same row component as sessions; top-level spawns sit one step in, grandchildren clamp to two.
		expect(row("r1").className).toContain("omp-sidebar-session-row");
		expect([depth("r1"), depth("c1"), depth("g1"), depth("r2"), depth("c2")]).toEqual(["0", "1", "1", "0", "1"]);
		// Tree connectors: one down the group from the session icon, one per sub-subagent row.
		const group = document.querySelector("[data-sidebar-subagents]") as unknown as TestElement;
		expect(group.querySelector('[data-sidebar-subagents-connector="0"]')).not.toBeNull();
		expect(row("c1").parentElement?.querySelector('[data-sidebar-subagents-connector="1"]')).not.toBeNull();
		expect(row("r1").parentElement?.querySelector("[data-sidebar-subagents-connector]")).toBeNull();
		// Status signal: spinner while working, pause while parked.
		expect(row("r1").querySelector(".animate-spin")).not.toBeNull();
		expect(row("r2").querySelector(".lucide-pause")).not.toBeNull();
		// Focusable row button in the sidebar's roving list.
		expect(row("r1").querySelector("button")?.getAttribute("data-roving-item")).toBe(`subagent:${TAB}:r1`);
		// The row spends its width on the task; the role is in the tooltip.
		expect(row("r1").textContent).toContain("map the repo");
		expect(row("r1").textContent).not.toContain("scout ·");
		expect(row("r1").querySelector("button")?.getAttribute("title")).toContain("scout · map the repo");
	});

	it("shows compact elapsed time and keeps the full value in the tooltip", async () => {
		// No progress sample yet: elapsed counts from the last update, 10m 35s ago.
		seed([snap({ id: "r1", status: "running", lastUpdate: Date.now() - 635_000 })]);
		expand();
		await mount(<Session />);
		expect(row("r1").textContent).toContain("10m");
		expect(row("r1").textContent).not.toContain("10m 35s");
		expect(row("r1").querySelector("button")?.getAttribute("title")).toContain("10m 35s");

		expect(formatCompactElapsed(12_000)).toBe("12s");
		expect(formatCompactElapsed(635_000)).toBe("10m");
		expect(formatCompactElapsed(2 * 3_600_000 + 60_000)).toBe("2h");
	});

	it("drops a subagent's row once it finishes, and the expanded state with the last one", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "r2", index: 2, status: "running" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		expand();
		await mount(<Session />);
		expect(rowIds()).toEqual(["r1", "r2"]);

		seed([
			snap({ id: "r1", index: 1, status: "failed" }),
			snap({ id: "r2", index: 2, status: "running" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		await flush();
		expect(rowIds()).toEqual(["r2"]);
		expect(toggle()?.textContent).toBe("1");

		seed([
			snap({ id: "r1", index: 1, status: "failed" }),
			snap({ id: "r2", index: 2, status: "aborted" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		await flush();
		expect(rowIds()).toEqual([]);
		expect(document.querySelector("[data-sidebar-subagents]")).toBeNull();
		expect(toggle()).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.size).toBe(0);

		// The next fan-out starts collapsed.
		seed([snap({ id: "r3", index: 4, status: "running" })]);
		await flush();
		expect(rowIds()).toEqual([]);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
	});

	it("promotes a live child to the top level once its parent finishes", async () => {
		seed([
			snap({ id: "p", index: 1, status: "completed" }),
			snap({ id: "c", index: 2, status: "running", parentSubagentId: "p" }),
		]);
		expand();
		await mount(<Session />);
		expect(rowIds()).toEqual(["c"]);
		expect(depth("c")).toBe("0");
	});

	it("opens the subagent's live transcript against its own tab on click", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		expand();
		await mount(<Session />);
		await click(row("r1").querySelector("button"));

		const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as unknown as TestElement[];
		expect(dialogs.length).toBe(1);
		expect(dialogs[0]!.textContent).toContain("map the repo");
		expect(commandForTab).toHaveBeenCalledWith(
			TAB,
			expect.objectContaining({ type: "get_subagent_messages", subagentId: "r1", sessionFile: "/tmp/r1.jsonl" }),
			expect.any(Number),
		);
		// The opened subagent's row reads as the selected one.
		expect(row("r1").querySelector("button")?.getAttribute("aria-current")).toBe("true");
	});

	it("reveal shows the sidebar, expands the collapsed rows and focuses the first one", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "r2", index: 2, status: "running" })]);
		useUiStore.setState({ sidebarVisible: false });
		await mount(<Session />);
		expect(rowIds()).toEqual([]);

		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		try {
			act(() => revealSidebarSubagents(TAB));
			await flush();
			expect(useUiStore.getState().sidebarVisible).toBe(true);
			expect(rowIds()).toEqual(["r1", "r2"]);
			expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
			expect(focus).toHaveBeenCalledTimes(1);
			expect(focus.mock.contexts[0]).toBe(row("r1").querySelector("button"));
			expect(useSidebarSubagentsStore.getState().reveal).toBeNull();
		} finally {
			focus.mockRestore();
		}
	});
});
