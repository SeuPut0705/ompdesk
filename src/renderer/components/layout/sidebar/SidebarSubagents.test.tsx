/**
 * A session's family in the sidebar: the subagents of a session open in a tab and the sessions its agent opened,
 * one compact line each under the session row. One summary chip on the row (subagents · opened sessions, the running
 * count highlighted); the group opens by itself while a child runs or waits and folds when the last one is done, the
 * person's toggle standing in between; finished subagents fold into one "n done" row; clicking a subagent opens
 * the live transcript against the owning tab; reveal expands the rows and focuses the first one.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import type { SessionStore } from "../../../stores/session";
import { deleteSessionRuntime, sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { revealSidebarSubagents, useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import type { SubagentGraphStore } from "../../../stores/subagent-graph";
import type { SubagentsStore } from "../../../stores/subagents";
import { ensureTabRuntime } from "../../../stores/tab-runtime";
import { useUiStore } from "../../../stores/ui";
import type { FamilyOpened } from "./SidebarSubagents";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
// Rows announce drags on `window` (linkedom's), which cannot dispatch Node's own CustomEvent.
globals.CustomEvent = CustomEvent;
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
const { SubagentPanel } = await import("../../panels/SubagentPanel");

const TAB = "t1";
const SESSION = "/work/alpha/one.jsonl";

interface TestElement {
	dispatchEvent: (event: object) => boolean;
	textContent: string | null;
	className: string;
	parentElement: TestElement | null;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
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

function opened(overrides: Partial<FamilyOpened> & { key: string }): FamilyOpened {
	return {
		kind: "worktree",
		state: null,
		stateLabel: "",
		title: overrides.key,
		tooltip: overrides.key,
		selected: false,
		onOpen: () => undefined,
		rowProps: { "data-sidebar-opened-session": true, "data-session-path": overrides.key },
		...overrides,
	};
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
async function fire(target: TestElement | null, type: string): Promise<void> {
	if (!target) throw new Error(`${type}: element is null`);
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

const click = (target: TestElement | null) => fire(target, "click");

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

function openedRow(key: string): TestElement {
	const found = Array.from(document.querySelectorAll("[data-sidebar-opened-session]")).find(
		element => element.getAttribute("data-session-path") === key,
	) as unknown as TestElement | undefined;
	if (!found) throw new Error(`opened row not found: ${key}`);
	return found;
}

/** Tree depth of a subagent row (0 = spawned by the session). */
function depth(id: string): string | null | undefined {
	return row(id).parentElement?.parentElement?.getAttribute("data-subagent-depth");
}

function toggle(): TestElement | null {
	return document.querySelector(`[data-sidebar-subagents-toggle="${SESSION}"]`) as unknown as TestElement | null;
}

function groupText(): string {
	return (document.querySelector("[data-sidebar-family]") as unknown as TestElement | null)?.textContent ?? "";
}

function doneFold(): TestElement | null {
	return document.querySelector(`[data-family-done="${SESSION}"]`) as unknown as TestElement | null;
}

/** Chip + rows, the way the sidebar mounts them for one session row. */
function Session({
	sessionKey = SESSION,
	tabId = TAB,
	kids = [],
}: {
	sessionKey?: string;
	tabId?: string;
	kids?: readonly FamilyOpened[];
}) {
	return (
		<>
			<SidebarSubagentsToggle opened={kids} sessionKey={sessionKey} tabId={tabId} />
			<SidebarSubagents opened={kids} sessionKey={sessionKey} tabId={tabId} />
		</>
	);
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
	useSidebarSubagentsStore.setState({
		expanded: new Set(),
		hidden: new Set(),
		present: new Set(),
		active: new Set(),
		reveal: null,
	});
	useUiStore.setState({ sidebarVisible: true, panelVisible: false, panelTab: "diff", panelSubagent: null });
});

