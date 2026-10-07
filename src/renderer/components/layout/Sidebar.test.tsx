/**
 * Sidebar integration contracts: sessions-first layout (project switcher,
 * New session, filter, sessions by project, Agents/Insights/Settings + help
 * footer), Code/Work lanes, first-class global chats, project group context
 * menu (5 items), session row context menu (6 items), pinned-first ordering,
 * per-session busy gates, status as icon + text, and tab-first opening (an
 * untouched empty tab is replaced instead of left behind).
 * Same linkedom + react-dom harness as TabBar.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useSidebarRecency } from "../../hooks/use-sidebar-recency";
import { I18nProvider, translate } from "../../lib/i18n";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import type { SubagentsStore } from "../../stores/subagents";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Sidebar } from "./Sidebar";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(HTMLElement.prototype as unknown as { select: () => void }).select = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

interface MockOmp {
	sidecar: {
		defaultWorkspace: Mock<() => Promise<string>>;
		selectProject: Mock<() => Promise<string | null>>;
		setProject: Mock<(cwd: string) => Promise<boolean>>;
	};
	sessions: {
		list: Mock<(scope: string) => Promise<SessionInfo[]>>;
		delete: Mock<(path: string) => Promise<void>>;
		rename: Mock<(path: string, name: string) => Promise<void>>;
		search: Mock<(query: string, scope: string) => Promise<string[]>>;
		openInNewWindow: Mock<(payload: { sessionPath?: string }) => Promise<boolean>>;
	};
	events: {
		onSessionsChanged: Mock<() => () => void>;
		onTabStatus: Mock<() => () => void>;
		onMenuAction: Mock<() => () => void>;
	};
	tabs: {
		list: Mock<() => Promise<unknown[]>>;
		spawn: Mock<(payload: unknown) => Promise<{ tabId: string; cwd?: string } | null>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		getSessionOwner: Mock<(path: string) => Promise<null>>;
	};
	prefs: {
		get: Mock<(key: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
	system: {
		showOpenDialog: Mock<(filters?: unknown, options?: unknown) => Promise<string[] | null>>;
	};
	rpc: Record<string, Mock<(...args: unknown[]) => Promise<unknown>>>;
}

function installMockOmp(sessionList: SessionInfo[]): MockOmp {
	const omp: MockOmp = {
		sidecar: {
			defaultWorkspace: vi.fn(async () => "/default/work"),
			selectProject: vi.fn(async () => null),
			setProject: vi.fn(async () => true),
		},
		sessions: {
			list: vi.fn(async () => sessionList),
			delete: vi.fn(async () => {}),
			rename: vi.fn(async () => {}),
			search: vi.fn(async () => []),
			openInNewWindow: vi.fn(async () => true),
		},
		events: {
			onSessionsChanged: vi.fn(() => () => {}),
			onTabStatus: vi.fn(() => () => {}),
			onMenuAction: vi.fn(() => () => {}),
		},
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async payload => ({
				tabId: "t-new",
				...((payload as { defaultWorkspace?: boolean }).defaultWorkspace ? { cwd: "/default/work" } : {}),
			})),
			setActive: vi.fn(async () => true),
			close: vi.fn(async () => true),
			getSessionOwner: vi.fn(async () => null),
		},
		prefs: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
		},
		system: {
			showOpenDialog: vi.fn(async () => null),
		},
		rpc: new Proxy({} as MockOmp["rpc"], {
			get: (target, prop) => {
				if (!(prop in target)) {
					(target as Record<string | symbol, unknown>)[prop] = vi.fn(async () => ({
						type: "response",
						command: "mock",
						success: true,
						data: {},
					}));
				}
				return (target as Record<string | symbol, unknown>)[prop];
			},
		}),
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

function session(path: string, cwd: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: path,
		title: `Session ${path}`,
		cwd,
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 3,
		size: 100,
		status: "complete",
		firstMessage: "hello",
		...overrides,
	};
}

let container: TestElement;
let root: Root;

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

/** Drive a React onClick/onContextMenu prop on an element. */
async function fire(element: Element | TestElement | null, prop: "onClick" | "onContextMenu"): Promise<void> {
	if (!element) throw new Error("fire: element is null");
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as Record<string, (event: unknown) => void> | undefined) : undefined;
	const handler = props?.[prop];
	if (!handler) throw new Error(`fire: ${prop} not found on element`);
	await act(async () =>
		handler({
			stopPropagation: () => {},
			preventDefault: () => {},
			clientX: 20,
			clientY: 30,
			currentTarget: element,
		}),
	);
	await flush();
}

