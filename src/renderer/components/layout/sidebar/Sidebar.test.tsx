/**
 * Sidebar integration contracts: sessions-first layout (project switcher,
 * New session, filter, sessions by project, Agents/Insights/Settings + help
 * footer), Code/Work lanes, first-class global chats, project group context
 * menu (8 items), session row context menu (11 items), archive/restore,
 * recent grouping, move to project, pinned-first ordering,
 * per-session busy gates, status as icon + text, and tab-first opening (an
 * untouched empty tab is replaced instead of left behind).
 * Same linkedom + react-dom harness as TabBar.test.tsx.
 */

import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { wrapAgentMessage } from "../../../../shared/agent-control";
import type { HostView, SessionInfo } from "../../../../shared/ipc-types";
import { resetShellModeForTests, TOUCH_QUERY } from "../../../hooks/use-shell-mode";
import { useWorkspaceRecency } from "../../../hooks/use-workspace-recency";
import { formatTimeAgo } from "../../../lib/format";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useMessagesStore } from "../../../stores/messages";
import { useProjectOrigins } from "../../../stores/project-origins";
import { useQueueStore } from "../../../stores/queue";
import { useRemoteStore } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { resetSessionListFeeds } from "../../../stores/session-list";
import { deleteSessionRuntime, sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { type RailPin, useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import type { SubagentsStore } from "../../../stores/subagents";
import { ensureTabRuntime } from "../../../stores/tab-runtime";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
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
	className: string;
	firstChild: { textContent: string | null } | null;
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
		list: Mock<(scope: string, device?: string) => Promise<SessionInfo[]>>;
		delete: Mock<(path: string) => Promise<void>>;
		rename: Mock<(path: string, name: string) => Promise<void>>;
		search: Mock<(query: string, scope: string) => Promise<string[]>>;
		openInNewWindow: Mock<(payload: { sessionPath?: string }) => Promise<boolean>>;
		move: Mock<(path: string, cwd: string) => Promise<string>>;
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
		revealPath: Mock<(path: string) => Promise<{ ok: boolean }>>;
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
			move: vi.fn(async (path: string, cwd: string) => `${cwd}/${path.slice(path.lastIndexOf("/") + 1)}`),
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
			revealPath: vi.fn(async () => ({ ok: true })),
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

/** The open context menu's item whose label contains `label`. */
function menuItem(label: string): Element {
	const item = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
		(button.textContent ?? "").includes(label),
	);
	if (!item) throw new Error(`menu item "${label}" missing`);
	return item;
}

/** The React props of a rendered element, to drive handlers `fire` does not cover. */
function reactProps<T>(element: Element | TestElement): T {
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	if (!propsKey) throw new Error("reactProps: React props missing");
	return record[propsKey] as T;
}

/** Type `name` into the open rename input (prefilled with `current`) and commit it on blur. */
async function commitRenameInput(current: string, name: string): Promise<void> {
	const input = container.querySelector(`input[value="${current}"]`);
	if (!input) throw new Error(`rename input for "${current}" missing`);
	const props = reactProps<{
		onChange: (event: { target: { value: string } }) => void;
		onBlur: (event: { currentTarget: { value: string } }) => void;
	}>(input);
	await act(async () => {
		props.onChange({ target: { value: name } });
	});
	await act(async () => {
		props.onBlur({ currentTarget: { value: name } });
	});
	await flush();
}

afterEach(async () => {
	resetSessionListFeeds();
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
	useSidebarSubagentsStore.setState({
		expanded: new Set(),
		hidden: new Set(),
		present: new Set(),
		reveal: null,
	});
	useSidebarPrefs.getState().reset();
	useProjectOrigins.getState().reset();
	useRemoteStore.getState().reset();
	useUiStore.setState({
		panelVisible: false,
		sessionPickerOpen: false,
		commandPaletteOpen: false,
		destination: "session",
	});
});

const LIST = [
	session("/work/alpha/one.jsonl", "/work/alpha", {
		created: "2026-01-02T00:00:00Z",
		modified: "2026-01-02T00:00:00Z",
	}),
	session("/work/alpha/two.jsonl", "/work/alpha", {
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
	}),
	session("/work/beta/three.jsonl", "/work/beta", {
		created: "2026-01-03T00:00:00Z",
		modified: "2026-01-03T00:00:00Z",
	}),
];

function seedStores(): void {
	useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function SidebarWithWorkspaceRecency() {
	useWorkspaceRecency();
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
	it("ends with Settings and a help menu; Agents and Stats join only once pinned", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);
		const bare = container.querySelector("[data-sidebar-destinations]");
		expect(
			[...(bare?.querySelectorAll("button[data-destination]") ?? [])].map(button =>
				button.getAttribute("data-destination"),
			),
		).toEqual(["settings"]);
		await act(async () => useSidebarPrefs.getState().toggleRailPin("agents"));
		await act(async () => useSidebarPrefs.getState().toggleRailPin("stats"));

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

		// Help: shortcuts, palette, features, what's new, feedback, about, then Customize sidebar.
		await fire(footer?.querySelector('[aria-label="Help"]') ?? null, "onClick");
		expect(menuItemLabels().map(label => label.replace(/⌘.*$/, ""))).toEqual([
			"Keyboard shortcuts",
			"Command palette",
			"What OMPdesk adds",
			"What's new",
			"Send feedback",
			"About OMPdesk",
			"Customize sidebar…",
		]);
		const shortcuts = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Keyboard shortcuts"),
		);
		await fire(shortcuts as Element, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "keyboard" });
		// The pins live in Settings › General, where search finds them.
		await fire(footer?.querySelector('[aria-label="Help"]') ?? null, "onClick");
		const customize = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Customize sidebar…"),
		);
		await fire(customize as Element, "onClick");
		expect(useUiStore.getState()).toMatchObject({
			destination: "settings",
			settingsTab: "general:setting-gui-railPins",
		});
	});

	it("pins only the usage block by default (it draws nothing without a subscription account); other pinned ones sit above the destinations in a fixed order and open their view", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<Sidebar />);
		const footer = container.querySelector("[data-sidebar-destinations]");
		expect(footer?.querySelectorAll("[data-rail-pin]")).toHaveLength(0);
		const pin = (railPin: RailPin) => act(async () => useSidebarPrefs.getState().toggleRailPin(railPin));
		await pin("schedules");
		await pin("files");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage", "files", "schedules"]);
		expect(omp.prefs.set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({ railPins: ["usage", "files", "schedules"] }),
		);
		const pinned = [...(footer?.querySelectorAll("[data-rail-pin]") ?? [])].map(row => [
			row.getAttribute("data-rail-pin"),
			(row.textContent ?? "").trim(),
		]);
		expect(pinned).toEqual([
			["files", "Files"],
			["schedules", "Schedules"],
		]);

		useUiStore.setState({ destination: "insights", panelVisible: false });
		await fire(footer?.querySelector('[data-rail-pin="files"]') ?? null, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "session", panelVisible: true, panelTab: "files" });
		await fire(footer?.querySelector('[data-rail-pin="schedules"]') ?? null, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "schedules" });

		await pin("files");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage", "schedules"]);
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

	it("keeps sessions and projects in place when one is opened", async () => {
		installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "", cwd: "/neutral", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/neutral", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<SidebarWithWorkspaceRecency />);
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

		// Opening alpha's older session must not reorder anything: order follows
		// real activity, not the last click.
		expect(workspaceOrder()).toEqual(["/work/beta", "/work/alpha"]);
		expect(alphaSessionOrder()[0]).toContain("Session /work/alpha/one");
		expect(alphaSessionOrder()[1]).toContain("Session /work/alpha/two");
	});

	it("orders sessions by creation, not by the activity that rewrites their file", async () => {
		// two.jsonl was created earlier but streamed last: its modified time is the newest.
		installMockOmp([
			session("/work/alpha/one.jsonl", "/work/alpha", {
				created: "2026-01-02T00:00:00Z",
				modified: "2026-01-02T00:00:00Z",
			}),
			session("/work/alpha/two.jsonl", "/work/alpha", {
				created: "2026-01-01T00:00:00Z",
				modified: "2026-02-01T00:00:00Z",
			}),
		]);
		seedStores();
		await mount(<Sidebar />);
		const rows = [...container.querySelectorAll('[data-session-group="/work/alpha"] .omp-sidebar-session-row')]
			.map(element => element.textContent ?? "")
			.filter(text => text.includes("Session /work/alpha/"));
		expect(rows[0]).toContain("Session /work/alpha/one");
		expect(rows[1]).toContain("Session /work/alpha/two");
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

	it("lists open tabs the index does not have yet newest first, as it will once it does", async () => {
		installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "", sessionName: null, cwd: "/work/gamma", isStreaming: false });
		const tab = (id: string, title: string) => ({
			id,
			cwd: "/work/gamma",
			status: "ready" as const,
			kind: "agent" as const,
			sessionId: `${id}-id`,
			sessionPath: `/work/gamma/${id}.jsonl`,
			title,
			unreadDone: false,
		});
		useTabsStore.setState({
			tabs: [tab("a", "First"), tab("b", "Second")],
			activeTabId: "b",
			bundles: new Map(),
		});
		await mount(<Sidebar />);
		const livePaths = () =>
			[...container.querySelectorAll('[data-session-group="/work/gamma"] .omp-sidebar-session-row[data-live]')].map(
				row => row.getAttribute("data-session-path"),
			);
		expect(livePaths()).toEqual(["/work/gamma/b.jsonl", "/work/gamma/a.jsonl"]);

		// A tab opened later goes on top, and the earlier rows keep their places.
		await act(async () =>
			useTabsStore.setState({ tabs: [tab("a", "First"), tab("b", "Second"), tab("c", "Third")], activeTabId: "c" }),
		);
		await flush();
		expect(livePaths()).toEqual(["/work/gamma/c.jsonl", "/work/gamma/b.jsonl", "/work/gamma/a.jsonl"]);
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
		expect(activeRow().getAttribute("data-signal")).toBeNull();

		await act(async () => {
			useTabsStore.setState({ tabs: [{ ...useTabsStore.getState().tabs[0]!, status: "running" }] });
		});
		expect(activeRow().textContent).toContain("Running");
		expect(activeRow().getAttribute("data-signal")).toBe("running");
		expect(activeRow().querySelector('[aria-label="Delete session"]')).toBeNull();
	});

	it("marks a saved session running in a background tab that main reports by path only", async () => {
		// Main learns a tab's file from get_state (sessionPath); stock omp rarely
		// sends the session id, so a background tab often carries no sessionId.
		installMockOmp(LIST);
		seedStores();
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "t1",
					cwd: "/work/beta",
					status: "running",
					kind: "agent",
					sessionPath: "/work/beta/three.jsonl",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
		});
		await mount(<Sidebar />);

		const row = rowFor("Session /work/beta/three");
		expect(row.textContent).toContain("Running");
		expect(row.querySelector('[aria-label="Delete session"]')).toBeNull();
		// The state is the row's edge bar, not a spinner; the word stays for screen readers.
		expect(row.getAttribute("data-signal")).toBe("running");
		expect(row.querySelector('[role="status"], .omp-spinner')).toBeNull();
		expect(row.querySelector("button")?.getAttribute("title")).toContain("Running");
	});

	it("draws a waiting ask and an error on the row's edge and names them for screen readers", async () => {
		installMockOmp(LIST);
		seedStores();
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "t1",
					cwd: "/work/beta",
					status: "running",
					kind: "agent",
					sessionPath: "/work/beta/three.jsonl",
					awaitingInput: "input",
					unreadDone: false,
				},
				{
					id: "t2",
					cwd: "/work/alpha",
					status: "error",
					kind: "agent",
					sessionPath: "/work/alpha/one.jsonl",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
		});
		await mount(<Sidebar />);

		const waiting = rowFor("Session /work/beta/three");
		expect(waiting.getAttribute("data-signal")).toBe("waiting");
		expect(waiting.textContent).toContain("Needs input");
		const failed = rowFor("Session /work/alpha/one");
		expect(failed.getAttribute("data-signal")).toBe("error");
		expect(failed.textContent).toContain("Failed");
		// Idle rows carry no edge state.
		expect(rowFor("Session /work/alpha/two").getAttribute("data-signal")).toBeNull();
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
		expect(labels.some(label => label.includes("Archive all"))).toBe(true);
		expect(labels.some(label => label.includes("Delete"))).toBe(true);
		expect(labels).toHaveLength(8);
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

	it("right-click on a session row opens the 12-item session menu", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");

		const labels = menuItemLabels();
		expect(labels.map(label => label.replace(/⌘.*$/, ""))).toEqual([
			"Open",
			"Open in new tab",
			"Open in split view",
			"Open in new window",
			"Hide from other agents",
			"Rename session",
			"Pin to top",
			"Move to project…",
			"Archive",
			"Copy file path",
			"Show in folder",
			"Delete",
		]);

		const pinItem = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("Pin to top"),
		);
		await fire(pinItem as Element, "onClick");
		expect(omp.rpc.setSessionPinned).toHaveBeenCalledWith("/work/alpha/one.jsonl", true);
	});

	it("an inline rename keeps the row's height so the rows below never shift", async () => {
		installMockOmp(LIST.map(entry => ({ ...entry })));
		seedStores();
		await mount(<Sidebar />);
		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		await fire(menuItem("Rename"), "onClick");
		const input = document.body.querySelector('input[value="Session /work/alpha/one.jsonl"]');
		// The auto button sits inside the field, one wrapper deeper than the bare input.
		const wrapper = input?.closest(".omp-sidebar-session-rename");
		expect(wrapper).not.toBeNull();
		const sidebarCss = readFileSync(new URL("../../../styles/sidebar.css", import.meta.url), "utf8");
		// One rule sizes both, so the rename can never drift from the row height.
		expect(sidebarCss).toMatch(
			/\.omp-sidebar-session-row,\s*\.omp-sidebar-session-rename\s*\{[^}]*min-height:\s*var\(--sc-control-lg\)/,
		);
	});

	it("hands focus back to the row when a rename ends by Enter or Escape", async () => {
		installMockOmp(LIST.map(entry => ({ ...entry })));
		seedStores();
		await mount(<Sidebar />);
		const focused: string[] = [];
		const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: Element) {
			focused.push(this.getAttribute("data-roving-item") ?? this.tagName);
		});
		try {
			for (const key of ["Enter", "Escape"]) {
				await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
				await fire(menuItem("Rename"), "onClick");
				const input = document.body.querySelector('input[value="Session /work/alpha/one.jsonl"]');
				if (!input) throw new Error("rename input missing");
				focused.length = 0;
				const preventDefault = vi.fn();
				const props = reactProps<{
					onKeyDown: (event: Record<string, unknown>) => void;
				}>(input);
				await act(async () => {
					props.onKeyDown({
						key,
						currentTarget: { value: "Session /work/alpha/one.jsonl" },
						nativeEvent: { isComposing: false },
						preventDefault,
						stopPropagation: () => {},
					});
				});
				await flush();
				expect(document.body.querySelector('input[value="Session /work/alpha/one.jsonl"]')).toBeNull();
				expect(focused, key).toEqual(["session:/work/alpha/one.jsonl"]);
				// The Enter that committed must not go on to press (open) the row it lands on.
				expect(preventDefault).toHaveBeenCalled();
			}
		} finally {
			focus.mockRestore();
		}
	});

	it("a running task can be renamed but not deleted; idle siblings stay fully editable", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		const list = [attached, ...LIST.map(entry => ({ ...entry }))];
		const omp = installMockOmp(list);
		// The index reports what was written, so the post-rename refresh keeps the new title.
		omp.sessions.rename.mockImplementation(async (path, name) => {
			const renamed = list.find(entry => entry.path === path);
			if (renamed) renamed.title = name;
		});
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		// The attached running task: rename stays available, delete stays protected.
		const runningRow = rowFor("Session /work/alpha/mine");
		expect(runningRow.querySelector('[aria-label="Rename session"]')).not.toBeNull();
		expect(runningRow.querySelector('[aria-label="Delete session"]')).toBeNull();
		await fire(runningRow, "onContextMenu");
		expect(menuItem("Rename").hasAttribute("disabled")).toBe(false);
		expect(menuItem("Delete").hasAttribute("disabled")).toBe(true);
		await fire(menuItem("Rename"), "onClick");
		await commitRenameInput("Session /work/alpha/mine.jsonl", "Renamed running task");
		expect(omp.sessions.rename).toHaveBeenCalledWith("/work/alpha/mine.jsonl", "Renamed running task");
		// The attached session's own title follows at once, mid-run.
		expect(useSessionStore.getState().sessionName).toBe("Renamed running task");
		expect(rowFor("Renamed running task")).not.toBeNull();

		// F2 on the running row opens the rename input too; Delete does nothing.
		const runningButton = rowButton("Renamed running task");
		const buttonProps = reactProps<{ onKeyDown: (event: { key: string; preventDefault: () => void }) => void }>(
			runningButton,
		);
		await act(async () => {
			buttonProps.onKeyDown({ key: "Delete", preventDefault: () => {} });
		});
		expect(document.body.textContent).not.toContain("Delete this session permanently?");
		await act(async () => {
			buttonProps.onKeyDown({ key: "F2", preventDefault: () => {} });
		});
		expect(container.querySelector('input[value="Renamed running task"]')).not.toBeNull();
		await commitRenameInput("Renamed running task", "Renamed running task");

		// An idle sibling remains editable and deletable despite the active run.
		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		expect(menuItem("Rename").hasAttribute("disabled")).toBe(false);
		expect(menuItem("Delete").hasAttribute("disabled")).toBe(false);
		await fire(menuItem("Rename"), "onClick");
		await commitRenameInput("Session /work/alpha/one.jsonl", "Renamed idle task");
		expect(omp.sessions.rename).toHaveBeenCalledWith("/work/alpha/one.jsonl", "Renamed idle task");
		// A sibling's rename never retitles the attached session.
		expect(useSessionStore.getState().sessionName).toBe("Renamed running task");
		// The same Delete key that the running row ignored asks to delete an idle one.
		await act(async () => {
			reactProps<typeof buttonProps>(rowButton("Renamed idle task")).onKeyDown({
				key: "Delete",
				preventDefault: () => {},
			});
		});
		expect(document.body.textContent).toContain("Delete this session permanently?");
	});

	it("moves focus to the next row when the focused row is deleted", async () => {
		const list = LIST.map(entry => ({ ...entry }));
		const omp = installMockOmp(list);
		omp.sessions.delete.mockImplementation(async path => {
			list.splice(
				list.findIndex(entry => entry.path === path),
				1,
			);
		});
		seedStores();
		await mount(<Sidebar />);
		const order = [...container.querySelectorAll("[data-roving-item]")].map(item =>
			item.getAttribute("data-roving-item"),
		);
		const target = "session:/work/alpha/one.jsonl";
		const next = order[order.indexOf(target) + 1];
		expect(next).toBeDefined();
		const focused: string[] = [];
		const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: Element) {
			focused.push(this.getAttribute("data-roving-item") ?? this.tagName);
		});
		try {
			await act(async () => {
				reactProps<{ onKeyDown: (event: { key: string; preventDefault: () => void }) => void }>(
					rowButton("Session /work/alpha/one"),
				).onKeyDown({ key: "Delete", preventDefault: () => {} });
			});
			const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
				button => (button.textContent ?? "").trim() === "Delete",
			);
			focused.length = 0;
			await fire(confirm ?? null, "onClick");
			await flush();
			expect(omp.sessions.delete).toHaveBeenCalledWith("/work/alpha/one.jsonl");
			expect(focused.at(-1)).toBe(next);
		} finally {
			focus.mockRestore();
		}
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
			cwd: undefined,
			kind: "chat",
			sessionPath: "/work/alpha/chat.jsonl",
			worktree: undefined,
		});
	});

	it("a session file stock wrote before the first message is a new chat, not a deletable Untitled row", async () => {
		// A session stock `new_session` started: stock wrote its header, no message and no title yet.
		const empty = { id: "fresh", messageCount: 0, firstMessage: "", title: null, kind: "chat" as const };
		const owned = session("/work/alpha/fresh.jsonl", "/work/alpha", empty);
		const orphan = session("/work/alpha/orphan.jsonl", "/work/alpha", { ...empty, id: "orphan" });
		const kept = session("/work/alpha/kept.jsonl", "/work/alpha", { kind: "chat" });
		installMockOmp([owned, orphan, kept]);
		useSessionStore.setState({ sessionId: "fresh", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{ id: "chat", cwd: "/work/alpha", status: "ready", kind: "chat", unreadDone: false, sessionId: "fresh" },
			],
			activeTabId: "chat",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		const lane = container.querySelector("[data-chat-lane]");
		const rows = [...(lane?.querySelectorAll(".omp-sidebar-session-row") ?? [])];
		expect(lane?.textContent).not.toContain("Untitled");
		// The open tab's empty session reads as a new session, with nothing to delete; the orphan is gone.
		const current = rows.find(row => (row.textContent ?? "").includes("New session"));
		expect(current).toBeDefined();
		expect(current?.querySelector('[aria-label="Delete session"]')).toBeNull();
		expect(rows).toHaveLength(2);
		expect(lane?.textContent).toContain("Session /work/alpha/kept");
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

	it("keeps the active task protected from deletion, not renaming, while it is compacting", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		installMockOmp([attached]);
		seedStores();
		useSessionStore.setState({ isCompacting: true });
		await mount(<Sidebar />);

		await fire(rowFor("Session /work/alpha/mine"), "onContextMenu");
		expect(menuItem("Rename").hasAttribute("disabled")).toBe(false);
		expect(menuItem("Delete").hasAttribute("disabled")).toBe(true);
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

	it("session titles truncate in place and row actions appear only on hover or focus within, overlaying the end", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = rowFor("Session /work/alpha/one");
		const title = row.querySelector("button");
		expect(title?.className).toContain("truncate");
		const rename = row.querySelector('[aria-label="Rename session"]');
		expect(rename).not.toBeNull();
		// Hidden at rest and out of the pointer's way, but never display:none, so keyboard users keep them.
		const actions = (rename?.parentNode as unknown as Element | null)?.className.split(/\s+/) ?? [];
		expect(actions).toContain("opacity-0");
		expect(actions).toContain("pointer-events-none");
		expect(actions).toContain("group-hover/row:opacity-100");
		expect(actions).toContain("group-focus-within/row:opacity-100");
		expect(actions).not.toContain("hidden");
		// The title keeps its full width at rest and while they show: no padding is reserved for them.
		const titleBox = (title?.parentNode as unknown as Element | null)?.className ?? "";
		expect(titleBox).not.toMatch(/(^|\s)(group-[a-z-]+\/row:)?pr-\d+/);

		// The current row does not keep them either.
		const active = container.querySelector('[data-active="true"]') as unknown as Element | null;
		const activeActions = active?.querySelector('[aria-label="Rename session"]')
			?.parentNode as unknown as Element | null;
		if (activeActions) expect(activeActions.className.split(/\s+/)).not.toContain("opacity-100");
	});

	it("a pinned project keeps its muted pin glyph; the ⋯ is hover/focus only and an unpinned one shows no pin", async () => {
		installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ pinnedGroups: ["/work/alpha"], hydrated: true });
		await mount(<Sidebar />);

		const pins = container.querySelectorAll("[data-sidebar-group-pin]");
		expect(pins.length).toBe(1);
		const classes = (pins[0] as unknown as Element).getAttribute("class")?.split(/\s+/) ?? [];
		expect(classes).not.toContain("opacity-0");
		const menu = container.querySelector(".omp-sidebar-project-menu") as unknown as Element | null;
		const menuClasses = menu?.getAttribute("class")?.split(/\s+/) ?? [];
		expect(menuClasses).toContain("opacity-0");
		expect(menuClasses).toContain("group-hover/head:opacity-100");
		expect(menuClasses).toContain("group-focus-within/head:opacity-100");
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

	it("deleting the session the window's only tab shows closes that tab for the empty start tab, which has no row", async () => {
		const omp = installMockOmp(LIST);
		const deleted = new Set<string>();
		omp.sessions.delete.mockImplementation(async (path: string) => {
			deleted.add(path);
		});
		omp.sessions.list.mockImplementation(async () => LIST.filter(entry => !deleted.has(entry.path)));
		useSessionStore.setState({ sessionFile: "/work/alpha/one.jsonl", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{
					id: "t0",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/work/alpha/one.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		await fire(
			rowFor("Session /work/alpha/one").querySelector('[aria-label="Delete session"]') as Element,
			"onClick",
		);
		await fire(
			[...document.body.querySelectorAll('[role="dialog"] button')].find(
				b => (b.textContent ?? "").trim() === "Delete",
			) as unknown as Element,
			"onClick",
		);
		// The tab closes first (its omp gives the file up), then the file goes; no session replaces it.
		expect(omp.tabs.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ defaultWorkspace: true, placeholder: true }),
		);
		expect(omp.tabs.close).toHaveBeenCalledWith("t0");
		expect(omp.sessions.delete).toHaveBeenCalledWith("/work/alpha/one.jsonl");
		expect(omp.tabs.close.mock.invocationCallOrder[0]).toBeLessThan(
			omp.sessions.delete.mock.invocationCallOrder[0] ?? 0,
		);
		expect(useTabsStore.getState().tabs).toEqual([expect.objectContaining({ id: "t-new", placeholder: true })]);
		await flush();
		const rows = [...container.querySelectorAll(".omp-sidebar-session-row")].map(row => row.textContent ?? "");
		expect(rows.some(text => text.includes("New session"))).toBe(false);
		expect(rows.some(text => text.includes("/work/alpha/one"))).toBe(false);
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
		// t0 was the window's only tab and sat in alpha: the empty start tab opens before t0 closes (no
		// new session in another project), so no live row keeps alpha in the list.
		expect(omp.tabs.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ defaultWorkspace: true, placeholder: true }),
		);
		expect(omp.tabs.close).toHaveBeenCalledWith("t0");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t-new"]);
		expect(container.querySelector('[data-workspace-group="/work/alpha"]')).toBeNull();
	});

	it("marks a fork the way stock's resume list does, naming the session it came from", async () => {
		const shared = { title: null, firstMessage: "Refactor the parser" };
		installMockOmp([
			session("/work/alpha/parent.jsonl", "/work/alpha", { ...shared, id: "parent-id" }),
			session("/work/alpha/fork.jsonl", "/work/alpha", {
				...shared,
				id: "fork-id",
				modified: "2026-01-02T00:00:00Z",
				parentSessionPath: "/work/alpha/parent.jsonl",
			}),
			// A moved fork's header names its parent by id; an unknown parent still reads as a fork.
			session("/work/alpha/moved.jsonl", "/work/alpha", {
				title: "Moved",
				id: "moved",
				parentSessionPath: "parent-id",
			}),
			session("/work/alpha/orphan.jsonl", "/work/alpha", {
				title: "Orphan",
				id: "orphan",
				parentSessionPath: "gone",
			}),
		]);
		seedStores();
		await mount(<Sidebar />);

		const rows = [...document.querySelectorAll(".omp-sidebar-session-row")].filter(row =>
			(row.querySelector("button")?.getAttribute("title") ?? "").startsWith("Refactor the parser"),
		);
		expect(rows).toHaveLength(2);
		const [fork, parent] = rows;
		expect(fork.getAttribute("data-session-path")).toBe("/work/alpha/fork.jsonl");
		expect(fork.querySelector("[data-sidebar-fork]")).not.toBeNull();
		expect(parent.querySelector("[data-sidebar-fork]")).toBeNull();
		// Seen at a glance, not only on hover: the row says where it came from, muted after its title.
		expect(fork.querySelector("[data-fork-parent]")?.textContent).toBe(
			translate("session.fork.from", { name: "Refactor the parser" }),
		);
		expect(parent.querySelector("[data-fork-parent]")).toBeNull();
		const tooltip = (created: string, name?: string) =>
			name
				? translate("session.fork.tooltip", { name, time: formatTimeAgo(created) })
				: translate("session.fork.tooltipNoParent", { time: formatTimeAgo(created) });
		expect(fork.querySelector("button")?.getAttribute("title")).toBe(
			`Refactor the parser\n${tooltip("2026-01-01T00:00:00Z", "Refactor the parser")}`,
		);
		// Screen readers hear it in words.
		expect(fork.textContent).toContain(translate("sidebar.row.forkedFrom", { name: "Refactor the parser" }));
		expect(parent.querySelector("button")?.getAttribute("title")).toBe("Refactor the parser");
		expect(rowButton("Moved").getAttribute("title")).toBe(
			`Moved\n${tooltip("2026-01-01T00:00:00Z", "Refactor the parser")}`,
		);
		expect(rowButton("Orphan").getAttribute("title")).toBe(`Orphan\n${tooltip("2026-01-01T00:00:00Z")}`);
		expect(rowFor("Orphan").querySelector("[data-fork-parent]")).toBeNull();
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
	afterEach(async () => {
		// The runtime registry notifies on a microtask: settle it inside act.
		await act(async () => {
			deleteSessionRuntime("t1");
		});
	});

	const TWO = "/work/alpha/two.jsonl";

	/** Session two open in tab t1 with one live and one finished subagent; `current` makes t1 the active tab. */
	function seedSubagentTab(current: boolean): void {
		useSessionStore.setState({ sessionId: current ? TWO : "attached-id", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{ id: "t1", cwd: "/work/alpha", status: "running", kind: "agent", unreadDone: false, sessionId: TWO },
			],
			activeTabId: current ? "t1" : "t0",
			bundles: new Map(),
		});
		ensureTabRuntime("t1");
		setSubagentStatus("running");
	}

	function setSubagentStatus(status: "running" | "aborted"): void {
		act(() => {
			sessionRuntimeStore<SubagentsStore>("t1", "subagents")!
				.getState()
				.setSnapshots([
					{ id: "sa", index: 1, agent: "scout", description: "map the repo", status, lastUpdate: Date.now() },
					{
						id: "done",
						index: 2,
						agent: "task",
						description: "already finished",
						status: "completed",
						lastUpdate: Date.now(),
					},
				]);
		});
	}

	const disclosure = () => container.querySelector(`[data-sidebar-subagents-toggle="${TWO}"]`);
	const subagentGroup = () => container.querySelector(`[data-sidebar-subagents="${TWO}"]`);

	async function key(text: string, value: string): Promise<void> {
		const props = reactProps<{ onKeyDown: (event: unknown) => void }>(rowButton(text));
		await act(async () => props.onKeyDown({ key: value, shiftKey: false, preventDefault: () => {} }));
		await flush();
	}

	it("stays folded while a subagent runs, with a summary chip on the session row that toggles the child rows", async () => {
		installMockOmp(LIST);
		seedSubagentTab(false);
		await mount(<Sidebar />);

		// The running subagent does not open the family; the chip counts both and says one runs.
		const toggle = disclosure();
		expect(rowFor("Session /work/alpha/two").contains(toggle as unknown as Node)).toBe(true);
		expect(toggle?.querySelector("[data-family-agents]")?.textContent).toBe("2");
		expect(toggle?.querySelector("[data-family-running]")?.textContent).toBe("1");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(subagentGroup()).toBeNull();
		expect(container.querySelectorAll("[data-sidebar-subagents-toggle]").length).toBe(1);

		// The chip opens the rows without navigating away from the current session.
		await fire(toggle, "onClick");
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelectorAll("[data-sidebar-subagents-toggle]").length).toBe(1);
		const next = rowFor("Session /work/alpha/two").nextElementSibling;
		expect(next?.getAttribute("data-sidebar-subagents")).toBe(TWO);
		expect(next?.textContent).toContain("map the repo");
		expect(next?.textContent).not.toContain("already finished");
		expect(next?.textContent).toContain(translate("sidebar.family.done", { count: 1 }));
		// A tree connector hangs the rows off the session.
		expect(next?.querySelector("[data-sidebar-subagents-connector]")).not.toBeNull();
		// The child row joins the sidebar's roving (arrow-key) list right after its session.
		const roving = [...container.querySelectorAll("[data-roving-item]")].map(item =>
			item.getAttribute("data-roving-item"),
		);
		const sessionIndex = roving.indexOf(`session:${TWO}`);
		expect(sessionIndex).toBeGreaterThanOrEqual(0);
		expect(roving[sessionIndex + 1]).toBe("subagent:t1:sa");

		// The chip folds the rows without navigating away from the current session.
		await fire(toggle, "onClick");
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
		expect(subagentGroup()).toBeNull();
	});

	it("clicking the current session row unfolds and folds its family rows", async () => {
		installMockOmp(LIST);
		seedSubagentTab(true);
		await mount(<Sidebar />);
		expect(subagentGroup()).toBeNull();

		await fire(rowButton("Session /work/alpha/two"), "onClick");
		expect(subagentGroup()).not.toBeNull();
		await fire(rowButton("Session /work/alpha/two"), "onClick");
		expect(subagentGroup()).toBeNull();
	});

	it("ArrowLeft collapses and ArrowRight expands a session row with a family", async () => {
		installMockOmp(LIST);
		seedSubagentTab(false);
		await mount(<Sidebar />);

		await key("Session /work/alpha/two", "ArrowLeft");
		expect(subagentGroup()).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(TWO)).toBe(false);
		await key("Session /work/alpha/two", "ArrowRight");
		expect(subagentGroup()).not.toBeNull();
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
	});

	it("leaves the family as the person left it when the last subagent is done and on the next fan-out", async () => {
		installMockOmp(LIST);
		seedSubagentTab(false);
		await mount(<Sidebar />);
		expect(useSidebarSubagentsStore.getState().expanded.has(TWO)).toBe(false);

		setSubagentStatus("aborted");
		await flush();
		expect(subagentGroup()).toBeNull();
		expect(disclosure()?.querySelector("[data-family-running]")).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(TWO)).toBe(false);

		setSubagentStatus("running");
		await flush();
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
		expect(subagentGroup()).toBeNull();

		await fire(disclosure(), "onClick");
		expect(subagentGroup()).not.toBeNull();
		setSubagentStatus("aborted");
		await flush();
		expect(subagentGroup()).not.toBeNull();
	});
});