describe("a session's family: the summary chip", () => {
	it("says how many subagents and opened sessions there are, and highlights the running count", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "r2", index: 2, status: "parked" }),
			snap({ id: "old", index: 3, status: "completed" }),
		]);
		const children = [
			opened({ key: "/wt/a.jsonl", state: "running", stateLabel: "Running" }),
			opened({ key: "/wt/b.jsonl", kind: "session", state: "done", stateLabel: "Run completed" }),
		];
		await mount(<Session kids={children} />);

		const chip = toggle();
		expect(chip?.querySelector("[data-family-agents]")?.textContent).toBe("3");
		expect(chip?.querySelector("[data-family-sessions]")?.textContent).toBe("2");
		// r1 and the first opened session run: the running count is the highlighted pill.
		const pill = chip?.querySelector("[data-family-running]");
		expect(pill?.textContent).toBe("2");
		expect(pill?.className).toContain("bg-(--sc-accent)");
		expect(chip?.getAttribute("aria-label")).toBe(
			translate("sidebar.family.hide", {
				summary: [
					translate("sidebar.family.agents", { count: 3 }),
					translate("sidebar.family.sessions", { count: 2 }),
					translate("sidebar.family.running", { count: 2 }),
				].join(", "),
			}),
		);
	});

	it("shows only what exists: no pill with nothing running, nothing at all without a family", async () => {
		seed([snap({ id: "r1", status: "completed" })]);
		await mount(<Session />);
		expect(toggle()?.querySelector("[data-family-agents]")?.textContent).toBe("1");
		expect(toggle()?.querySelector("[data-family-sessions]")).toBeNull();
		expect(toggle()?.querySelector("[data-family-running]")).toBeNull();

		seed([]);
		await flush();
		expect(toggle()).toBeNull();
	});

	it("shows the opened sessions of a tab that has no runtime yet (a relaunch that woke nothing)", async () => {
		const children = [opened({ key: "/wt/a.jsonl", title: "Check the build" })];
		await mount(<Session kids={children} sessionKey={SESSION} tabId="t-asleep" />);
		expect(toggle()?.querySelector("[data-family-sessions]")?.textContent).toBe("1");
		await click(toggle());
		expect(openedRow("/wt/a.jsonl").textContent).toContain("Check the build");
	});
});

