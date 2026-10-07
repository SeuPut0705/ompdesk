/**
 * Sidebar subagent rows: a session open in a tab lists its roster nested by
 * spawn parent (max two levels) with a status glyph; closed sessions render
 * nothing; the group opens itself while anything runs and remembers the
 * user's toggle; many finished trees fold into "Done N"; a row opens the
 * transcript sheet against the owning tab; reveal expands + focuses.
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

function rows(): TestElement[] {
	return Array.from(document.querySelectorAll("[data-sidebar-subagent]")) as unknown as TestElement[];
}

function row(id: string): TestElement {
	const found = document.querySelector(`[data-sidebar-subagent="${id}"]`) as unknown as TestElement | null;
	if (!found) throw new Error(`row not found: ${id}`);
	return found;
}

function toggle(): TestElement | null {
	return document.querySelector(`[data-roving-item="subagents:${SESSION}"]`) as unknown as TestElement | null;
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
	useSidebarSubagentsStore.setState({ expanded: {}, reveal: null });
	useUiStore.setState({ sidebarVisible: true });
});

describe("SidebarSubagents", () => {
	it("nests each subagent under its spawner with a status glyph; closed sessions show nothing", async () => {
		seed(
			[
				snap({ id: "r1", index: 1, agent: "scout", description: "map the repo", status: "running" }),
				snap({ id: "c1", index: 2, description: "read files", status: "completed", parentSubagentId: "r1" }),
				snap({ id: "g1", index: 3, description: "deep dive", status: "failed", parentSubagentId: "c1" }),
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

		expect(rows().map(element => element.getAttribute("data-sidebar-subagent"))).toEqual([
			"r1",
			"c1",
			"g1",
			"r2",
			"c2",
		]);
		expect(document.querySelectorAll("[data-sidebar-subagents]").length).toBe(1);
		// Top-level spawns indent one level; grandchildren clamp to the second level.
		expect(row("r1").className).toContain("pl-6");
		expect(row("c1").className).toContain("pl-10");
		expect(row("g1").className).toContain("pl-10");
		expect(row("c2").className).toContain("pl-10");
		// Status glyphs: spinner while live, check, red x, pause when parked.
		expect(row("r1").querySelector(".animate-spin")).not.toBeNull();
		expect(row("c1").querySelector(".lucide-check")).not.toBeNull();
		expect(row("g1").querySelector(".lucide-x")?.getAttribute("class")).toContain("--sc-danger");
		expect(row("r2").querySelector(".lucide-pause")).not.toBeNull();
		// Role + short label, full text in the tooltip.
		expect(row("r1").textContent).toContain("scout · map the repo");
		expect(row("r1").getAttribute("title")).toContain("scout · map the repo");
		expect(toggle()?.textContent).toContain(translate("sidebar.subagents.toggle", { count: 5 }));
	});

	it("opens while anything runs, folds once all finish, and remembers the user's toggle", async () => {
		seed([snap({ id: "r1", status: "running" })]);
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(rows().length).toBe(1);

		seed([snap({ id: "r1", status: "completed" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(rows().length).toBe(0);

		await click(toggle());
		expect(rows().length).toBe(1);
		expect(useSidebarSubagentsStore.getState().expanded[SESSION]).toBe(true);
	});

	it("folds fully finished spawn trees into a Done summary when there are many", async () => {
		seed([
			snap({ id: "live", index: 1, status: "running" }),
			snap({ id: "liveChild", index: 2, status: "completed", parentSubagentId: "live" }),
			...[3, 4, 5, 6].map(index => snap({ id: `done${index}`, index, status: "completed" })),
		]);
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		// A finished child of a live parent stays with its tree.
		expect(rows().map(element => element.getAttribute("data-sidebar-subagent"))).toEqual(["live", "liveChild"]);
		const summary = document.querySelector(
			`[data-roving-item="subagents-done:${SESSION}"]`,
		) as unknown as TestElement;
		expect(summary.textContent).toContain(translate("sidebar.subagents.finished", { count: 4 }));

		await click(summary);
		expect(rows().length).toBe(6);
	});

	it("opens the subagent's transcript sheet against its own tab", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		await click(row("r1"));

		const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')) as unknown as TestElement[];
		expect(dialogs.length).toBe(1);
		expect(dialogs[0]!.textContent).toContain("map the repo");
		expect(commandForTab).toHaveBeenCalledWith(
			TAB,
			expect.objectContaining({ type: "get_subagent_messages", subagentId: "r1", sessionFile: "/tmp/r1.jsonl" }),
			undefined,
		);
	});

	it("reveal shows the sidebar and expands a folded group", async () => {
		seed([snap({ id: "r1", status: "completed" })]);
		useUiStore.setState({ sidebarVisible: false });
		await mount(<SidebarSubagents sessionKey={SESSION} tabId={TAB} />);
		expect(rows().length).toBe(0);

		act(() => revealSidebarSubagents(TAB));
		await flush();
		expect(useUiStore.getState().sidebarVisible).toBe(true);
		expect(rows().length).toBe(1);
		expect(useSidebarSubagentsStore.getState().reveal).toBeNull();
	});
});