describe("Sidebar families: the sessions an agent opened", () => {
	const BOSS = "/work/alpha/two.jsonl";
	const WT_A = "/home/me/.omp/wt/h1/gui-agent-aaaaaa-1111111";
	const WT_B = "/home/me/.omp/wt/h1/gui-agent-bbbbbb-2222222";
	const origin = (slug: string) => ({
		project: "alpha",
		root: "/work/alpha",
		worktree: { kind: "agent", branch: `omp/agent/${slug}`, slug },
	});

	afterEach(async () => {
		await act(async () => {
			deleteSessionRuntime("t1");
		});
	});

	/**
	 * The screenshot's shape: a boss session in tab t1 and four sessions it opened: two worktree sessions the index
	 * lists (one named only by the message it was opened with, one by an unwrapped goal), a live worktree tab and a
	 * plain session in the boss's own folder.
	 */
	function mountFamily({
		tabsExtra = [],
		open = true,
	}: {
		tabsExtra?: Array<Record<string, unknown>>;
		open?: boolean;
	} = {}) {
		const omp = installMockOmp([
			session("/wt/a.jsonl", WT_A, {
				title: null,
				firstMessage: wrapAgentMessage("Title: OMPdesk 사이드바 정리\nDetails follow.", "휴대폰 테스트"),
				created: "2026-02-01T00:00:00Z",
				modified: "2026-02-01T00:00:00Z",
			}),
			session("/wt/b.jsonl", WT_B, {
				title: null,
				firstMessage: "Title: 검토 대상 확인\nGoal text.",
				created: "2026-02-02T00:00:00Z",
				modified: "2026-02-02T00:00:00Z",
			}),
			session("/work/alpha/plain.jsonl", "/work/alpha", {
				title: "Plain helper",
				created: "2026-02-04T00:00:00Z",
				modified: "2026-02-04T00:00:00Z",
			}),
			...LIST,
		]);
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(async (cwds: string[]) =>
				Object.fromEntries(
					cwds.map(cwd => [
						cwd,
						cwd === WT_A || cwd === WT_B
							? origin(cwd === WT_A ? "agent-aaaaaa" : "agent-bbbbbb")
							: cwd === "/work/alpha"
								? { project: "alpha", root: "/work/alpha", worktree: null }
								: null,
					]),
				),
			),
		};
		useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{ id: "t1", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false, sessionPath: BOSS },
				{
					id: "ta",
					cwd: WT_A,
					status: "running",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/wt/a.jsonl",
					openedBy: "t1",
				},
				{
					id: "tb",
					cwd: WT_B,
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/wt/b.jsonl",
					// After a relaunch the tab ids are new: the opener's session file finds it.
					openedBy: "t-before-the-relaunch",
					openedBySession: BOSS,
				},
				{
					id: "tc",
					cwd: "/home/me/.omp/wt/h1/gui-agent-cccccc-3333333",
					status: "running",
					kind: "agent",
					unreadDone: false,
					task: "Fix the flaky upload test",
					worktree: {
						name: "agent-cccccc",
						branch: "omp/agent/agent-cccccc",
						baseCwd: "/work/alpha",
						path: "/home/me/.omp/wt/h1/gui-agent-cccccc-3333333",
					},
					openedBy: "t1",
				},
				{
					id: "td",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/work/alpha/plain.jsonl",
					openedBy: "t1",
				},
				...tabsExtra,
			] as never,
			activeTabId: "t0",
			bundles: new Map(),
		});
		ensureTabRuntime("t1");
		useSidebarSubagentsStore.setState({ expanded: open ? new Set([BOSS]) : new Set() });
	}

	const familyRows = () => [
		...container.querySelectorAll(`[data-sidebar-family="${BOSS}"] [data-sidebar-opened-session]`),
	];

	it("nests each opened session under its opener, one line each, and drops the worktree group", async () => {
		mountFamily();
		await mount(<Sidebar />);

		// Nobody lists them in a group of their own: not the worktrees, not the project's rows.
		expect(container.querySelectorAll("[data-worktree-group]").length).toBe(0);
		expect(container.querySelector('[data-workspace-group="/work/alpha#agent"]')).toBeNull();
		const sessionRows = [...container.querySelectorAll("[data-session-group] .omp-sidebar-session-row")];
		expect(sessionRows.some(row => (row.textContent ?? "").includes("Plain helper"))).toBe(false);
		expect(sessionRows.some(row => (row.textContent ?? "").includes("OMPdesk 사이드바 정리"))).toBe(false);

		const boss = rowFor("Session /work/alpha/two");
		expect(boss.querySelector("[data-family-sessions]")?.textContent).toBe("4");
		// Two of them work: the highlighted count.
		expect(boss.querySelector("[data-family-running]")?.textContent).toBe("2");
		// The family is open (the person opened it), right under the boss's row.
		const group = boss.nextElementSibling;
		expect(group?.getAttribute("data-sidebar-family")).toBe(BOSS);

		const rows = familyRows();
		expect(rows.length).toBe(4);
		const titles = rows.map(row => row.querySelector("button")?.firstChild?.textContent);
		// Oldest first: the two stored worktree sessions, the plain one, then the live tab the index has not listed.
		// The Title: label never shows, whether the message was wrapped or not.
		expect(titles).toEqual(["OMPdesk 사이드바 정리", "검토 대상 확인", "Plain helper", "Fix the flaky upload test"]);
		expect(container.textContent).not.toContain("Title:");
		for (const row of rows) {
			// ONE line: a glyph, one button, a token and an age: the folder and the status are the tooltip.
			expect(row.querySelectorAll("button").length).toBe(1);
			expect(row.className).toContain("omp-family-row");
		}
		expect(rows.map(row => row.querySelector("[data-family-glyph]")?.getAttribute("data-family-glyph"))).toEqual([
			"worktree",
			"worktree",
			"session",
			"worktree",
		]);
		expect(rows[0]?.querySelector('[data-family-status="running"]')).not.toBeNull();
		expect(rows[2]?.querySelector("[data-family-status]")).toBeNull();
		expect(rows[0]?.querySelector("button")?.getAttribute("title")).toContain(translate("sidebar.signal.running"));
		// They join the roving list right after the boss, so arrow keys walk the family.
		const roving = [...container.querySelectorAll("[data-roving-item]")].map(item =>
			item.getAttribute("data-roving-item"),
		);
		const bossAt = roving.indexOf(`session:${BOSS}`);
		expect(roving.slice(bossAt + 1, bossAt + 3)).toEqual(["session:/wt/a.jsonl", "session:/wt/b.jsonl"]);
	});

	it("opens an opened session in its own tab on click", async () => {
		mountFamily();
		const original = useTabsStore.getState().switchTab;
		const switchTab = vi.fn(async () => {});
		useTabsStore.setState({ switchTab });
		try {
			await mount(<Sidebar />);
			const [first] = familyRows();
			await fire(first?.querySelector("button") ?? null, "onClick");
			expect(switchTab).toHaveBeenCalledWith("ta");
		} finally {
			useTabsStore.setState({ switchTab: original });
		}
	});

	it("keeps a session whose opener is not in the list in its own group", async () => {
		mountFamily({
			tabsExtra: [
				{
					id: "te",
					cwd: "/work/beta",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/work/beta/three.jsonl",
					openedBy: "t-closed",
					openedBySession: "/work/alpha/closed-boss.jsonl",
				},
			],
		});
		await mount(<Sidebar />);
		expect(familyRows().length).toBe(4);
		const betaRows = [...container.querySelectorAll('[data-session-group="/work/beta"] .omp-sidebar-session-row')];
		expect(betaRows.length).toBe(1);
		expect(betaRows[0]?.textContent).toContain("Session /work/beta/three");
	});

	it("starts folded, whatever runs, and stays as the person left it when everything it opened is done", async () => {
		mountFamily({ open: false });
		await mount(<Sidebar />);
		const boss = rowFor("Session /work/alpha/two");
		expect(boss.querySelector("[data-family-running]")?.textContent).toBe("2");
		expect(container.querySelector(`[data-sidebar-family="${BOSS}"]`)).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(BOSS)).toBe(false);

		await fire(boss.querySelector("[data-sidebar-subagents-toggle]"), "onClick");
		expect(familyRows().length).toBe(4);
		act(() => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => (tab.status === "running" ? { ...tab, status: "ready" } : tab)),
			}));
		});
		await flush();
		expect(boss.querySelector("[data-family-sessions]")?.textContent).toBe("4");
		expect(boss.querySelector("[data-family-running]")).toBeNull();
		// Opened by the person, so still open when the last one finishes.
		expect(familyRows().length).toBe(4);
	});

	it("shows the boss's row, with its family, when only something it opened matches the filter", async () => {
		mountFamily();
		await mount(<Sidebar />);
		const field = container.querySelector('input[aria-label="Filter sessions"]') as unknown as Element;
		const record = field as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = record[propsKey as string] as { onChange: (event: { target: { value: string } }) => void };
		await act(async () => props.onChange({ target: { value: "flaky upload" } }));
		await flush();

		const rows = [...container.querySelectorAll(".omp-sidebar-session-row")].map(row => row.textContent ?? "");
		expect(rows.some(text => text.includes("Session /work/alpha/two"))).toBe(true);
		expect(familyRows().length).toBe(4);
	});
});