function menuItemLabels(): string[] {
	return [...document.body.querySelectorAll('[role="menu"] button')].map(b => (b.textContent ?? "").trim());
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useComposerStore.getState().reset();
	useMessagesStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSidebarPrefs.getState().reset();
	useUiStore.setState({
		panelVisible: false,
		sessionPickerOpen: false,
		commandPaletteOpen: false,
		destination: "session",
	});
});

const LIST = [
	session("/work/alpha/one.jsonl", "/work/alpha", { modified: "2026-01-02T00:00:00Z" }),
	session("/work/alpha/two.jsonl", "/work/alpha", { modified: "2026-01-01T00:00:00Z" }),
	session("/work/beta/three.jsonl", "/work/beta", { modified: "2026-01-03T00:00:00Z" }),
];

function seedStores(): void {
	useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function SidebarWithRecency() {
	useSidebarRecency();
	return <Sidebar />;
}

/** The row element (ListRow root) whose title contains `text`. */
function rowFor(text: string): Element {
	const row = [...document.querySelectorAll(".omp-sidebar-session-row")].find(element =>
		(element.textContent ?? "").includes(text),
	);
	if (!row) throw new Error(`row not found: ${text}`);
	return row;
}

/** The row's main button (the click target that opens the session). */
function rowButton(text: string): Element {
	return rowFor(text).querySelector("button") as Element;
}

function groupToggle(cwd: string): Element {
	return container.querySelector(`[data-workspace-group="${cwd}"] button[aria-expanded]`) as unknown as Element;
}

describe("Sidebar menus and pinned ordering", () => {
	it("ends with the three destinations and a help menu instead of a utility list", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		expect(container.querySelector("[data-sidebar-navigation]")).toBeNull();
		const footer = container.querySelector("[data-sidebar-destinations]");
		const destinations = [...(footer?.querySelectorAll("button[data-destination]") ?? [])].map(button =>
			(button.textContent ?? "").trim(),
		);
		expect(destinations.map(label => label.replace(/[⌥⌘,A]+$/, ""))).toEqual(["Agents", "Stats", "Settings"]);
		expect(footer?.textContent).toContain("⌥A");
		expect(footer?.textContent).toContain("⌘,");

		await fire(footer?.querySelector('[data-destination="insights"]') ?? null, "onClick");
		expect(useUiStore.getState().destination).toBe("insights");
		expect(footer?.querySelector('[data-destination="insights"]')?.getAttribute("aria-current")).toBe("page");
		await fire(footer?.querySelector('[data-destination="settings"]') ?? null, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "general" });
		await fire(footer?.querySelector('[data-destination="agents"]') ?? null, "onClick");
		expect(useUiStore.getState().destination).toBe("agents");

		// Help: shortcuts, palette, features, feedback, what's new, about.
		await fire(footer?.querySelector('[aria-label="Help"]') ?? null, "onClick");
		expect(menuItemLabels().map(label => label.replace(/⌘.*$/, ""))).toEqual([
			"Keyboard shortcuts",
			"Command palette",
			"What ompdesk adds",
			"What's new",
			"Send feedback",
			"About ompdesk",
		]);
		const shortcuts = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Keyboard shortcuts"),
		);
		await fire(shortcuts as Element, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "keyboard" });
	});

	it("opens the command palette from the header and selecting a session returns from a page", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		await fire(container.querySelector('button[data-command-center-entry="true"]'), "onClick");
		expect(useUiStore.getState().commandPaletteOpen).toBe(true);

		await act(async () => useUiStore.getState().openInsights("usage"));
		await fire(rowButton("Session /work/alpha/one"), "onClick");
		expect(useUiStore.getState().destination).toBe("session");
		expect(omp.tabs.spawn).toHaveBeenCalled();
	});

	it("filters the session list inline by title or project", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const field = container.querySelector('input[aria-label="Filter sessions"]') as unknown as Element;
		const record = field as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = record[propsKey as string] as { onChange: (event: { target: { value: string } }) => void };
		await act(async () => props.onChange({ target: { value: "three" } }));
		await flush();

		// The match lives in a collapsed (non-current) project: a filter shows it anyway.
		const rows = [...document.querySelectorAll(".omp-sidebar-session-row")].map(row => row.textContent ?? "");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Session /work/beta/three");

		await act(async () => props.onChange({ target: { value: "nothing-matches" } }));
		await flush();
		expect(container.textContent).toContain("No matching sessions");
	});

	it("replaces an untouched empty tab instead of opening a second one", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "empty", cwd: "/work/alpha", isStreaming: false, messageCount: 0 });
		useTabsStore.setState({
			tabs: [{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		await fire(rowButton("Session /work/alpha/one"), "onClick");
		await flush();
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/work/alpha/one.jsonl");
	});

	it("moves the most recently used session and its workspace to the front immediately", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "", cwd: "/neutral", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/neutral", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<SidebarWithRecency />);
		// A chat tab opens the Chat lane; projects live in Code.
		await fire(container.querySelector('[role="tablist"] [data-tab-id="code"]'), "onClick");
		// Non-active workspaces start collapsed and render no rows; expand alpha
		// so its session order is inspectable.
		await fire(groupToggle("/work/alpha"), "onClick");

		const workspaceOrder = () =>
			[...container.querySelectorAll("[data-workspace-group]")].map(element =>
				(element as unknown as Element).getAttribute("data-workspace-group"),
			);
		const alphaSessionOrder = () =>
			[...container.querySelectorAll('[data-session-group="/work/alpha"] .omp-sidebar-session-row')].map(
				element => element.textContent ?? "",
			);

		expect(workspaceOrder()).toEqual(["/work/beta", "/work/alpha"]);
		expect(alphaSessionOrder()[0]).toContain("Session /work/alpha/one");

		await act(async () => {
			useTabsStore.setState({
				tabs: [{ id: "agent", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
				activeTabId: "agent",
			});
			useSessionStore.setState({
				sessionId: "/work/alpha/two.jsonl",
				sessionFile: "/work/alpha/two.jsonl",
				cwd: "/work/alpha",
			});
		});
		await flush();

		expect(workspaceOrder()).toEqual(["/work/alpha", "/work/beta"]);
		expect(alphaSessionOrder()[0]).toContain("Session /work/alpha/two");
		expect(useSidebarPrefs.getState().sessionLastUsed["/work/alpha/two.jsonl"]).toBeGreaterThan(0);
		expect(useSidebarPrefs.getState().workspaceLastUsed["/work/alpha"]).toBeGreaterThan(0);
		expect(omp.prefs.set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({
				sessionLastUsed: expect.objectContaining({ "/work/alpha/two.jsonl": expect.any(Number) }),
			}),
		);
	});

	it("an active chat opens the Chat lane, whose New button starts a chat; Code starts agents", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "chat", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/work/alpha", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		const modeTab = (id: string) => container.querySelector(`[role="tablist"] [data-tab-id="${id}"]`);
		expect(modeTab("chat")?.getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector("[data-sidebar-open-project]")).toBeNull();
		await fire(container.querySelector("[data-sidebar-new-agent]"), "onClick");
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "chat", sessionPath: undefined }),
		);

		await fire(modeTab("code"), "onClick");
		expect(modeTab("code")?.getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector("[data-sidebar-open-project]")).not.toBeNull();
	});

	it("creates an agent tab from New session even when the active tab is chat", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "chat", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/work/alpha", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		await fire(container.querySelector('[role="tablist"] [data-tab-id="code"]'), "onClick");
		await fire(container.querySelector("[data-sidebar-new-agent]"), "onClick");
		const currentWorkspace = [...document.body.querySelectorAll('[role="dialog"] button')].find(button =>
			(button.textContent ?? "").includes("/work/alpha"),
		);
		await fire(currentWorkspace as Element, "onClick");

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "agent",
			sessionPath: undefined,
			worktree: undefined,
		});
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
	});

	it("shows status as an icon plus text only when there is something to say", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const rows = [...document.querySelectorAll(".omp-sidebar-session-row")];
		const indexedRows = rows.filter(row => row.getAttribute("data-live") === null);
		expect(indexedRows.length).toBeGreaterThan(0);
		// Completed sessions carry a relative time, no colored bar and no status noise.
		expect(rows.every(row => row.querySelector(".omp-signal-light") === null)).toBe(true);
		expect(indexedRows.every(row => row.querySelector("time") !== null)).toBe(true);
		expect(rows.every(row => !(row.textContent ?? "").includes("Running"))).toBe(true);
	});

	it("keeps the current session and every open tab's session listed before the index has them", async () => {
		installMockOmp(LIST);
		useSessionStore.setState({
			sessionId: "fresh-id",
			sessionName: "Audit session",
			cwd: "/work/gamma",
			isStreaming: false,
		});
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/gamma", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "t1",
					cwd: "/work/beta",
					status: "running",
					kind: "agent",
					sessionId: "bg-id",
					sessionPath: "/work/beta/bg.jsonl",
					title: "Background run",
					unreadDone: false,
				},
				{ id: "t2", cwd: "/work/delta", status: "ready", kind: "agent", title: "Finished run", unreadDone: true },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		expect(container.textContent).not.toContain("No code sessions yet");
		const current = rowFor("Audit session");
		expect(current.getAttribute("data-active")).toBe("true");
		expect(current.getAttribute("data-live")).toBe("true");
		// No transcript on disk yet: nothing to rename or delete.
		expect(current.querySelector('[aria-label="Delete session"]')).toBeNull();

		// Open tabs in other projects keep their project expanded and say what they're doing.
		expect(rowFor("Background run").textContent).toContain("Running");
		expect(container.querySelector('[data-session-group="/work/beta"]')?.textContent).toContain(
			"Session /work/beta/three",
		);
		const finished = rowFor("Finished run");
		expect(finished.querySelector("[data-sidebar-done]")).not.toBeNull();
		expect(finished.textContent).toContain("Run completed");

		// Live-only rows navigate; file actions stay out of their menu.
		await fire(current, "onContextMenu");
		const labels = menuItemLabels();
		expect(labels[0]).toContain("Open");
		for (const fileAction of ["Open in new window", "Rename", "Pin to top", "Delete"]) {
			expect(labels.some(label => label.includes(fileAction))).toBe(false);
		}
	});

	it("offers a way out of an empty filter and keeps help in the footer's last row", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const field = container.querySelector('input[aria-label="Filter sessions"]') as unknown as Element;
		const record = field as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = record[propsKey as string] as { onChange: (event: { target: { value: string } }) => void };
		await act(async () => props.onChange({ target: { value: "nothing-matches" } }));
		await flush();
		const clear = [...container.querySelectorAll("button")].find(
			button => (button.textContent ?? "").trim() === "Clear filter",
		);
		await fire(clear as unknown as Element, "onClick");
		expect(document.querySelectorAll(".omp-sidebar-session-row").length).toBeGreaterThan(0);

		const settings = container.querySelector('[data-sidebar-destinations] [data-destination="settings"]');
		const settingsRow = (settings as unknown as Element | null)?.parentNode
			?.parentNode as unknown as TestElement | null;
		expect(settingsRow?.querySelector('[aria-label="Help"]')).not.toBeNull();
	});

	it("uses the open tab's live status instead of the session file's stale completion status", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id", status: "complete" });
		installMockOmp([attached]);
		seedStores();
		useTabsStore.setState({
			tabs: [
				{
					id: "t0",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					sessionId: "attached-id",
					unreadDone: false,
				},
			],
		});
		await mount(<Sidebar />);

		const activeRow = () => container.querySelector('[data-active="true"]') as unknown as Element;
		expect(activeRow().textContent).not.toContain("Running");

		await act(async () => {
			useTabsStore.setState({ tabs: [{ ...useTabsStore.getState().tabs[0]!, status: "running" }] });
		});
		expect(activeRow().textContent).toContain("Running");
		expect(activeRow().querySelector('[aria-label="Delete session"]')).toBeNull();
	});

	it("aligns workspace and session titles with folder, chat, and reserved icon slots", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		expect(container.querySelectorAll("[data-sidebar-workspace-icon]").length).toBeGreaterThan(0);
		const chatRow = container.querySelector('[data-session-kind="chat"]');
		const groupedAgentRow = container.querySelector('[data-session-group="/work/alpha"] [data-session-kind="agent"]');
		expect(chatRow?.querySelector("svg[data-sidebar-session-icon]")).not.toBeNull();
		expect(groupedAgentRow?.querySelector("span[data-sidebar-session-icon]")).not.toBeNull();
	});

	it("right-click on a workspace header opens the agent-only group menu with move actions", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/alpha"]');
		expect(header).not.toBeUndefined();
		await fire(header as unknown as TestElement, "onContextMenu");

		const labels = menuItemLabels();
		expect(labels.some(label => label.includes("New agent session here"))).toBe(true);
		expect(labels.some(label => label.includes("New chat session here"))).toBe(false);
		expect(labels.some(label => label.includes("New worktree tab here"))).toBe(true);
		expect(labels.some(label => label.includes("Rename"))).toBe(true);
		expect(labels.some(label => label.includes("Move up"))).toBe(true);
		expect(labels.some(label => label.includes("Move down"))).toBe(true);
		expect(labels.some(label => label.includes("Pin to top"))).toBe(true);
		expect(labels.some(label => label.includes("Delete"))).toBe(true);
		expect(labels).toHaveLength(7);
	});

	it("each project header offers + in place of a count, and Move moves the project", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<Sidebar />);

		const order = () =>
			[...container.querySelectorAll("[data-workspace-group]")].map(element =>
				(element as unknown as Element).getAttribute("data-workspace-group"),
			);
		const header = container.querySelector('[data-workspace-group="/work/beta"]');
		expect(header?.textContent ?? "").not.toMatch(/\d/);
		await fire(container.querySelector('[data-sidebar-group-new="/work/beta"]'), "onClick");
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/work/beta", kind: "agent" }));

		const first = order()[0] ?? "";
		const second = order()[1] ?? "";
		await fire(container.querySelector(`[data-workspace-group="${second}"]`), "onContextMenu");
		const moveUp = [...document.body.querySelectorAll('[role="menuitem"]')].find(item =>
			(item.textContent ?? "").includes("Move up"),
		);
		await fire(moveUp as unknown as Element, "onClick");
		expect(order().slice(0, 2)).toEqual([second, first]);
		expect(useSidebarPrefs.getState().groupOrder.slice(0, 2)).toEqual([second, first]);
		expect(omp.prefs.set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ groupOrder: expect.any(Array) }));
	});

	it("right-click on a session row opens the 6-item session menu", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");

		const labels = menuItemLabels();
		for (const expected of ["Open", "Open in new tab", "Open in new window", "Rename", "Pin to top", "Delete"]) {
			expect(
				labels.some(label => label.includes(expected)),
				`missing item: ${expected}`,
			).toBe(true);
		}
		expect(labels).toHaveLength(6);

		const pinItem = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Pin to top"),
		);
		await fire(pinItem as Element, "onClick");
		expect(omp.rpc.setSessionPinned).toHaveBeenCalledWith("/work/alpha/one.jsonl", true);
	});

	it("rename and delete stay enabled for idle tasks while another task runs", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		const omp = installMockOmp([attached, ...LIST]);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		// The attached running task stays protected.
		await fire(rowFor("Session /work/alpha/mine"), "onContextMenu");
		const renameItem = [...document.body.querySelectorAll('[role="menu"] button')].find(b =>
			(b.textContent ?? "").includes("Rename"),
		);
		expect((renameItem as HTMLButtonElement | undefined)?.disabled).toBe(true);
		await fire(document.body.querySelector('[role="menu"] button') as Element, "onClick");

		// An idle sibling remains editable and deletable despite the active run.
		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		const foreignMenu = [...document.body.querySelectorAll('[role="menu"] button')];
		const idleRename = foreignMenu.find(b => (b.textContent ?? "").includes("Rename"));
		const idleDelete = foreignMenu.find(b => (b.textContent ?? "").includes("Delete"));
		expect((idleRename as HTMLButtonElement | undefined)?.disabled).toBe(false);
		expect((idleDelete as HTMLButtonElement | undefined)?.disabled).toBe(false);
		await fire(idleRename as Element, "onClick");
		const input = container.querySelector(
			'input[value="Session /work/alpha/one.jsonl"]',
		) as unknown as HTMLInputElement;
		expect(input).not.toBeNull();
		const inputRecord = input as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(inputRecord).find(key => key.startsWith("__reactProps$"));
		const inputProps = propsKey
			? (inputRecord[propsKey] as {
					onChange: (event: { target: { value: string } }) => void;
					onBlur: (event: { currentTarget: { value: string } }) => void;
				})
			: undefined;
		if (!inputProps) throw new Error("rename input React props missing");
		await act(async () => {
			inputProps.onChange({ target: { value: "Renamed idle task" } });
		});
		await act(async () => {
			inputProps.onBlur({ currentTarget: { value: "Renamed idle task" } });
		});
		await flush();
		expect(omp.sessions.rename).toHaveBeenCalledWith("/work/alpha/one.jsonl", "Renamed idle task");
	});

	it("clicking an idle task opens it in a new tab by default", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		await fire(rowButton("Session /work/alpha/one"), "onClick");

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "agent",
			sessionPath: "/work/alpha/one.jsonl",
			worktree: undefined,
		});
		expect(omp.sessions.openInNewWindow).not.toHaveBeenCalled();
	});

	it("the folder button next to New session starts in a picked or newly created project folder", async () => {
		const omp = installMockOmp([]);
		seedStores();
		await mount(<Sidebar />);

		// Cancelled picker: nothing moves.
		await fire(container.querySelector("[data-sidebar-open-project]"), "onClick");
		expect(omp.system.showOpenDialog).toHaveBeenLastCalledWith(
			undefined,
			expect.objectContaining({ directory: true, buttonLabel: translate("sidebar.project.newFolderButton") }),
		);
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
		expect(omp.tabs.spawn).not.toHaveBeenCalled();

		omp.system.showOpenDialog.mockResolvedValueOnce(["/work/new-app"]);
		await fire(container.querySelector("[data-sidebar-open-project]"), "onClick");
		await act(async () => {});
		const spawnedCwds = omp.tabs.spawn.mock.calls.map(([payload]) =>
			payload && typeof payload === "object" && "cwd" in payload ? payload.cwd : undefined,
		);
		expect([...omp.sidecar.setProject.mock.calls.map(([cwd]) => cwd), ...spawnedCwds]).toEqual(["/work/new-app"]);
	});

	it("chats live in the Chat lane, not under their project", async () => {
		const chat = session("/work/alpha/chat.jsonl", "/work/alpha", { kind: "chat" });
		const agent = session("/work/alpha/agent.jsonl", "/work/alpha");
		const omp = installMockOmp([chat, agent]);
		seedStores();
		await mount(<Sidebar />);

		const workspace = container.querySelector('[data-session-group="/work/alpha"]');
		expect(workspace?.textContent).toContain("Session /work/alpha/agent");
		expect(workspace?.textContent).not.toContain("Session /work/alpha/chat");
		expect(container.querySelector("[data-chat-lane]")).toBeNull();

		await fire(container.querySelector('[role="tablist"] [data-tab-id="chat"]'), "onClick");
		const lane = container.querySelector("[data-chat-lane]");
		expect(lane?.textContent).toContain("Session /work/alpha/chat");
		expect(lane?.textContent).not.toContain("Session /work/alpha/agent");
		const chatRow = [...lane!.querySelectorAll(".omp-sidebar-session-row")].find(element =>
			(element.textContent ?? "").includes("Session /work/alpha/chat"),
		);
		await fire(chatRow?.querySelector("button") as unknown as Element, "onClick");
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith({
			cwd: "/work/alpha",
			kind: "chat",
			sessionPath: "/work/alpha/chat.jsonl",
			worktree: undefined,
		});
	});

	it("sessions started without a project share the Chat lane with chats", async () => {
		const chat = session("/elsewhere/chat.jsonl", "/elsewhere", { kind: "chat" });
		const noProject = session("/default/work/agent.jsonl", "/default/work");
		installMockOmp([chat, noProject]);
		useSessionStore.setState({ sessionId: noProject.id, cwd: "/default/work", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "agent", cwd: "/default/work", status: "ready", kind: "agent", unreadDone: false }],
			activeTabId: "agent",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		expect(container.querySelector('[role="tablist"] [data-tab-id="chat"]')?.getAttribute("aria-selected")).toBe(
			"true",
		);
		const lane = container.querySelector("[data-chat-lane]");
		expect(lane?.textContent).toContain("Session /elsewhere/chat");
		expect(lane?.textContent).toContain("Session /default/work/agent");
		expect(container.querySelector('[data-workspace-group="/default/work"]')).toBeNull();
	});

	it("keeps the active task protected while it is compacting", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		installMockOmp([attached]);
		seedStores();
		useSessionStore.setState({ isCompacting: true });
		await mount(<Sidebar />);

		await fire(rowFor("Session /work/alpha/mine"), "onContextMenu");
		const items = [...document.body.querySelectorAll('[role="menu"] button')];
		expect((items.find(item => (item.textContent ?? "").includes("Rename")) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((items.find(item => (item.textContent ?? "").includes("Delete")) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("workspace rows expose a hover action that creates an agent tab in that workspace", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/alpha"]') as unknown as Element;
		const add = header.querySelector('[aria-label="New agent session here"]');
		expect(add).not.toBeNull();
		await fire(add, "onClick");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "agent",
			sessionPath: undefined,
			worktree: undefined,
		});
	});

	it("renders collapsed groups as absent from the DOM instead of inert subtrees", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const alphaHeader = groupToggle("/work/alpha");
		// Active workspace expanded; other groups render nothing at all — a
		// long-lived install must not build hundreds of hidden rows per refresh.
		const alphaContent = () =>
			container.querySelector('[data-session-group="/work/alpha"]') as unknown as Element | null;
		expect(alphaContent()?.getAttribute("data-state")).toBe("expanded");
		expect(container.querySelector('[data-session-group="/work/beta"]')).toBeNull();

		await fire(alphaHeader as unknown as TestElement, "onClick");
		expect(alphaContent()).toBeNull();

		await fire(alphaHeader as unknown as TestElement, "onClick");
		expect(alphaContent()?.getAttribute("data-state")).toBe("expanded");
	});

	it("pinned groups sort before unpinned; pinned sessions sort first inside their group", async () => {
		installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({
			pinnedGroups: ["/work/alpha"],
			pinnedSessions: ["/work/alpha/two.jsonl"],
			hydrated: true,
		});
		await mount(<Sidebar />);

		const headers = [...container.querySelectorAll("[data-workspace-group]")].map(element =>
			(element.textContent ?? "").trim(),
		);
		expect(headers[0]).toContain("alpha");

		const rows = [...document.querySelectorAll(".omp-sidebar-session-row")].map(el => (el.textContent ?? "").trim());
		const oneIndex = rows.findIndex(text => text.includes("Session /work/alpha/one"));
		const twoIndex = rows.findIndex(text => text.includes("Session /work/alpha/two"));
		expect(twoIndex).toBeGreaterThanOrEqual(0);
		expect(oneIndex).toBeGreaterThanOrEqual(0);
		expect(twoIndex).toBeLessThan(oneIndex);
	});

	it("session titles truncate in place and row actions are revealed, not laid out", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = rowFor("Session /work/alpha/one");
		const title = row.querySelector("button");
		expect(title?.className).toContain("truncate");
		const rename = row.querySelector('[aria-label="Rename session"]');
		expect(rename).not.toBeNull();
		// Hover/focus reveal by opacity, never display:none, so keyboard users keep them.
		const actionsClass = (rename?.parentNode as unknown as Element | null)?.className ?? "";
		expect(actionsClass).toContain("opacity-0");
		expect(actionsClass).toContain("group-focus-within/row:opacity-100");
	});

	it("asks before removing a session transcript, and only deletes once confirmed", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = rowFor("Session /work/alpha/one");
		await fire(row.querySelector('[aria-label="Delete session"]') as Element, "onClick");

		// Queued, not executed: the trash click must never reach the hard delete.
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("/work/alpha/one");
		expect(dialog?.textContent).toContain("cannot be undone");

		const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
		await fire(buttons.find(b => (b.textContent ?? "").trim() === "Cancel") as unknown as Element, "onClick");
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();

		await fire(row.querySelector('[aria-label="Delete session"]') as Element, "onClick");
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			b => (b.textContent ?? "").trim() === "Delete",
		) as unknown as Element;
		await fire(confirm, "onClick");
		expect(omp.sessions.delete).toHaveBeenCalledWith("/work/alpha/one.jsonl");
	});

	it("closes the project's tabs and deletes its sessions so the project leaves the list", async () => {
		const omp = installMockOmp(LIST);
		const deleted = new Set<string>();
		omp.sessions.delete.mockImplementation(async (path: string) => {
			deleted.add(path);
		});
		omp.sessions.list.mockImplementation(async () => LIST.filter(entry => !deleted.has(entry.path)));
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/alpha"]') as unknown as Element;
		await fire(header, "onContextMenu");
		const items = [...document.body.querySelectorAll('[role="menu"] button')];
		await fire(items.find(b => (b.textContent ?? "").includes("Delete")) as unknown as Element, "onClick");

		expect(omp.sessions.delete).not.toHaveBeenCalled();
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("alpha");
		expect(dialog?.textContent).toContain("2");
		expect(dialog?.textContent).toContain("permanently deletes the session files");

		await fire(
			[...document.body.querySelectorAll('[role="dialog"] button')].find(
				b => (b.textContent ?? "").trim() === "Delete",
			) as unknown as Element,
			"onClick",
		);
		// Both alpha sessions, and nothing from the other workspace.
		expect(omp.sessions.delete.mock.calls.map(call => call[0]).sort()).toEqual([
			"/work/alpha/one.jsonl",
			"/work/alpha/two.jsonl",
		]);
		// t0 was the window's only tab and sat in alpha: a tab opens in the next
		// project before t0 closes, so no live row keeps alpha in the list.
		expect(omp.tabs.spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/beta" }));
		expect(omp.tabs.close).toHaveBeenCalledWith("t0");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t-new"]);
		expect(container.querySelector('[data-workspace-group="/work/alpha"]')).toBeNull();
	});
});

