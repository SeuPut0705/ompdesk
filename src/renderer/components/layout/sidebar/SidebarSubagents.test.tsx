/**
 * A session's family in the sidebar: the subagents of a session open in a tab and the sessions its agent opened,
 * one compact line each under the session row. One summary chip on the row (subagents · opened sessions, the running
 * count highlighted, a warning tint while a child waits); the group is folded until the person opens it and never opens
 * or folds by itself, whatever the children do, except that a child waiting for the person shows alone as one row;
 * finished subagents and finished opened sessions are not listed at all; clicking a subagent opens
 * the live transcript against the owning tab; reveal expands the rows and focuses the first one.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useAgentReviewStore } from "../../../stores/agent-review";
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
const { SidebarSubagents, SidebarSubagentsToggle } = await import("./SidebarSubagents");
const { formatTimeAgo } = await import("../../../lib/format");
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

const STATUS_OF_STATE = { running: "running", waiting: "waiting", done: "done", failed: "problem" } as const;

function opened(overrides: Partial<FamilyOpened> & { key: string }): FamilyOpened {
	const state = overrides.state ?? null;
	return {
		kind: "worktree",
		status: state && state in STATUS_OF_STATE ? STATUS_OF_STATE[state as keyof typeof STATUS_OF_STATE] : null,
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
	// Families start folded; most of these tests are about their rows, so the person has opened this one.
	useSidebarSubagentsStore.setState({ expanded: new Set([SESSION]) });
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
	useAgentReviewStore.getState().reset();
	useSidebarSubagentsStore.setState({
		expanded: new Set(),
		hidden: new Set(),
		present: new Set(),
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
			opened({ key: "/wt/c.jsonl", kind: "session", state: "waiting", stateLabel: "Waiting" }),
		];
		await mount(<Session kids={children} />);

		const chip = toggle();
		// The finished subagent and the finished session are not counted.
		// Something runs: the count shows once, as the filled pill with both kind glyphs (the label keeps the totals).
		expect(chip?.querySelector("[data-family-agents]")).toBeNull();
		expect(chip?.querySelector("[data-family-sessions]")).toBeNull();
		expect(chip?.querySelectorAll("[data-family-running] svg").length).toBe(2);
		// r1 and the first opened session run: the running count is the highlighted pill.
		const pill = chip?.querySelector("[data-family-running]");
		expect(pill?.textContent).toBe("2");
		expect(pill?.className).toContain("bg-(--sc-accent)");
		expect(chip?.getAttribute("aria-label")).toBe(
			translate("sidebar.family.hide", {
				summary: [
					translate("sidebar.family.agents", { count: 2 }),
					translate("sidebar.family.sessions", { count: 2 }),
					translate("sidebar.family.running", { count: 2 }),
					translate("sidebar.family.waiting", { count: 1 }),
				].join(", "),
			}),
		);
	});

	it("shows only what exists: no pill with nothing running, nothing at all without a shown child", async () => {
		seed([snap({ id: "r1", status: "parked" })]);
		await mount(<Session />);
		expect(toggle()?.querySelector("[data-family-agents]")?.textContent).toBe("1");
		expect(toggle()?.querySelector("[data-family-sessions]")).toBeNull();
		expect(toggle()?.querySelector("[data-family-running]")).toBeNull();

		// It finished: no child shows, so there is no chip.
		seed([snap({ id: "r1", status: "completed" })]);
		await flush();
		expect(toggle()).toBeNull();

		seed([]);
		await flush();
		expect(toggle()).toBeNull();
	});

	it("shows the opened sessions of a tab that has no runtime yet (a relaunch that woke nothing)", async () => {
		useSidebarSubagentsStore.setState({ expanded: new Set() });
		const children = [opened({ key: "/wt/a.jsonl", title: "Check the build" })];
		await mount(<Session kids={children} sessionKey={SESSION} tabId="t-asleep" />);
		expect(toggle()?.querySelector("[data-family-sessions]")?.textContent).toBe("1");
		await click(toggle());
		expect(openedRow("/wt/a.jsonl").textContent).toContain("Check the build");
	});
});

describe("a session's family: open and closed", () => {
	beforeEach(() => {
		useSidebarSubagentsStore.setState({ expanded: new Set() });
	});

	it("never opens or folds by itself: children starting, running and finishing leave a folded family folded", async () => {
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", state: "idle" })]} />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "r2", index: 2, status: "running" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector("[data-sidebar-family]")).toBeNull();
		// The chip still says two are at work.
		expect(toggle()?.querySelector("[data-family-running]")?.textContent).toBe("2");

		// Every follow-up is a new run: the same child stops, starts, stops, starts again.
		for (const status of ["parked", "running", "parked", "running"] as const) {
			seed([snap({ id: "r1", index: 1, status }), snap({ id: "r2", index: 2, status: "running" })]);
			await flush();
			expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		}

		seed([snap({ id: "r1", index: 1, status: "completed" }), snap({ id: "r2", index: 2, status: "completed" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(toggle()?.querySelector("[data-family-running]")).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.size).toBe(0);
	});

	it("keeps an open family open as its children finish, and drops it with the last one", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "r2", index: 2, status: "running" })]);
		await mount(<Session />);
		await click(toggle());
		expect(rowIds()).toEqual(["r1", "r2"]);

		seed([snap({ id: "r1", index: 1, status: "completed" }), snap({ id: "r2", index: 2, status: "running" })]);
		await flush();
		// The finished one leaves the list, the chip counts what is left, the family stays as the person left it.
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(rowIds()).toEqual(["r2"]);
		expect(doneFold()).toBeNull();
		expect(toggle()?.querySelector("[data-family-agents]")).toBeNull();
		expect(toggle()?.querySelector("[data-family-running]")).not.toBeNull();

		// Nothing left to show: no chip, no group, and the remembered open state is dropped.
		seed([snap({ id: "r1", index: 1, status: "completed" }), snap({ id: "r2", index: 2, status: "completed" })]);
		await flush();
		expect(toggle()).toBeNull();
		expect(document.querySelector("[data-sidebar-family]")).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.size).toBe(0);
	});

	it("tints the chip and surfaces only the child that waits, leaving the rest folded", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "w1", index: 2, status: "stale" }),
			snap({ id: "r2", index: 3, status: "running" }),
			snap({ id: "d1", index: 4, status: "completed" }),
		]);
		await mount(<Session />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(toggle()?.getAttribute("data-family-waiting")).toBe("1");
		expect(toggle()?.className).toContain("text-(--sc-warning)");
		expect(toggle()?.getAttribute("aria-label")).toContain(translate("sidebar.family.waiting", { count: 1 }));
		// One row under the folded parent: no running sibling, no finished one, not the expanded group.
		expect(rowIds()).toEqual(["w1"]);
		expect(document.querySelector("[data-sidebar-surfaced]")).not.toBeNull();
		expect(document.querySelector("[data-sidebar-subagents]")).toBeNull();
		expect(doneFold()).toBeNull();
		expect(row("w1").querySelector('[data-family-status="waiting"]')).not.toBeNull();

		// It answered: the row leaves, nothing else moved, the chip is calm again.
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "w1", index: 2, status: "running" }),
			snap({ id: "r2", index: 3, status: "running" }),
		]);
		await flush();
		expect(rowIds()).toEqual([]);
		expect(toggle()?.getAttribute("data-family-waiting")).toBeNull();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
	});

	it("surfaces a waiting opened session alone, like a waiting subagent", async () => {
		const children = [
			opened({ key: "/wt/a.jsonl", state: "waiting", stateLabel: "Needs approval" }),
			opened({ key: "/wt/b.jsonl", state: "running" }),
		];
		await mount(<Session kids={children} />);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(openedRow("/wt/a.jsonl").querySelector('[data-family-status="waiting"]')).not.toBeNull();
		expect(document.querySelector('[data-session-path="/wt/b.jsonl"]')).toBeNull();
	});

	it("opening the family shows everything, and the person's own toggle is remembered per session", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "w1", index: 2, status: "stale" })]);
		await mount(
			<>
				<Session />
				<Session sessionKey="/work/alpha/other.jsonl" tabId="t-asleep" />
			</>,
		);
		expect(rowIds()).toEqual(["w1"]);

		await click(toggle());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(rowIds()).toEqual(["r1", "w1"]);
		// Progress frames and a status change leave the choice alone.
		seed([
			snap({ id: "r1", index: 1, status: "running", lastUpdate: Date.now() + 1000 }),
			snap({ id: "w1", index: 2 }),
		]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		// The other session has nothing: untouched.
		expect(useSidebarSubagentsStore.getState().expanded.has("/work/alpha/other.jsonl")).toBe(false);

		await click(toggle());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(rowIds()).toEqual([]);
		seed([snap({ id: "r1", index: 1, status: "running" }), snap({ id: "w1", index: 2, status: "stale" })]);
		await flush();
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		expect(rowIds()).toEqual(["w1"]);
	});

	it("the chip's menu expands, collapses, hides and shows groups", async () => {
		seed([snap({ id: "r1", index: 1, status: "parked", progress: { tokens: 128_400, toolCount: 48 } as never })]);
		await mount(<Session />);
		const pick = async (label: string) => {
			await fire(toggle(), "contextmenu");
			const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
				node => node.textContent === label,
			) as unknown as TestElement | undefined;
			await click(item ?? null);
		};
		await pick("Expand all");
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
		// Families start folded and stay so while the agents run.
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
		// A child is a plain row with a still dot: no sweep, no pulse; only a top-level session's title sweeps.
		expect(first.querySelector("[data-working]")).toBeNull();
		expect(first.querySelector('[data-family-status="running"] .omp-pulse-dot')).toBeNull();
		expect(row("r2").querySelector("[data-working]")).toBeNull();
		// Focusable row button in the sidebar's roving list.
		expect(first.querySelector("button")?.getAttribute("data-roving-item")).toBe(`subagent:${TAB}:r1`);
		// One age format across the sidebar: the session rows' own formatter.
		expect(formatTimeAgo(new Date(Date.now() - 635_000).toISOString())).toBe("10m");
	});

	it("collapses the chip to its running-count pill when the sidebar is narrow; the tooltip keeps the summary", async () => {
		seed([snap({ id: "r1", index: 1, status: "running" })]);
		const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
			this: HTMLElement,
		) {
			const width = this.className?.includes?.("omp-session-sidebar") ? 248 : 0;
			return { width } as DOMRect;
		});
		try {
			await mount(
				<div className="omp-session-sidebar">
					<Session kids={[opened({ key: "/wt/a.jsonl", state: "running" })]} />
				</div>,
			);
			const chip = toggle();
			expect(chip?.getAttribute("data-family-compact")).toBe("true");
			expect(chip?.querySelector("[data-family-agents]")).toBeNull();
			expect(chip?.querySelector("[data-family-sessions]")).toBeNull();
			expect(chip?.querySelector("[data-family-running]")?.textContent).toBe("2");
			expect(chip?.getAttribute("title")).toContain(translate("sidebar.family.agents", { count: 1 }));
			expect(chip?.getAttribute("aria-label")).toContain(translate("sidebar.family.sessions", { count: 1 }));
		} finally {
			rect.mockRestore();
		}
	});

	it("shows no money on the chip or a child's tooltip, whatever the family spent (the work board and Work tree do)", async () => {
		useAgentReviewStore.setState({ usage: { [SESSION]: { cost: 1 } } });
		const progress = (cost: number) => ({ cost, modelRole: "task", resolvedModel: "anthropic/claude-x" });
		seed([snap({ id: "r1", index: 1, status: "running", progress: progress(0.1) as SubagentSnapshot["progress"] })]);
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", state: "running" })]} />);
		const chip = toggle();
		expect(chip?.textContent).not.toContain("$");
		expect(chip?.getAttribute("aria-label")).not.toContain("$");
		// The family is open (beforeEach): the tooltip keeps what the child runs on, never what it cost.
		const title = row("r1").querySelector("button")?.getAttribute("title") ?? "";
		expect(title).toContain("anthropic/claude-x · @task");
		expect(title).not.toContain("$");
	});

	it("keeps the whole chip at a width with room, and with nothing running", async () => {
		seed([snap({ id: "r1", index: 1, status: "parked" })]);
		const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
			this: HTMLElement,
		) {
			return { width: this.className?.includes?.("omp-session-sidebar") ? 248 : 0 } as DOMRect;
		});
		try {
			await mount(
				<div className="omp-session-sidebar">
					<Session />
				</div>,
			);
			expect(toggle()?.getAttribute("data-family-compact")).toBeNull();
			expect(toggle()?.querySelector("[data-family-agents]")?.textContent).toBe("1");
		} finally {
			rect.mockRestore();
		}
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

	it("lists subagents, then the opened sessions, in one group, without finished ones", async () => {
		seed([
			snap({ id: "r1", index: 1, status: "running" }),
			snap({ id: "d1", index: 2, status: "completed" }),
			snap({ id: "d2", index: 3, status: "completed" }),
		]);
		await mount(<Session kids={[opened({ key: "/wt/a.jsonl", title: "Check the build" })]} />);
		expect(document.querySelectorAll("[data-sidebar-family]").length).toBe(1);
		expect(rowIds()).toEqual(["r1"]);
		expect(groupText()).toContain("Check the build");
		expect(doneFold()).toBeNull();
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
	it("lists no finished subagent; failed, stale, running and parked ones stay rows", async () => {
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
		expect(doneFold()).toBeNull();
		// The chip counts the four that show, not the three finished ones.
		expect(toggle()?.querySelector("[data-family-agents]")).toBeNull();
		expect(toggle()?.querySelector("[data-family-running]")).not.toBeNull();
	});

	it("lists no finished opened session; running, waiting, problem and not-yet-run ones stay rows", async () => {
		seed([snap({ id: "d1", index: 1, status: "completed" }), snap({ id: "r1", index: 2, status: "running" })]);
		const children = [
			opened({ key: "/wt/run.jsonl", title: "Running one", state: "running" }),
			opened({ key: "/wt/wait.jsonl", title: "Waiting one", state: "waiting" }),
			opened({ key: "/wt/bad.jsonl", title: "Problem one", state: "failed" }),
			opened({ key: "/wt/done1.jsonl", title: "Done one", state: "done" }),
			opened({ key: "/wt/done2.jsonl", kind: "session", title: "Done two", state: "done" }),
			opened({ key: "/wt/idle.jsonl", title: "Not started", state: null }),
		];
		await mount(<Session kids={children} />);
		const visible = () =>
			Array.from(document.querySelectorAll("[data-sidebar-opened-session]")).map(element =>
				element.getAttribute("data-session-path"),
			);
		expect(visible()).toEqual(["/wt/run.jsonl", "/wt/wait.jsonl", "/wt/bad.jsonl", "/wt/idle.jsonl"]);
		expect(openedRow("/wt/bad.jsonl").querySelector('[data-family-status="failed"]')).not.toBeNull();
		expect(rowIds()).toEqual(["r1"]);
		expect(doneFold()).toBeNull();
		expect(groupText()).not.toContain("Done one");
		// The chip counts only what shows: one subagent, four sessions.
		// Something runs: the count shows once, as the running pill.
		expect(toggle()?.querySelector("[data-family-agents]")).toBeNull();
		expect(toggle()?.querySelector("[data-family-running]")).not.toBeNull();
		expect(toggle()?.querySelector("[data-family-sessions]")).toBeNull();
	});

	it("shows no chip and no group when every child finished", async () => {
		seed([snap({ id: "d1", index: 1, status: "completed" })]);
		await mount(
			<Session
				kids={[
					opened({ key: "/wt/done1.jsonl", state: "done" }),
					opened({ key: "/wt/done2.jsonl", state: "done" }),
				]}
			/>,
		);
		expect(toggle()).toBeNull();
		expect(document.querySelector("[data-sidebar-family]")).toBeNull();
		expect(doneFold()).toBeNull();
	});

	it("keeps the transcript sheet of an opened subagent when it finishes", async () => {
		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl" })]);
		await mount(<Session />);
		await click(row("r1").querySelector("button"));
		expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);

		seed([snap({ id: "r1", description: "map the repo", sessionFile: "/tmp/r1.jsonl", status: "completed" })]);
		await flush();
		// A finished subagent is not listed at all (no "n done" row either); the sheet is still open.
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