describe("Sidebar device sections", () => {
	const REMOTE = [
		session("/Users/kim/.omp/agent/sessions/app/one.jsonl", "/Users/kim/code/app", {
			title: "Remote fix",
			device: "dev-studio",
		}),
	];

	function pairHost(state: HostView["state"]): void {
		useRemoteStore.getState().apply({
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				code: null,
				expiresAt: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [{ deviceId: "dev-studio", name: "studio", state }],
		});
	}

	function installWithRemote(): MockOmp {
		const omp = installMockOmp(LIST);
		omp.sessions.list.mockImplementation(async (_scope, device) => (device === "dev-studio" ? REMOTE : LIST));
		return omp;
	}

	it("looks exactly as before while no host is paired", async () => {
		const omp = installWithRemote();
		seedStores();
		await mount(<Sidebar />);

		expect(container.querySelector("[data-sidebar-device-header]")).toBeNull();
		expect(container.querySelector("[data-sidebar-device]")).toBeNull();
		expect(omp.sessions.list.mock.calls.every(call => call.length === 1)).toBe(true);
	});

	it("lists an online host's projects and sessions under its own header and opens them remotely", async () => {
		const omp = installWithRemote();
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		expect(container.querySelector('[data-sidebar-device-header="local"]')?.textContent).toBe(
			translate("remote.sidebar.thisDevice"),
		);
		const section = container.querySelector('[data-sidebar-device="dev-studio"]');
		expect(section?.getAttribute("data-device-state")).toBe("online");
		expect(section?.querySelector("[data-sidebar-device-toggle]")?.textContent).toContain("studio");
		expect(section?.querySelector('[data-device-group="/Users/kim/code/app"]')?.textContent).toContain("Remote fix");
		expect(omp.sessions.list).toHaveBeenCalledWith("global", "dev-studio");
		// The host's session never leaks into this device's list.
		expect(container.querySelector('[data-session-group="/Users/kim/code/app"]')).toBeNull();

		await fire(section?.querySelector("[data-device-session] button") ?? null, "onClick");
		expect(omp.tabs.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/Users/kim/code/app",
				sessionPath: "/Users/kim/.omp/agent/sessions/app/one.jsonl",
				kind: "agent",
				device: "dev-studio",
			}),
		);
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t-new")?.device).toBe("dev-studio");

		// ⌄ folds the host away.
		await fire(section?.querySelector("[data-sidebar-device-toggle]") ?? null, "onClick");
		expect(section?.querySelector("[data-device-group]")).toBeNull();
	});

	it("shows an offline host as one offline line with no sessions", async () => {
		const omp = installWithRemote();
		seedStores();
		pairHost("offline");
		await mount(<Sidebar />);

		const section = container.querySelector('[data-sidebar-device="dev-studio"]');
		expect(section?.getAttribute("data-device-state")).toBe("offline");
		expect(section?.querySelector("[data-device-offline]")?.textContent).toBe(translate("remote.sidebar.offline"));
		expect(section?.querySelector("[data-device-session]")).toBeNull();
		expect(omp.sessions.list).not.toHaveBeenCalledWith("global", "dev-studio");
		expect(section?.querySelector('[data-sidebar-device-add="dev-studio"]')?.getAttribute("disabled")).not.toBeNull();
	});

	it("marks a host's session that is a pane of the split on screen, and drags it into a split", async () => {
		installWithRemote();
		seedStores();
		const remotePath = "/Users/kim/.omp/agent/sessions/app/one.jsonl";
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "tr",
					cwd: "/Users/kim/code/app",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					device: "dev-studio",
					sessionPath: remotePath,
				},
			],
			activeTabId: "t0",
			split: { axis: "columns", ratio: 0.5, first: { tabId: "t0" }, second: { tabId: "tr" } },
		});
		pairHost("online");
		await mount(<Sidebar />);

		const row = () => container.querySelector(`[data-device-session="${remotePath}"]`);
		expect(row()?.getAttribute("data-active")).toBe("true");
		expect(row()?.getAttribute("data-pane-focus")).toBeNull();
		expect(row()?.getAttribute("draggable")).toBe("true");

		const dispatched: Event[] = [];
		const target = window as unknown as { dispatchEvent: (event: Event) => boolean };
		const original = target.dispatchEvent;
		target.dispatchEvent = event => dispatched.push(event) > 0;
		const record = row() as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (record[propsKey] as Record<string, (event: unknown) => void>) : {};
		props.onDragStart?.({ dataTransfer: { effectAllowed: "", setDragImage() {} } });
		props.onDragEnd?.({});
		const drags = dispatched.map(event => [event.type, (event as CustomEvent).detail]);
		target.dispatchEvent = original;
		expect(drags).toEqual([
			["omp:tab-drag", { tabId: "tr" }],
			["omp:tab-drag", { tabId: null }],
		]);

		// Focused, the pane gets the cue and is no longer draggable onto itself.
		await act(async () => useTabsStore.setState({ activeTabId: "tr" }));
		expect(row()?.getAttribute("data-pane-focus")).toBe("true");
		expect(row()?.getAttribute("draggable")).toBe("false");
	});
});