describe("Sidebar session-list failures", () => {
	it("names the failed read instead of claiming there are no sessions", async () => {
		const omp = installMockOmp([]);
		omp.sessions.list.mockRejectedValue(new Error("session index unreadable"));
		seedStores();
		await mount(<Sidebar />);

		// A read that never answered is not a read that found nothing: the dashed
		// "No code sessions yet" card is a false all-clear about the user's history.
		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("sidebar.loadFailed"));
		expect(text).toContain("session index unreadable");
		expect(text).not.toContain("No code sessions yet");

		const callsBeforeRetry = omp.sessions.list.mock.calls.length;
		const retry = [...document.body.querySelectorAll("button")].find(b => (b.textContent ?? "") === "Retry");
		if (!retry) throw new Error("retry button not found");
		await fire(retry as unknown as Element, "onClick");
		await flush();
		expect(omp.sessions.list.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
	});
});

describe("Sidebar subagents", () => {
	it("lists an open session's subagents directly under that session's row only", async () => {
		installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "t1",
					cwd: "/work/alpha",
					status: "running",
					kind: "agent",
					unreadDone: false,
					sessionId: "/work/alpha/two.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		ensureTabRuntime("t1");
		sessionRuntimeStore<SubagentsStore>("t1", "subagents")!
			.getState()
			.setSnapshots([
				{
					id: "sa",
					index: 1,
					agent: "scout",
					description: "map the repo",
					status: "running",
					lastUpdate: Date.now(),
				},
			]);
		await mount(<Sidebar />);

		const groups = [...container.querySelectorAll("[data-sidebar-subagents]")];
		expect(groups.map(group => group.getAttribute("data-sidebar-subagents"))).toEqual(["/work/alpha/two.jsonl"]);
		// The group renders as the next sibling of its session row.
		const next = rowFor("Session /work/alpha/two").nextElementSibling;
		expect(next?.getAttribute("data-sidebar-subagents")).toBe("/work/alpha/two.jsonl");
		expect(next?.textContent).toContain("map the repo");
	});
});