describe("a session's family: open and closed", () => {
	it("opens by itself while a child runs, folds when the last one is done, and starts the next fan-out open", async () => {
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", state: "idle" })]} />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "r2", index: 2, status: "running" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(rowIds()).toEqual(["r1", "r2"]);

		// One finished, one still running: stays open.
		seed([snap({ id: "r1", index: 1, status: "completed" }), snap({ id: "r2", index: 2, status: "running" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

		seed([snap({ id: "r1", index: 1, status: "completed" }), snap({ id: "r2", index: 2, status: "completed" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector("[data-sidebar-family]")).toBeNull();
		// Still a family: the chip stays, now with nothing running.
		expect(toggle()?.querySelector("[data-family-running]")).toBeNull();

		seed([snap({ id: "r3", index: 3, status: "running" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
	});

	it("a waiting child keeps the family open like a running one", async () => {
		const children = [opened({ key: "/wt/a.jsonl", state: "waiting", stateLabel: "Needs approval" })];
		await mount(<Session kids={children} />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(openedRow("/wt/a.jsonl").querySelector('[data-family-status="waiting"]')).not.toBeNull();
	});

	it("remembers the person's own toggle between two edges, per session", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" })]);
		await mount(
			<>
				<Session />
				<Session sessionKey="/work/alpha/other.jsonl" tabId="t-asleep" />
			</>,
		);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

		await click(toggle());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(rowIds()).toEqual([]);
		// A progress frame that changes nothing about who runs leaves the choice alone.
		seed([snap({ id: "r1", index: 1, status: "running", lastUpdate: Date.now() + 1000 })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		// The other session has nothing: untouched.
		expect(useSidebarSubagentsStore.getState().expanded.has("/work/alpha/other.jsonl")).toBe(false);

		await click(toggle());
		expect(rowIds()).toEqual(["r1"]);
	});

	it("the chip's menu expands, collapses, hides and shows groups", async () => {
		seed([snap({ id: "r1", index: 1, status: "completed", progress: { tokens: 128_400, toolCount: 48 } as never })]);
		await mount(<Session />);
		const pick = async (label: string) => {
			await fire(toggle(), "contextmenu");
			const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
				node => node.textContent === label,
			) as unknown as TestElement | undefined;
			await click(item ?? null);
		};
		await pick("Expand all");
		await click(doneFold());
		expect(rowIds()).toEqual(["r1"]);
		expect(row("r1").querySelector("button")?.getAttribute("title")).toContain("128.4k tokens · 48 tool calls");
		await pick("Collapse all");
		expect(rowIds()).toEqual([]);
		await pick("Hide this session's subagents");
		expect(toggle()).toBeNull();
		act(() => useSidebarSubagentsStore.getState().showAll());
		await flush();
		expect(toggle()).not.toBeNull();
	});

	it("hiding the subagents leaves the sessions the agent opened", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" })]);
		act(() => useSidebarSubagentsStore.getState().setHidden(SESSION, true));
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", title: "Check the build" })]} />);
		expect(toggle()?.querySelector("[data-family-agents]")).toBeNull();
		expect(toggle()?.querySelector("[data-family-sessions]")?.textContent).toBe("1");
		await click(toggle());
		expect(rowIds()).toEqual([]);
		expect(openedRow("/wt/a.jsonl")).not.toBeNull();
	});

	it("reveal shows the sidebar, expands the collapsed rows and focuses the first one", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "r2", index: 2, status: "running" })]);
		useUiStore.setState({ sidebarVisible: false });
		await mount(<Session />);
		// Running opens the group; the person folds it before asking to see the agents.
		act(() => useSidebarSubagentsStore.getState().setExpanded(SESSION, false));
		await flush();
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

describe("a session's family: one-line rows", () => {
	it("draws a subagent as one line: kind glyph, the title, one token and the age; the status is the tooltip", async () => {
		seed(
			[
				snap({
					id: "r1",
					index: 1,
					agent: "scout",
					description: "map the repo",
					status: "running",
					lastUpdate: Date.now() - 635_000,
					progress: { lastIntent: "Reading the router", resolvedModel: "claude-x" } as never,
				}),
				snap({ id: "r2", index: 2, description: "park me", status: "parked" }),
			],
			{},
		);
		await mount(<Session />);

		const first = row("r1");
		expect(first.className).toContain("omp-family-row");
		// ONE line: a glyph, one button (the title), the token and the age: no description line under the title.
		expect(first.querySelectorAll("button").length).toBe(1);
		expect(first.querySelector('[data-family-glyph="subagent"]')).not.toBeNull();
		expect(first.querySelector('[data-family-status="running"]')).not.toBeNull();
		expect(first.textContent).toContain("map the repo");
		expect(first.textContent).toContain("10m");
		expect(first.textContent).not.toContain("Reading the router");
		expect(first.textContent).not.toContain("scout ·");
		const tooltip = first.querySelector("button")?.getAttribute("title") ?? "";
		expect(tooltip).toContain("scout · map the repo");
		expect(tooltip).toContain("10m 35s");
		expect(tooltip).toContain("Reading the router");
		expect(tooltip).toContain("claude-x");
		// Paused, not working: its own token.
		expect(row("r2").querySelector('[data-family-status="idle"]')).not.toBeNull();
		expect(row("r1").getAttribute("data-signal")).toBe("running");
		expect(row("r2").getAttribute("data-signal")).toBeNull();
		// Focusable row button in the sidebar's roving list.
		expect(first.querySelector("button")?.getAttribute("data-roving-item")).toBe(`subagent:${TAB}:r1`);
		expect(formatCompactElapsed(12_000)).toBe("12s");
		expect(formatCompactElapsed(635_000)).toBe("10m");
		expect(formatCompactElapsed(2 * 3_600_000 + 60_000)).toBe("2h");
	});

	it("never shows the Title: label of a task, in a subagent row or an opened session's", async () => {
		seed([
			snap({ id: "r1", index: 1, assignment: "Title: 휴대폰 테스트 정리\nRead the tests." }),
			snap({ id: "r2", index: 2, description: "Title: Fix the upload", status: "running" }),
			snap({ id: "r3", index: 3, task: `Title: ${"x".repeat(130)}`, status: "running" }),
		]);
		await mount(<Session />);
		expect(row("r1").textContent).toContain("휴대폰 테스트 정리");
		expect(row("r2").textContent).toContain("Fix the upload");
		for (const id of ["r1", "r2", "r3"]) expect(row(id).textContent).not.toContain("Title:");
		expect(row("r3").querySelector("button")?.getAttribute("title")).not.toContain("Title:");
	});

	it("draws an opened session the same way: worktree or plain glyph, its title, the token and the age", async () => {
		const children = [
			opened({
				key: "/wt/a.jsonl",
				kind: "worktree",
				title: "Check the build",
				state: "running",
				stateLabel: "Running",
				age: "3m",
				tooltip: "Check the build\nRunning\n/wt/a",
			}),
			opened({ key: "/wt/b.jsonl", kind: "session", title: "Review", state: "failed", stateLabel: "Failed" }),
			opened({ key: "/wt/c.jsonl", kind: "session", title: "Idle one", state: null }),
		];
		await mount(<Session kids={children} />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

		const a = openedRow("/wt/a.jsonl");
		expect(a.className).toContain("omp-family-row");
		expect(a.querySelectorAll("button").length).toBe(1);
		expect(a.querySelector('[data-family-glyph="worktree"]')).not.toBeNull();
		expect(a.querySelector('[data-family-status="running"]')).not.toBeNull();
		expect(a.textContent).toContain("Check the build");
		expect(a.textContent).toContain("3m");
		expect(a.textContent).not.toContain("/wt/a");
		expect(a.querySelector("button")?.getAttribute("title")).toContain("/wt/a");
		expect(openedRow("/wt/b.jsonl").querySelector('[data-family-glyph="session"]')).not.toBeNull();
		expect(openedRow("/wt/b.jsonl").querySelector('[data-family-status="failed"]')).not.toBeNull();
		// Merely open: no token at all.
		expect(openedRow("/wt/c.jsonl").querySelector("[data-family-status]")).toBeNull();
	});

	it("an opened session's row opens it, and the selected one reads as current", async () => {
		const onOpen = vi.fn();
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", state: "running", selected: true, onOpen })]} />);
		await click(openedRow("/wt/a.jsonl").querySelector("button"));
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(openedRow("/wt/a.jsonl").querySelector("button")?.getAttribute("aria-current")).toBe("true");
	});

	it("lists subagents, then the opened sessions, then the 'n done' row, in one group", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "d1", index: 2, status: "completed" }),
			snap({ id: "d2", index: 3, status: "completed" }),
		]);
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", title: "Check the build" })]} />);
		expect(document.querySelectorAll("[data-sidebar-family]").length).toBe(1);
		expect(rowIds()).toEqual(["r1"]);
		const text = groupText();
		expect(text.indexOf("Check the build")).toBeGreaterThan(-1);
		expect(text.indexOf("Check the build")).toBeLessThan(
			text.indexOf(translate("sidebar.family.done", { count: 2 })),
		);
	});

	it("nests sub-subagents one more step and keeps the tree connectors", async () => {
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
				<Session />
				<Session sessionKey="/work/alpha/closed.jsonl" tabId="t-closed" />
			</>,
		);
		expect(rowIds()).toEqual(["r1", "c1", "g1", "r2", "c2"]);
		expect(document.querySelectorAll("[data-sidebar-subagents]").length).toBe(1);
		expect([depth("r1"), depth("c1"), depth("g1"), depth("r2"), depth("c2")]).toEqual(["0", "1", "1", "0", "1"]);
		const group = document.querySelector("[data-sidebar-subagents]") as unknown as TestElement;
		expect(group.querySelector('[data-sidebar-subagents-connector="0"]')).not.toBeNull();
		expect(row("c1").parentElement?.querySelector('[data-sidebar-subagents-connector="1"]')).not.toBeNull();
		expect(row("r1").parentElement?.querySelector("[data-sidebar-subagents-connector]")).toBeNull();
	});
});

describe("a session's family: finished subagents", () => {
	it("folds finished ones into 'n done' at the end; failed and waiting ones stay rows", async () => {
		// The main turn is still running: that must not keep finished agents listed.
		act(() => sessionRuntimeStore<SessionStore>(TAB, "session")!.setState({ isStreaming: true }));
		seed([
			snap({ id: "r1", index: 1, status: "failed" }),
			snap({ id: "r2", index: 2, status: "running" }),
			snap({ id: "r3", index: 3, status: "parked" }),
			snap({ id: "r4", index: 4, status: "stale" }),
			snap({ id: "d1", index: 5, status: "completed" }),
			snap({ id: "d2", index: 6, status: "aborted" }),
			snap({ id: "d3", index: 7, status: "cancelled" }),
		]);
		await mount(<Session />);
		expect(rowIds()).toEqual(["r1", "r2", "r3", "r4"]);
		expect(row("r1").querySelector('[data-family-status="failed"]')).not.toBeNull();
		expect(row("r4").querySelector('[data-family-status="waiting"]')).not.toBeNull();
		expect(doneFold()?.textContent).toBe(translate("sidebar.family.done", { count: 3 }));
		expect(doneFold()?.getAttribute("aria-expanded")).toBe("false");

		await click(doneFold());
		expect(rowIds()).toEqual(["r1", "r2", "r3", "r4", "d1", "d2", "d3"]);
		expect(row("d1").querySelector('[data-family-status="done"]')).not.toBeNull();
		expect(doneFold()?.getAttribute("aria-expanded")).toBe("true");
		await click(doneFold());
		expect(rowIds()).toEqual(["r1", "r2", "r3", "r4"]);
	});

	it("keeps the transcript sheet of an opened subagent when it finishes", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		await mount(<Session />);
		await click(row("r1").querySelector("button"));
		expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);

		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl", status: "completed" })]);
		await flush();
		// Folded behind "1 done", the sheet is still open.
		expect(rowIds()).toEqual([]);
		expect(doneFold()).toBeNull();
		expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
	});

	it("promotes a live child to the top level once its parent finishes", async () => {
		seed([
			snap({ id: "p", index: 1, status: "completed" }),
			snap({ id: "c", index: 2, status: "running", parentSubagentId: "p" }),
		]);
		await mount(<Session />);
		expect(rowIds()).toEqual(["c"]);
		expect(depth("c")).toBe("0");
	});
});

describe("a session's family: opening a subagent", () => {
	it("opens the subagent's live transcript against its own tab on click", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
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

	it("drags a row as an omp:subagent-drag and opens it in the side panel from its menu", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		await mount(<Session />);
		const drags: unknown[] = [];
		const listen = (event: globalThis.Event) => drags.push((event as CustomEvent).detail);
		window.addEventListener("omp:subagent-drag", listen);
		try {
			const setDragImage = vi.fn();
			for (const type of ["dragstart", "dragend"]) {
				const event = new Event(type, { bubbles: true, cancelable: true });
				Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
				Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", setDragImage } });
				await act(async () => {
					row("r1").dispatchEvent(event);
				});
			}
		} finally {
			window.removeEventListener("omp:subagent-drag", listen);
		}
		expect(row("r1").getAttribute("draggable")).toBe("true");
		expect(drags).toEqual([{ tabId: TAB, agentId: "r1", label: "map the repo" }, null]);

		await fire(row("r1"), "contextmenu");
		const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
			node => node.textContent === "Open in side panel",
		) as unknown as TestElement | undefined;
		await click(item ?? null);
		const ui = useUiStore.getState();
		expect([ui.panelVisible, ui.panelTab, ui.panelSubagent]).toEqual([
			true,
			"subagent",
			{ tabId: TAB, agentId: "r1" },
		]);
		// The panel's agent reads as the selected row, and no sheet opened.
		expect(row("r1").querySelector("button")?.getAttribute("aria-current")).toBe("true");
		expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
		// Picking the action dismissed the menu.
		expect(document.querySelectorAll('[role="menu"]').length).toBe(0);
	});

	it("the side panel's Subagent view reads the transcript through the owning tab and says when the agent is gone", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		await mount(<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />);
		expect(document.querySelector('[data-panel-subagent="r1"]')?.textContent).toContain("map the repo");
		expect(commandForTab).toHaveBeenCalledWith(
			TAB,
			expect.objectContaining({ type: "get_subagent_messages", subagentId: "r1", sessionFile: "/tmp/r1.jsonl" }),
			expect.any(Number),
		);
		// One-line header with the open/stop/copy icons; the transcript is the main one's editorial list.
		expect(document.querySelector('[data-panel-subagent="r1"] .omp-subagent-header')).not.toBeNull();
		expect(document.querySelector('[data-panel-subagent="r1"] .omp-subagent-conversation')).not.toBeNull();
		// Running: the composer-styled steer box sits under the transcript.
		expect(document.querySelector("[data-subagent-steer] .omp-composer-box")).not.toBeNull();

		seed([]);
		await flush();
		expect(document.querySelector("[data-panel-subagent]")).toBeNull();
		expect(document.body.textContent).toContain(translate("panel.subagent.gone"));
	});

	it("the side panel's Subagent view of an already finished subagent keeps working", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl", status: "completed" })]);
		act(() => useUiStore.getState().openSubagentPanel({ tabId: TAB, agentId: "r1" }));
		await mount(
			<>
				<Session />
				<SubagentPanel subagent={{ tabId: TAB, agentId: "r1" }} />
			</>,
		);
		expect(document.querySelector('[data-panel-subagent="r1"]')?.textContent).toContain("map the repo");
		// Finished: no steer box.
		expect(document.querySelector("[data-subagent-steer]")).toBeNull();
		expect(document.body.textContent).not.toContain(translate("panel.subagent.gone"));
	});
});