describe("Sidebar archive, grouping and move", () => {
	const archivedSection = () => container.querySelector("[data-sidebar-archived]");
	const archivedHeader = () => archivedSection()?.querySelector("button[aria-expanded]") ?? null;
	// Stored rows only: the focused tab's untouched session keeps a live `tab:` row of its own.
	const groupRows = (cwd: string) =>
		[...container.querySelectorAll(`[data-session-group="${cwd}"] .omp-sidebar-session-row`)]
			.map(row => row.getAttribute("data-session-path") ?? "")
			.filter(path => !path.startsWith("tab:"));

	it("archives a stored session from its row into a folded Archived section and restores it", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<Sidebar />);
		expect(archivedSection()).toBeNull();

		await fire(rowFor("Session /work/alpha/one").querySelector("[data-sidebar-archive]"), "onClick");
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["/work/alpha/one.jsonl"]);
		expect(omp.prefs.set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({ archivedSessions: ["/work/alpha/one.jsonl"] }),
		);
		expect(groupRows("/work/alpha")).toEqual(["/work/alpha/two.jsonl"]);
		expect(archivedHeader()?.textContent).toContain("Archived (1)");
		expect(archivedHeader()?.getAttribute("aria-expanded")).toBe("false");
		expect(archivedSection()?.querySelector("[data-archived-list]")).toBeNull();

		await fire(archivedHeader(), "onClick");
		const archivedRow = archivedSection()?.querySelector('[data-session-path="/work/alpha/one.jsonl"]');
		expect(archivedRow).not.toBeNull();
		expect(archivedRow?.querySelector("[data-sidebar-archive]")).toBeNull();

		await fire(archivedRow?.querySelector("[data-sidebar-restore]") ?? null, "onClick");
		expect(useSidebarPrefs.getState().archivedSessions).toEqual([]);
		expect(archivedSection()).toBeNull();
		expect(groupRows("/work/alpha")).toEqual(["/work/alpha/one.jsonl", "/work/alpha/two.jsonl"]);
	});

	it("scrolls the Archived section to the top of the list when it opens, so its rows are not left below the fold", async () => {
		installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true, archivedSessions: ["/work/alpha/one.jsonl"] });
		await mount(<Sidebar />);
		const reveal = vi.fn();
		const section = archivedSection();
		if (!section) throw new Error("expected the Archived section");
		Object.defineProperty(section, "scrollIntoView", { configurable: true, value: reveal });
		await fire(archivedHeader(), "onClick");
		expect(reveal).toHaveBeenCalledWith({ block: "start" });
		reveal.mockClear();
		await fire(archivedHeader(), "onClick");
		expect(reveal).not.toHaveBeenCalled();
	});

	it("keeps an archived session a tab holds in its list, and refuses to archive an open session", async () => {
		installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "/work/alpha/one.jsonl", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{
					id: "t0",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/work/alpha/one.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSidebarPrefs.setState({ hydrated: true, archivedSessions: ["/work/alpha/one.jsonl"] });
		await mount(<Sidebar />);

		expect(groupRows("/work/alpha")).toContain("/work/alpha/one.jsonl");
		expect(archivedSection()).toBeNull();
		expect(rowFor("Session /work/alpha/one").querySelector("[data-sidebar-archive]")).toBeNull();
		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		expect(menuItem("Archive").hasAttribute("disabled")).toBe(true);
		expect(menuItem("Move to project…").hasAttribute("disabled")).toBe(true);
		expect(menuItemLabels().some(label => label.includes("Open in split view"))).toBe(false);
	});

	it("Archive all on a project archives every session no tab holds", async () => {
		installMockOmp(LIST);
		seedStores();
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "t1",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/work/alpha/two.jsonl",
				},
			],
		});
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<Sidebar />);

		await fire(container.querySelector('[data-workspace-group="/work/alpha"]'), "onContextMenu");
		await fire(menuItem("Archive all"), "onClick");
		expect(useSidebarPrefs.getState().archivedSessions).toEqual(["/work/alpha/one.jsonl"]);
		expect(groupRows("/work/alpha")).toEqual(["/work/alpha/two.jsonl"]);
	});

	it("Delete all archived confirms, deletes every archived file and forgets the ids", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({
			hydrated: true,
			archivedSessions: ["/work/alpha/two.jsonl", "/work/beta/three.jsonl"],
		});
		await mount(<Sidebar />);
		expect(archivedHeader()?.textContent).toContain("Archived (2)");

		await fire(archivedSection()?.querySelector("div") ?? null, "onContextMenu");
		expect(menuItemLabels()).toEqual(["Restore all", "Delete all archived"]);
		await fire(menuItem("Delete all archived"), "onClick");
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("Delete all 2 archived sessions");
		await fire(
			[...document.body.querySelectorAll('[role="dialog"] button')].find(
				button => (button.textContent ?? "").trim() === "Delete",
			) as unknown as Element,
			"onClick",
		);
		expect(omp.sessions.delete).toHaveBeenCalledWith("/work/beta/three.jsonl");
		expect(omp.sessions.delete).toHaveBeenCalledWith("/work/alpha/two.jsonl");
		expect(useSidebarPrefs.getState().archivedSessions).toEqual([]);
	});

	it("the grouping toggle lists Code sessions by recent activity, each naming its project", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true, groupAliases: { "/work/beta": "Beta app" } });
		await mount(<Sidebar />);
		const toggle = container.querySelector("[data-sidebar-grouping]");
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");

		await fire(toggle, "onClick");
		expect(useSidebarPrefs.getState().grouping).toBe("recent");
		expect(omp.prefs.set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ grouping: "recent" }));
		expect(container.querySelector("[data-workspace-group]")).toBeNull();
		const rows = [...container.querySelectorAll("[data-recent-lane] .omp-sidebar-session-row")].filter(
			row => row.getAttribute("data-live") === null,
		);
		expect(rows.map(row => row.getAttribute("data-session-path"))).toEqual([
			"/work/beta/three.jsonl",
			"/work/alpha/one.jsonl",
			"/work/alpha/two.jsonl",
		]);
		expect(rows.map(row => row.querySelector("[data-sidebar-row-project]")?.textContent)).toEqual([
			"Beta app",
			"alpha",
			"alpha",
		]);
		expect(container.querySelector("[data-sidebar-grouping]")?.getAttribute("aria-pressed")).toBe("true");

		await fire(container.querySelector("[data-sidebar-grouping]"), "onClick");
		expect(container.querySelector("[data-recent-lane]")).toBeNull();
		expect(container.querySelector("[data-workspace-group]")).not.toBeNull();
	});

	it("Move to project… moves a stored session through sessions.move and keeps its pin", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true, pinnedSessions: ["/work/alpha/one.jsonl"] });
		await mount(<Sidebar />);

		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		await fire(menuItem("Move to project…"), "onClick");
		expect(menuItemLabels()).toEqual(["beta", "Other folder…"]);
		await fire(menuItem("beta"), "onClick");
		expect(omp.sessions.move).toHaveBeenCalledWith("/work/alpha/one.jsonl", "/work/beta");
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual(["/work/beta/one.jsonl"]);
		expect(document.body.querySelector('[role="menu"]')).toBeNull();
	});

	it("Move to project… reports a refused move instead of dropping it", async () => {
		const omp = installMockOmp(LIST);
		omp.sessions.move.mockRejectedValueOnce(new Error("disk full"));
		seedStores();
		await mount(<Sidebar />);

		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		await fire(menuItem("Move to project…"), "onClick");
		await fire(menuItem("beta"), "onClick");
		expect(omp.sessions.move).toHaveBeenCalledTimes(1);
		expect(useSidebarPrefs.getState().pinnedSessions).toEqual([]);
	});

	it("opens a stored session in split view and shows its file in the folder", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		const original = useTabsStore.getState();
		const openTab = vi.fn(async () => "t-new");
		const switchTab = vi.fn(async () => {});
		const splitTab = vi.fn(async () => {});
		useTabsStore.setState({ openTab, switchTab, splitTab });
		try {
			await mount(<Sidebar />);

			await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
			await fire(menuItem("Show in folder"), "onClick");
			expect(omp.system.revealPath).toHaveBeenCalledWith("/work/alpha/one.jsonl");

			await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
			await fire(menuItem("Open in split view"), "onClick");
			expect(openTab).toHaveBeenCalledWith({
				cwd: "/work/alpha",
				sessionPath: "/work/alpha/one.jsonl",
				kind: "agent",
			});
			// The new tab goes in beside the tab that was focused.
			expect(switchTab).toHaveBeenCalledWith("t0");
			expect(splitTab).toHaveBeenCalledWith("t-new", "right");
		} finally {
			useTabsStore.setState({
				openTab: original.openTab,
				switchTab: original.switchTab,
				splitTab: original.splitTab,
			});
		}
	});
});

