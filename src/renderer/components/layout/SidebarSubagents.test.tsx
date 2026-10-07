/**
 * Sidebar subagent child rows: a session open in a tab lists only its live
 * subagents as session-style rows nested by spawn parent (max two levels);
 * a subagent's row disappears once it finishes; closed sessions and sessions
 * without live subagents render nothing; clicking a row opens the live
 * transcript against the owning tab; reveal focuses the first row.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
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
const { SidebarSubagents } = await import("./SidebarSubagents");

const TAB = "t1";
const SESSION = "/work/alpha/one.jsonl";

interface TestElement {
	dispatchEvent: (event: object) => boolean;
	textContent: string | null;
	className: string;
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
	useSidebarSubagentsStore.setState({ reveal: null });
	useUiStore.setState({ sidebarVisible: true });
});

describe("SidebarSubagents", () => {
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
		await mount(
			<>
				<SidebarSubagents sessionKey={SESSION} tabId={TAB} />
				<SidebarSubagents sessionKey="/work/alpha/closed.jsonl" tabId="t-closed" />
			</>,
		);

		expect(rowIds()).toEqual(["r1", "c1", "g1", "r2", "c2"]);
		expect(document.querySelectorAll("[data-sidebar-subagents]").length).toBe(1);
		// No section heading: the group holds only the subagent rows themselves.
		expect(document.querySelectorAll("[aria-expanded]").length).toBe(0);
		// Same row component as sessions; top-level spawns indent one step, grandchildren clamp to two.
		expect(row("r1").className).toContain("omp-sidebar-session-row");
		expect(row("r1").className).toContain("pl-9");
		expect(row("c1").className).toContain("pl-13");
		expect(row("g1").className).toContain("pl-13");
		expect(row("c2").className).toContain("pl-13");
		// Status signal: spinner while working, pause while parked.
		expect(row("r1").querySelector(".animate-spin")).not.toBeNull();
		expect(row("r2").querySelector(".lucide-pause")).not.toBeNull();
		// Focusable row button in the sidebar's roving list.
		expect(row("r1").querySelector("button")?.getAttribute("data-roving-item")).toBe(`subagent:${TAB}:r1`);
		// Role + short label, full text in the tooltip.
		expect(row("r1").textContent).toContain("scout · map the repo");
		expect(row("r1").querySelector("button")?.getAttribute("title")).toContain("scout · map the repo");
	});

	it("drops a subagent's row once it finishes and renders nothing without live subagents", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "r2", index: 2, status: "running" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		expect(rowIds()).toEqual(["r1", "r2"]);

		seed([
			snap({ id: "r1", index: 1, status: "failed" }),
			snap({ id: "r2", index: 2, status: "running" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		await flush();
		expect(rowIds()).toEqual(["r2"]);

		seed([
			snap({ id: "r1", index: 1, status: "failed" }),
			snap({ id: "r2", index: 2, status: "aborted" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		await flush();
		expect(rowIds()).toEqual([]);
		expect(document.querySelector("[data-sidebar-subagents]")).toBeNull();
	});

	it("promotes a live child to the top level once its parent finishes", async () => {
		seed([
			snap({ id: "p", index: 1, status: "completed" }),
			snap({ id: "c", index: 2, status: "running", parentSubagentId: "p" }),
		]);
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		expect(rowIds()).toEqual(["c"]);
		expect(row("c").className).toContain("pl-9");
	});

	it("opens the subagent's live transcript against its own tab on click", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		await click(row("r1").querySelector("button"));

		const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as unknown as TestElement[];
		expect(dialogs.length).toBe(1);
		expect(dialogs[0]!.textContent).toContain("map the repo");
		expect(commandForTab).toHaveBeenCalledWith(
			TAB,
			expect.objectContaining({ type: "get_subagent_messages", subagentId: "r1", sessionFile: "/tmp/r1.jsonl" }),
			undefined,
		);
		// The opened subagent's row reads as the selected one.
		expect(row("r1").querySelector("button")?.getAttribute("aria-current")).toBe("true");
	});

	it("reveal shows the sidebar and consumes the request", async () => {
		seed([snap({ id: "r1", status: "running" })]);
		useUiStore.setState({ sidebarVisible: false });
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);

		act(() => revealSidebarSubagents(TAB));
		await flush();
		expect(useUiStore.getState().sidebarVisible).toBe(true);
		expect(rowIds()).toEqual(["r1"]);
		expect(useSidebarSubagentsStore.getState().reveal).toBeNull();
	});
});