describe("Sidebar with a split on screen", () => {
	const pane = (id: string, title: string) => ({
		id,
		cwd: "/work/alpha",
		status: "ready" as const,
		kind: "agent" as const,
		title,
		unreadDone: false,
	});
	function seedSplit() {
		useSessionStore.setState({
			sessionId: "pane-b-id",
			sessionName: "Pane B",
			cwd: "/work/alpha",
			isStreaming: false,
		});
		useTabsStore.setState({
			tabs: [pane("t0", "Pane A"), pane("t1", "Pane B"), pane("t2", "Pane C"), pane("t3", "Outside D")],
			activeTabId: "t1",
			split: {
				axis: "columns",
				ratio: 0.5,
				first: { tabId: "t0" },
				second: { axis: "rows", ratio: 0.5, first: { tabId: "t1" }, second: { tabId: "t2" } },
			},
			bundles: new Map(),
		});
	}

	it("selects every session of the split, with a quiet cue on the focused pane only", async () => {
		installMockOmp(LIST);
		seedSplit();
		await mount(<Sidebar />);

		for (const title of ["Pane A", "Pane B", "Pane C"]) {
			expect(rowFor(title).getAttribute("data-active")).toBe("true");
		}
		expect(rowFor("Outside D").getAttribute("data-active")).not.toBe("true");
		expect(rowFor("Pane B").getAttribute("data-pane-focus")).toBe("true");
		expect(rowFor("Pane A").getAttribute("data-pane-focus")).toBeNull();
		expect(rowFor("Pane C").getAttribute("data-pane-focus")).toBeNull();
		// A pane is not "open elsewhere": it is on screen.
		expect(rowFor("Pane A").querySelector("[data-sidebar-open-tab]")).toBeNull();
		expect(rowFor("Outside D").querySelector("[data-sidebar-open-tab]")).not.toBeNull();
	});

	it("shows no pane cue while a session is alone", async () => {
		installMockOmp(LIST);
		seedSplit();
		useTabsStore.setState({ split: null });
		await mount(<Sidebar />);

		expect(rowFor("Pane B").getAttribute("data-active")).toBe("true");
		expect(rowFor("Pane B").getAttribute("data-pane-focus")).toBeNull();
		expect(rowFor("Pane A").getAttribute("data-active")).not.toBe("true");
	});

	it("goes through the tab pick for every row and never re-roots a pane for an unopened session", async () => {
		installMockOmp(LIST);
		seedSplit();
		const original = useTabsStore.getState();
		const openTab = vi.fn(async () => "t-new");
		const switchTab = vi.fn(async () => {});
		useTabsStore.setState({ openTab, switchTab });
		try {
			await mount(<Sidebar />);
			await fire(rowButton("Outside D"), "onClick");
			expect(switchTab).toHaveBeenLastCalledWith("t3");
			await fire(rowButton("Pane A"), "onClick");
			expect(switchTab).toHaveBeenLastCalledWith("t0");
			expect(openTab).not.toHaveBeenCalled();
			// A stored session no tab holds opens as its own tab: the focused pane keeps its session.
			await fire(rowButton("Session /work/alpha/one"), "onClick");
			expect(openTab).toHaveBeenCalledWith({
				cwd: "/work/alpha",
				sessionPath: "/work/alpha/one.jsonl",
				kind: "agent",
			});
		} finally {
			useTabsStore.setState({ openTab: original.openTab, switchTab: original.switchTab });
		}
	});
});

describe("Sidebar worktree groups", () => {
	const AUTOPILOT = "/home/me/.omp/wt/h1/gui-2026-10-17-1ccaba4";
	const CHILD = "/home/me/.omp/wt/h1/gui-agent-5wxp8i-23abcde";
	const origin = (branch: string, kind: "autopilot" | "agent", slug: string) => ({
		project: "alpha",
		root: "/work/alpha",
		worktree: { kind, branch, slug },
	});

	function mountWithWorktrees(extra: Record<string, unknown> = {}) {
		const omp = installMockOmp([
			// The worktree sessions are the newest: by recency alone their groups would sit above alpha.
			session("/wt/auto.jsonl", AUTOPILOT, {
				title: "Cycle 3",
				created: "2026-02-03T00:00:00Z",
				modified: "2026-02-03T00:00:00Z",
			}),
			session("/wt/child.jsonl", CHILD, {
				title: "Approach A",
				created: "2026-02-02T00:00:00Z",
				modified: "2026-02-02T00:00:00Z",
			}),
			...LIST,
		]);
		const get = vi.fn(async (cwds: string[]) =>
			Object.fromEntries(
				cwds.map(cwd => [
					cwd,
					cwd === AUTOPILOT
						? origin("autopilot/2026-10-17", "autopilot", "2026-10-17")
						: cwd === CHILD
							? origin("omp/agent/agent-5wxp8i", "agent", "agent-5wxp8i")
							: cwd === "/work/alpha"
								? { project: "alpha", root: "/work/alpha", worktree: null }
								: null,
				]),
			),
		);
		(omp as unknown as Record<string, unknown>).projectOrigins = { get, ...extra };
		seedStores();
		return get;
	}

	it("sits a worktree right under its project, labelled by what it is for", async () => {
		mountWithWorktrees();
		await mount(<Sidebar />);

		const order = [...container.querySelectorAll("[data-workspace-group]")].map(element =>
			(element as unknown as Element).getAttribute("data-workspace-group"),
		);
		expect(order.indexOf(AUTOPILOT)).toBe(order.indexOf("/work/alpha") + 1);
		expect(order.indexOf("/work/alpha#agent")).toBe(order.indexOf("/work/alpha") + 2);

		const header = (cwd: string) => container.querySelector(`[data-workspace-group="${cwd}"]`) as unknown as Element;
		expect(header(AUTOPILOT).textContent?.trim()).toBe("Autopilot");
		expect(header("/work/alpha#agent").textContent?.trim()).toBe("Parallel work");
		expect(header(AUTOPILOT).getAttribute("data-worktree-group")).toBe("alpha");
		expect(header("/work/alpha").getAttribute("data-worktree-group")).toBeNull();
		// The folder names stay out of the sidebar; the full path is the tooltip.
		expect(container.textContent).not.toContain("gui-2026");
		expect(container.textContent).not.toContain("gui-agent");
		const tooltip = header(AUTOPILOT).querySelector("button[aria-expanded]")?.getAttribute("title");
		expect(tooltip).toContain(AUTOPILOT);
		expect(tooltip).toContain("alpha");
	});

	it("holds the parallel children of one project in ONE group and drops a discarded one", async () => {
		const CHILD_B = "/home/me/.omp/wt/h1/gui-agent-b7k2m1-9f8e7d6";
		const DISCARDED = "/home/me/.omp/wt/h1/gui-agent-c3d4e5-0a1b2c3";
		const omp = installMockOmp([
			session("/wt/a.jsonl", CHILD, { title: "Approach A", created: "2026-02-03T00:00:00Z" }),
			session("/wt/b.jsonl", CHILD_B, { title: "Approach B", created: "2026-02-02T00:00:00Z" }),
			session("/wt/c.jsonl", DISCARDED, { title: "Approach C", created: "2026-02-01T00:00:00Z" }),
			...LIST,
		]);
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(async (cwds: string[]) =>
				Object.fromEntries(
					cwds.map(cwd => [
						cwd,
						cwd === CHILD || cwd === CHILD_B
							? origin("omp/agent/x", "agent", "x")
							: cwd === "/work/alpha"
								? { project: "alpha", root: "/work/alpha", worktree: null }
								: null,
					]),
				),
			),
		};
		seedStores();
		await mount(<Sidebar />);
		const groups = [...container.querySelectorAll("[data-worktree-group]")];
		expect(groups).toHaveLength(1);
		expect(groups[0]?.textContent?.trim()).toBe("Parallel work");
		await fire(groups[0]?.querySelector("button[aria-expanded]") ?? null, "onClick");
		const rows = [...container.querySelectorAll(".omp-sidebar-session-row")].map(row => row.textContent ?? "");
		expect(rows.some(text => text.includes("Approach A"))).toBe(true);
		expect(rows.some(text => text.includes("Approach B"))).toBe(true);
		expect(rows.some(text => text.includes("Approach C"))).toBe(false);
		expect(container.textContent).not.toContain("gui-agent");
	});

	it("names the project too when its own group is not listed", async () => {
		const omp = installMockOmp([session("/wt/auto.jsonl", AUTOPILOT, { title: "Cycle 3" })]);
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(async (cwds: string[]) =>
				Object.fromEntries(
					cwds.map(cwd => [
						cwd,
						cwd === AUTOPILOT
							? {
									project: "beta",
									root: "/elsewhere/beta",
									worktree: { kind: "autopilot", branch: "autopilot/x", slug: "x" },
								}
							: null,
					]),
				),
			),
		};
		seedStores();
		await mount(<Sidebar />);
		const header = container.querySelector(`[data-workspace-group="${AUTOPILOT}"]`);
		expect(header?.textContent?.trim()).toBe("beta · Autopilot");
	});

	it("shows the folder without its gui-…-hash dressing while git has not answered", async () => {
		const omp = installMockOmp([session("/wt/auto.jsonl", AUTOPILOT, { title: "Cycle 3" })]);
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(() => Promise.withResolvers().promise),
		};
		seedStores();
		await mount(<Sidebar />);
		const header = container.querySelector(`[data-workspace-group="${AUTOPILOT}"]`);
		expect(header?.textContent?.trim()).toBe("2026-10-17");
	});

	it("nests an Autopilot run's children under the run's row with their task, never as groups of their own", async () => {
		const DOCS = "/home/me/.omp/wt/h1/gui-2026-10-17-c2-docs-aaaaaaa";
		const TESTS = "/home/me/.omp/wt/h1/gui-2026-10-17-c2-tests-bbbbbbb";
		const BUGS = "/home/me/.omp/wt/h1/gui-2026-10-17-c3-bugs-ccccccc";
		const omp = installMockOmp([
			session("/wt/run.jsonl", AUTOPILOT, { title: "Cycle 3", created: "2026-02-01T00:00:00Z" }),
			// Children of cycle 2 the index lists: one stock named, one known only by the message it was opened with.
			session("/wt/docs.jsonl", DOCS, { title: "Docs pass", created: "2026-02-03T00:00:00Z" }),
			session("/wt/tests.jsonl", TESTS, {
				title: null,
				firstMessage: wrapAgentMessage("Title: Cover the upload retry\nWrite the test first.", "Cycle 3"),
				created: "2026-02-04T00:00:00Z",
			}),
			...LIST,
		]);
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(async (cwds: string[]) =>
				Object.fromEntries(
					cwds.map(cwd => [
						cwd,
						cwd === AUTOPILOT
							? origin("autopilot/2026-10-17", "autopilot", "2026-10-17")
							: cwd === DOCS
								? origin("autopilot/2026-10-17-c2-docs", "autopilot", "2026-10-17-c2-docs")
								: cwd === TESTS
									? origin("autopilot/2026-10-17-c2-tests", "autopilot", "2026-10-17-c2-tests")
									: cwd === "/work/alpha"
										? { project: "alpha", root: "/work/alpha", worktree: null }
										: // The cycle-3 child's worktree is still being made: git cannot tell about it yet.
											null,
					]),
				),
			),
		};
		seedStores();
		// The open cycle-3 child: no file the index lists yet, only its tab and task. `worktree_create` reports the
		// main checkout as `baseCwd`, whichever checkout the child was cut from.
		useTabsStore.setState({
			tabs: [
				...useTabsStore.getState().tabs,
				{
					id: "child3",
					cwd: BUGS,
					status: "running",
					kind: "agent",
					unreadDone: false,
					task: "Fix the flaky upload test",
					worktree: {
						name: "2026-10-17-c3-bugs",
						branch: "autopilot/2026-10-17-c3-bugs",
						baseCwd: "/work/alpha",
						path: BUGS,
					},
				},
			],
		});
		await mount(<Sidebar />);

		const groups = [...container.querySelectorAll("[data-workspace-group]")].map(element =>
			(element as unknown as Element).getAttribute("data-workspace-group"),
		);
		for (const child of [DOCS, TESTS, BUGS]) expect(groups).not.toContain(child);
		expect(container.textContent).not.toMatch(/c2-docs|c2-tests|c3-bugs/);

		const rows = [...container.querySelectorAll(`[data-session-group="${AUTOPILOT}"] .omp-sidebar-session-row`)].map(
			row => ({
				text: row.textContent ?? "",
				child: row.getAttribute("data-session-run-child") === "true",
			}),
		);
		// The run's own row first, then its children, newest first, each one step further in.
		expect(rows.map(row => row.child)).toEqual([false, true, true, true]);
		expect(rows[0]?.text).toContain("Cycle 3");
		expect(rows[1]?.text).toContain("Fix the flaky upload test");
		expect(rows[2]?.text).toContain("Cover the upload retry");
		expect(rows[3]?.text).toContain("Docs pass");
		expect(rows.filter(row => row.text.includes("New session"))).toEqual([]);
	});
});

describe("Sidebar on a touch screen", () => {
	afterEach(() => {
		delete document.documentElement.dataset.platform;
		Object.assign(window, { matchMedia: undefined });
		resetShellModeForTests();
	});

	it("gives every session row and every project head a visible ⋯ menu: touch has no hover to reveal them", async () => {
		installMockOmp(LIST);
		seedStores();
		document.documentElement.dataset.platform = "web";
		Object.assign(window, {
			matchMedia: (query: string) => ({
				matches: query === TOUCH_QUERY,
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
		});
		resetShellModeForTests();
		await mount(<SidebarWithWorkspaceRecency />);
		await flush();
		const rows = [...container.querySelectorAll(".omp-sidebar-session-row")].filter(
			row => !row.getAttribute("data-session-path")?.startsWith("tab:"),
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.querySelectorAll("[data-sidebar-row-menu]")).toHaveLength(1);
			expect(row.querySelector("button[aria-label='Rename session']")).toBeNull();
		}
		const head = container.querySelector(".omp-sidebar-project-menu");
		expect(head?.getAttribute("class")).toContain("[@media(hover:none)]:opacity-100");
	});
});
