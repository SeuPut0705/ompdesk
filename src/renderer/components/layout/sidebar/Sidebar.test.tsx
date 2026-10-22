/**
 * Sidebar integration contracts: sessions-first layout (project switcher,
 * New session, filter, sessions by project, Agents/Insights/Settings + help
 * footer), Code/Work lanes, first-class global chats, project group context
 * menu (8 items), session row context menu (11 items), archive/restore,
 * move to project, pinned-first ordering,
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
import { codedError } from "../../../../shared/ipc-error-codes";
import type { HostView, SessionInfo } from "../../../../shared/ipc-types";
import type { SidebarProjectsRequest, SidebarProjectsState } from "../../../../shared/sidebar-projects";
import { resetShellModeForTests, TOUCH_QUERY } from "../../../hooks/use-shell-mode";
import { useWorkspaceRecency } from "../../../hooks/use-workspace-recency";
import { formatTimeAgo } from "../../../lib/format";
import { I18nProvider, translate } from "../../../lib/i18n";
import { resetLastReadForTest } from "../../../lib/last-read";
import { LOCAL_DEVICE } from "../../../lib/sidebar-memory";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { useClosedChildrenStore } from "../../../stores/closed-children";
import { useComposerStore } from "../../../stores/composer";
import { useHostedSessionsStore } from "../../../stores/hosted-sessions";
import { useMessagesStore } from "../../../stores/messages";
import { useProjectOrigins } from "../../../stores/project-origins";
import { useQueueStore } from "../../../stores/queue";
import { useRemoteStore } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { resetSessionListFeeds, sessionListFeed } from "../../../stores/session-list";
import { deleteSessionRuntime, sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { type RailPin, useSidebarPrefs } from "../../../stores/sidebar-prefs";
import { useSidebarProjects } from "../../../stores/sidebar-projects";
import { useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import type { SubagentsStore } from "../../../stores/subagents";
import { ensureTabRuntime } from "../../../stores/tab-runtime";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
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
		defaultWorkspace: Mock<(device?: string) => Promise<string>>;
		selectProject: Mock<() => Promise<string | null>>;
		setProject: Mock<(cwd: string) => Promise<boolean>>;
	};
	sessions: {
		list: Mock<(scope: string, device?: string) => Promise<SessionInfo[]>>;
		delete: Mock<(path: string) => Promise<void>>;
		stop: Mock<(path: string, device?: string) => Promise<void>>;
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
	/** This computer's project list as main keeps it (src/main/sidebar-projects.ts), per device. */
	sidebarProjects: {
		lists: Record<string, SidebarProjectsState>;
		command: Mock<(request: SidebarProjectsRequest, device?: string) => Promise<SidebarProjectsState>>;
		onState: Mock<() => () => void>;
	};
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
			stop: vi.fn(async () => {}),
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
		sidebarProjects: {
			lists: {},
			command: vi.fn(async (request, device) => {
				const lists = omp.sidebarProjects.lists;
				const key = device ?? "local";
				const list = lists[key] ?? { projects: [], removed: [], worktrees: {} };
				if (request.action === "add" && !list.projects.some(entry => entry.path === request.path))
					lists[key] = {
						projects: [...list.projects, { path: request.path, addedAt: 1 }],
						removed: list.removed.filter(entry => entry !== request.path),
						worktrees: list.worktrees,
					};
				if (request.action === "remove")
					lists[key] = {
						projects: list.projects.filter(entry => entry.path !== request.path),
						removed: [...list.removed, request.path],
						worktrees: list.worktrees,
					};
				return lists[key] ?? list;
			}),
			onState: vi.fn(() => () => {}),
		},
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

/** Open a session row's ⋯ menu, the row's only action button. */
async function openRowMenu(row: Element | TestElement | null | undefined): Promise<void> {
	await fire(row?.querySelector("[data-sidebar-row-menu]") ?? null, "onClick");
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
	useSidebarProjects.getState().reset();
	resetLastReadForTest();
	useSidebarFolds.getState().reset();
	useAgentReviewStore.getState().reset();
	useClosedChildrenStore.getState().reset();
	useProjectOrigins.getState().reset();
	useRemoteStore.getState().reset();
	useHostedSessionsStore.setState({ sessions: [], revision: 0 });
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

/**
 * What a row's age slot shows: "turn" or "background" (the working arc), "age" (the time since it last did
 * something), "waiting" (the waiting token) or null.
 */
function slotOf(row: Element): string | null {
	const end = row.querySelector("[data-sidebar-row-end]") ?? row;
	const arc = end.querySelector("[data-session-working]");
	if (arc) {
		expect(arc.querySelector(".omp-working-arc")).not.toBeNull();
		return arc.getAttribute("data-session-working");
	}
	if (end.querySelector(".omp-sidebar-approval")) return "waiting";
	return end.querySelector("time") ? "age" : null;
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
		// Customize sidebar opens its own sheet, not Settings.
		await fire(footer?.querySelector('[aria-label="Help"]') ?? null, "onClick");
		await fire(menuItem("Customize sidebar…"), "onClick");
		expect(document.body.querySelector("[data-sidebar-pins]")).not.toBeNull();
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "keyboard" });
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

		await act(async () => useUiStore.setState({ destination: "insights", panelVisible: false }));
		await fire(footer?.querySelector('[data-rail-pin="files"]') ?? null, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "session", panelVisible: true, panelTab: "files" });
		await fire(footer?.querySelector('[data-rail-pin="schedules"]') ?? null, "onClick");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "schedules" });

		await pin("files");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage", "schedules"]);
	});

	it("Help › Customize sidebar opens a sheet whose switches pin and unpin; a pinned row's menu unpins", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<Sidebar />);
		const footer = container.querySelector("[data-sidebar-destinations]");
		expect(document.body.querySelector("[data-sidebar-pins]")).toBeNull();

		await fire(footer?.querySelector('[aria-label="Help"]') ?? null, "onClick");
		await fire(menuItem("Customize sidebar…"), "onClick");
		const sheet = document.body.querySelector("[data-sidebar-pins]");
		expect(sheet?.querySelectorAll('[role="switch"]')).toHaveLength(9);
		const switchFor = (pin: string) => document.body.querySelector(`#sidebar-pin-${pin}`);
		expect(switchFor("usage")?.getAttribute("aria-checked")).toBe("true");
		expect(switchFor("files")?.getAttribute("aria-checked")).toBe("false");

		await fire(switchFor("files"), "onClick");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage", "files"]);
		expect(omp.prefs.set).toHaveBeenCalledWith("sidebar", expect.objectContaining({ railPins: ["usage", "files"] }));
		expect(switchFor("files")?.getAttribute("aria-checked")).toBe("true");
		expect(footer?.querySelector('[data-rail-pin="files"]')).not.toBeNull();

		await fire(footer?.querySelector('[data-rail-pin="files"]') ?? null, "onContextMenu");
		expect(menuItemLabels()).toEqual(["Unpin from sidebar", "Customize sidebar…"]);
		await fire(menuItem("Unpin from sidebar"), "onClick");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage"]);
		expect(footer?.querySelector('[data-rail-pin="files"]')).toBeNull();

		await fire(switchFor("agents"), "onClick");
		await fire(footer?.querySelector('[data-destination="agents"]') ?? null, "onContextMenu");
		await fire(menuItem("Unpin from sidebar"), "onClick");
		expect(useSidebarPrefs.getState().railPins).toEqual(["usage"]);
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

	it("keeps one header line, its search and the project folder button, with chats after the projects in one list", async () => {
		const omp = installMockOmp([
			...LIST,
			session("/work/chat-1.jsonl", "/work/chat-home", { kind: "chat", firstMessage: "chat one" }),
		]);
		useSessionStore.setState({ sessionId: "chat", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [{ id: "chat", cwd: "/work/alpha", status: "ready", kind: "chat", unreadDone: false }],
			activeTabId: "chat",
			bundles: new Map(),
		});
		await mount(<Sidebar />);

		const headerRow = () => container.querySelector("[data-sidebar-header-row]");
		const rowControls = () =>
			[...(headerRow()?.querySelectorAll("input, button") ?? [])].map(
				element => element.getAttribute("aria-label") ?? "",
			);
		// No Code/Chat switch: one search over every session, then the project folder button.
		expect(container.querySelector('[role="tablist"]')).toBeNull();
		expect(rowControls()).toEqual([translate("sidebar.filter"), translate("sidebar.project.newFolder")]);
		expect(headerRow()?.querySelector("input")?.getAttribute("placeholder")).toBe(
			translate("sidebar.filterPlaceholder"),
		);
		const controls = container.querySelector(".omp-sidebar-controls")?.textContent ?? "";
		expect(controls).not.toContain(translate("sidebar.newSession"));

		// Projects first, then the Chats section, in the same list.
		const list = container.querySelector('[data-tour="sessions"]');
		const firstProject = list?.querySelector("[data-workspace-group]");
		const chats = list?.querySelector('[data-sidebar-chats="local"]');
		expect(firstProject).not.toBeNull();
		expect(chats?.textContent).toContain(translate("sidebar.chats"));
		expect(chats?.textContent).toContain("Session /work/chat-1");
		const order = [...(list?.querySelectorAll("[data-workspace-group], [data-sidebar-chats]") ?? [])];
		expect(order.at(-1)).toBe(chats);

		// The Chats section's own button starts a chat.
		await fire(chats?.querySelector("[data-sidebar-new-chat]") ?? null, "onClick");
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "chat", sessionPath: undefined }),
		);
		// Its fold is remembered.
		await fire(chats?.querySelector("[data-sidebar-chats-toggle]") ?? null, "onClick");
		expect(useSidebarFolds.getState().chats.local).toBe(true);
		expect(container.querySelector('[data-sidebar-chats="local"] [data-chat-lane]')).toBeNull();
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
		expect(activeRow().querySelector("[data-working]")).toBeNull();

		await act(async () => {
			useTabsStore.setState({ tabs: [{ ...useTabsStore.getState().tabs[0]!, status: "running" }] });
		});
		expect(activeRow().textContent).toContain("Running");
		expect(activeRow().getAttribute("data-signal")).toBe("running");
		expect(activeRow().querySelector("[data-working]")).not.toBeNull();
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
		// The state is a light sweeping the row's own title, and the working arc in its age slot (no border light,
		// no bar, no new word); the word stays for screen readers.
		expect(row.getAttribute("data-signal")).toBe("running");
		const titleText = row.querySelector(".omp-live-text[data-working='turn']");
		expect(titleText?.textContent).toContain("Session /work/beta/three");
		expect(row.querySelector(".omp-live-edge")).toBeNull();
		expect(row.querySelector('[role="status"], .omp-spinner')).toBeNull();
		expect(slotOf(row)).toBe("turn");
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
		// Idle and failed rows carry no working state; a waiting one keeps its bar and its title turns a still
		// warning colour, never the sweep.
		expect(rowFor("Session /work/alpha/two").getAttribute("data-signal")).toBeNull();
		expect(waiting.querySelector(".omp-live-text")?.getAttribute("data-working")).toBe("waiting");
		for (const row of [failed, rowFor("Session /work/alpha/two")])
			expect(row.querySelector("[data-working]")).toBeNull();
		// Waiting on the person is not working: the waiting token, never the arc; the others show their age.
		expect(slotOf(waiting)).toBe("waiting");
		expect(slotOf(failed)).toBe("age");
		expect(slotOf(rowFor("Session /work/alpha/two"))).toBe("age");
	});

	it("moves a row's age on as time passes, with no new list read", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-03-01T12:00:00Z") });
		try {
			installMockOmp([
				session("/work/alpha/aged.jsonl", "/work/alpha", {
					title: "Aged session",
					created: "2026-03-01T11:00:00Z",
					modified: "2026-03-01T11:58:00Z",
				}),
				...LIST,
			]);
			seedStores();
			await mount(<Sidebar />);
			const age = () => rowFor("Aged session").querySelector("[data-sidebar-row-end] time")?.textContent;
			expect(age()).toBe("2m");
			await act(async () => {
				vi.advanceTimersByTime(3 * 60_000);
			});
			expect(age()).toBe("5m");
			await act(async () => {
				vi.advanceTimersByTime(60 * 60_000);
			});
			expect(age()).toBe("1h");
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a session a paired device's tab runs on this computer in its project group, with that tab's live state", async () => {
		// A paired device's agent opened it here (`ompdesk_session_open {device}`): its brief names a session on the
		// device, which this computer never lists, and no tab of this window holds it.
		const opened = session("/work/beta/opened.jsonl", "/work/beta", {
			title: "Fix login",
			firstMessage: wrapAgentMessage("Title: Fix login\nDetails.", "Mac session"),
			created: "2026-01-04T00:00:00Z",
			modified: "2026-01-04T00:00:00Z",
		});
		installMockOmp([...LIST, opened]);
		seedStores();
		const hosted = { sessionPath: opened.path, cwd: "/work/beta", kind: "agent" as const, device: "Mac" };
		useHostedSessionsStore.setState({ sessions: [{ ...hosted, status: "running" }] });
		await mount(<Sidebar />);

		const rows = () =>
			[...container.querySelectorAll(".omp-sidebar-session-row")].filter(row =>
				(row.textContent ?? "").includes("Fix login"),
			);
		expect(rows()).toHaveLength(1);
		expect(rowFor("Fix login").closest('[data-session-group="/work/beta"]')).not.toBeNull();
		expect(rowFor("Fix login").getAttribute("data-signal")).toBe("running");

		act(() => useHostedSessionsStore.setState({ sessions: [{ ...hosted, status: "running", awaitingInput: true }] }));
		expect(rowFor("Fix login").getAttribute("data-signal")).toBe("waiting");
		expect(rowFor("Fix login").textContent).toContain("Needs input");

		// Before it was known as a hosted session, the brief folded it away as a finished helper of nobody listed.
		act(() => useHostedSessionsStore.setState({ sessions: [] }));
		expect(rows()).toHaveLength(0);
	});

	it("lists a hosted session the index does not have yet, once, under its project", async () => {
		installMockOmp(LIST);
		seedStores();
		useHostedSessionsStore.setState({
			sessions: [
				{
					sessionPath: "/work/beta/new.jsonl",
					sessionId: "new-id",
					title: "Brand new",
					cwd: "/work/beta",
					kind: "agent",
					status: "running",
					device: "Mac",
				},
			],
		});
		await mount(<Sidebar />);
		expect(rowFor("Brand new").closest('[data-session-group="/work/beta"]')).not.toBeNull();
		expect(rowFor("Brand new").getAttribute("data-signal")).toBe("running");
	});

	it("leads no session row with a slot: a chat's glyph sits at the end, before the age", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		expect(container.querySelectorAll("[data-sidebar-workspace-icon]").length).toBeGreaterThan(0);
		const chatRow = container.querySelector('[data-session-kind="chat"]');
		const groupedAgentRow = container.querySelector('[data-session-group="/work/alpha"] [data-session-kind="agent"]');
		expect(chatRow?.querySelector("[data-sidebar-row-end] svg[data-sidebar-session-icon]")).not.toBeNull();
		expect(groupedAgentRow?.querySelector("[data-sidebar-session-icon]")).toBeNull();
		// The title is the row's first content: nothing comes before it.
		const firstContent = (groupedAgentRow as unknown as Element | null)?.children[0];
		expect(firstContent?.querySelector("button")).not.toBeNull();
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
		expect(labels.some(label => label.includes("Remove from sidebar"))).toBe(true);
		expect(labels.some(label => label.includes("Delete"))).toBe(true);
		expect(labels).toHaveLength(9);
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
			"Save diagnostic bundle",
			"Save diagnostic bundle (anonymized)",
			"Rename session",
			"Pin to top",
			"Move to project…",
			"Archive",
			"Copy file path",
			"Show in folder",
			"Delete",
		]);
		// Stock's /dump runs in a tab's own omp: a stored session no tab holds cannot be dumped.
		expect(menuItem("Save diagnostic bundle").hasAttribute("disabled")).toBe(true);
		expect(menuItem("Save diagnostic bundle (anonymized)").hasAttribute("disabled")).toBe(true);

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

		// The attached running task: one ⋯, whose menu keeps rename available and delete protected.
		const runningRow = rowFor("Session /work/alpha/mine");
		expect(runningRow.querySelector('[aria-label="Rename session"]')).toBeNull();
		expect(runningRow.querySelector('[aria-label="Delete session"]')).toBeNull();
		await openRowMenu(runningRow);
		expect(menuItem("Rename").hasAttribute("disabled")).toBe(false);
		expect(menuItem("Delete").hasAttribute("disabled")).toBe(true);
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

	it("chats live in the Chats section, not under their project", async () => {
		const chat = session("/work/alpha/chat.jsonl", "/work/alpha", { kind: "chat" });
		const agent = session("/work/alpha/agent.jsonl", "/work/alpha");
		const omp = installMockOmp([chat, agent]);
		seedStores();
		await mount(<Sidebar />);

		const workspace = container.querySelector('[data-session-group="/work/alpha"]');
		expect(workspace?.textContent).toContain("Session /work/alpha/agent");
		expect(workspace?.textContent).not.toContain("Session /work/alpha/chat");

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

	it("sessions started without a project share the Chats section with chats", async () => {
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
		// One ⋯ holds every action: no rename, archive or delete button of its own takes the title's width.
		expect(row.querySelectorAll("[data-sidebar-row-menu]")).toHaveLength(1);
		expect(row.querySelector('[aria-label="Rename session"]')).toBeNull();
		expect(row.querySelector('[aria-label="Delete session"]')).toBeNull();
		expect(row.querySelector("[data-sidebar-archive]")).toBeNull();
		const more = row.querySelector("[data-sidebar-row-menu]");
		expect(more?.getAttribute("aria-label")).toBe("Session actions");
		// Hidden at rest and out of the pointer's way, but never display:none, so keyboard users keep it.
		const actions = (more?.parentNode as unknown as Element | null)?.className.split(/\s+/) ?? [];
		expect(actions).toContain("opacity-0");
		expect(actions).toContain("pointer-events-none");
		expect(actions).toContain("group-hover/row:opacity-100");
		expect(actions).toContain("group-focus-within/row:opacity-100");
		expect(actions).not.toContain("hidden");
		// The title keeps its full width at rest and while it shows: no padding is reserved for it.
		const titleBox = (title?.parentNode as unknown as Element | null)?.className ?? "";
		expect(titleBox).not.toMatch(/(^|\s)(group-[a-z-]+\/row:)?pr-\d+/);

		// The current row does not keep it either.
		const active = container.querySelector('[data-active="true"]') as unknown as Element | null;
		const activeActions = active?.querySelector("[data-sidebar-row-menu]")?.parentNode as unknown as Element | null;
		if (activeActions) expect(activeActions.className.split(/\s+/)).not.toContain("opacity-100");
	});

	it("a row's ⋯ lists the row's own edits first, renames inline, and is the keyboard's next stop after the row", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		await openRowMenu(rowFor("Session /work/alpha/one"));
		expect(menuItemLabels().map(label => label.replace(/⌘.*$/, ""))).toEqual([
			"Rename session",
			"Pin to top",
			"Move to project…",
			"Archive",
			"Delete",
			"Open in new tab",
			"Open in split view",
			"Open in new window",
			"Hide from other agents",
			"Save diagnostic bundle",
			"Save diagnostic bundle (anonymized)",
			"Copy file path",
			"Show in folder",
		]);
		await fire(menuItem("Rename"), "onClick");
		await commitRenameInput("Session /work/alpha/one.jsonl", "Renamed from the menu");
		expect(omp.sessions.rename).toHaveBeenCalledWith("/work/alpha/one.jsonl", "Renamed from the menu");

		// A right click keeps its own order (Open first).
		await fire(rowFor("Session /work/alpha/two"), "onContextMenu");
		expect(menuItemLabels()[0]).toBe("Open");

		// Exactly one row is the list's tab stop, and its ⋯ is the next one; every other ⋯ stays out of the tab order.
		const rowOf = (item: TestElement) => (item as unknown as Element).closest(".omp-list-row");
		const stops = [...container.querySelectorAll("[data-roving-item]")].filter(
			item => item.getAttribute("tabindex") === "0",
		);
		expect(stops).toHaveLength(1);
		const stopRow = stops[0] ? rowOf(stops[0]) : null;
		const menus = [...container.querySelectorAll("[data-sidebar-row-menu]")];
		for (const menu of menus) expect(menu.getAttribute("tabindex")).toBe(rowOf(menu) === stopRow ? "0" : "-1");
	});

	it("reaches a Chats section's New chat by keyboard: its header takes the roving stop, New chat is the next one", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);
		const toggle = container.querySelector('[data-sidebar-chats="local"] [data-sidebar-chats-toggle]');
		const newChat = container.querySelector('[data-sidebar-chats="local"] [data-sidebar-new-chat]');
		expect(newChat?.getAttribute("tabindex")).toBe("-1");
		// The list hears the header's focus (React's onFocus bubbles to it).
		const list = container.querySelector('[data-tour="sessions"]') as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(list).find(key => key.startsWith("__reactProps$")) ?? "";
		const onFocus = (list[propsKey] as { onFocus: (event: unknown) => void }).onFocus;
		await act(async () => onFocus({ target: toggle }));
		await flush();
		expect(toggle?.getAttribute("tabindex")).toBe("0");
		expect(newChat?.getAttribute("tabindex")).toBe("0");
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
		await openRowMenu(row);
		await fire(menuItem("Delete"), "onClick");

		// Queued, not executed: the trash click must never reach the hard delete.
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("/work/alpha/one");
		expect(dialog?.textContent).toContain("cannot be undone");

		const buttons = [...(dialog?.querySelectorAll("button") ?? [])];
		await fire(buttons.find(b => (b.textContent ?? "").trim() === "Cancel") as unknown as Element, "onClick");
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();

		await openRowMenu(row);
		await fire(menuItem("Delete"), "onClick");
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			b => (b.textContent ?? "").trim() === "Delete",
		) as unknown as Element;
		await fire(confirm, "onClick");
		expect(omp.sessions.delete).toHaveBeenCalledWith("/work/alpha/one.jsonl");
	});

	it("a delete refused because a turn runs offers Stop and delete, which stops it and deletes once it ended, without asking again", async () => {
		const omp = installMockOmp(LIST);
		// Another window's tab runs the session: main refuses the delete until its turn has ended.
		let running = true;
		omp.sessions.delete.mockImplementation(async () => {
			if (running) throw new Error(codedError("session_running", "Session is currently running").message);
		});
		const { promise: turnEnds, resolve: endTurn } = Promise.withResolvers<void>();
		omp.sessions.stop.mockImplementation(async () => {
			await turnEnds;
			running = false;
		});
		seedStores();
		await mount(<Sidebar />);

		await openRowMenu(rowFor("Session /work/alpha/one"));
		await fire(menuItem("Delete"), "onClick");
		await fire(
			[...document.body.querySelectorAll('[role="dialog"] button')].find(
				b => (b.textContent ?? "").trim() === "Delete",
			) as unknown as Element,
			"onClick",
		);
		const refusal = useToastStore.getState().toasts.at(-1);
		expect(refusal?.action?.label).toBe("Stop and delete");
		expect(omp.sessions.delete).toHaveBeenCalledTimes(1);

		await act(async () => refusal?.action?.run());
		expect(omp.sessions.stop).toHaveBeenCalledWith("/work/alpha/one.jsonl", undefined);
		// Not before the run has ended.
		expect(omp.sessions.delete).toHaveBeenCalledTimes(1);
		await act(async () => {
			endTurn();
			await flush();
		});
		expect(omp.sessions.delete).toHaveBeenCalledTimes(2);
		expect(omp.sessions.delete).toHaveBeenLastCalledWith("/work/alpha/one.jsonl");
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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

		await openRowMenu(rowFor("Session /work/alpha/one"));
		await fire(menuItem("Delete"), "onClick");
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

	it("closes the project's tabs and deletes its sessions; the project stays listed, empty", async () => {
		const omp = installMockOmp(LIST);
		// Main lists every folder sessions ran in (src/main/sidebar-projects.ts).
		omp.sidebarProjects.lists.local = {
			projects: [
				{ path: "/work/alpha", addedAt: 1 },
				{ path: "/work/beta", addedAt: 1 },
			],
			removed: [],
			worktrees: {},
		};
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
		// The project and its sessions are two things: the folder keeps its header, with + and no rows.
		const kept = container.querySelector('[data-workspace-group="/work/alpha"]');
		expect(kept).not.toBeNull();
		expect(kept?.querySelector("[data-sidebar-group-new]")).not.toBeNull();
		expect(container.querySelectorAll('[data-session-path^="/work/alpha/"]')).toHaveLength(0);
	});

	it("lists a project with no session, and Remove from sidebar takes it out without deleting anything", async () => {
		const omp = installMockOmp(LIST);
		omp.sidebarProjects.lists.local = {
			projects: [
				{ path: "/work/alpha", addedAt: 1 },
				{ path: "/work/beta", addedAt: 1 },
				{ path: "/work/empty", addedAt: Date.parse("2026-01-05T00:00:00Z") },
			],
			removed: [],
			worktrees: {},
		};
		seedStores();
		await mount(<Sidebar />);

		const header = () => container.querySelector('[data-workspace-group="/work/empty"]');
		expect(header()?.textContent).toContain("empty");
		// Newest by when it entered the list: above beta and alpha, whose sessions are older.
		const order = [...container.querySelectorAll("[data-workspace-group]")].map(group =>
			group.getAttribute("data-workspace-group"),
		);
		expect(order.slice(0, 3)).toEqual(["/work/empty", "/work/beta", "/work/alpha"]);

		// Removing a project that still has sessions takes them off the sidebar too; nothing is deleted.
		for (const cwd of ["/work/empty", "/work/beta"]) {
			await fire(container.querySelector(`[data-workspace-group="${cwd}"]`), "onContextMenu");
			await fire(menuItem(translate("sidebar.menu.removeProject")), "onClick");
			expect(omp.sidebarProjects.command).toHaveBeenCalledWith({ action: "remove", path: cwd }, undefined);
			expect(container.querySelector(`[data-workspace-group="${cwd}"]`)).toBeNull();
		}
		expect(container.querySelector('[data-session-path="/work/beta/three.jsonl"]')).toBeNull();
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		expect(container.querySelector('[data-workspace-group="/work/alpha"]')).not.toBeNull();
	});

	it("dims a project whose folder is gone and keeps offering Remove", async () => {
		const omp = installMockOmp([]);
		omp.sidebarProjects.lists.local = {
			projects: [{ path: "/work/gone", addedAt: 1, missing: true }],
			removed: [],
			worktrees: {},
		};
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/gone"]');
		expect(header?.getAttribute("data-project-missing")).toBe("");
		expect(header?.textContent).toContain(translate("sidebar.project.missing"));
		expect(header?.querySelector("[data-sidebar-group-new]")?.getAttribute("disabled")).not.toBeNull();
		await fire(header, "onContextMenu");
		expect(menuItemLabels()).toContain(translate("sidebar.menu.removeProject"));
	});

	it("adds the folder of a session started in it to the project list", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);
		omp.tabs.spawn.mockResolvedValueOnce({ tabId: "t-new", cwd: "/work/fresh" });
		await act(async () => {
			await useTabsStore.getState().openTab({ cwd: "/work/fresh" });
		});
		await flush();
		expect(omp.sidebarProjects.command).toHaveBeenCalledWith({ action: "add", path: "/work/fresh" }, undefined);
		expect(container.querySelector('[data-workspace-group="/work/fresh"]')).not.toBeNull();
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
describe("Sidebar width", () => {
	it("resizes from the keyboard within its bounds and keeps the width", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);
		const handle = container.querySelector('aside > [role="separator"]') as unknown as TestElement;
		expect(handle.getAttribute("aria-label")).toBe("Resize sidebar");
		expect(handle.getAttribute("tabindex")).toBe("0");
		expect(handle.getAttribute("aria-valuenow")).toBe("248");
		const press = async (key: string) => {
			const record = handle as unknown as Record<string, Record<string, (event: unknown) => void>>;
			const propsKey = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$")) ?? "";
			await act(async () => record[propsKey]?.onKeyDown?.({ key, preventDefault: () => {} }));
		};
		await press("ArrowRight");
		expect(handle.getAttribute("aria-valuenow")).toBe("272");
		expect(omp.prefs.set).toHaveBeenLastCalledWith("sidebarWidth", 272);
		await press("End");
		expect(handle.getAttribute("aria-valuenow")).toBe("420");
		await press("ArrowRight");
		expect(handle.getAttribute("aria-valuenow")).toBe("420");
		await press("Home");
		expect(handle.getAttribute("aria-valuenow")).toBe("220");
		await press("ArrowLeft");
		expect(handle.getAttribute("aria-valuenow")).toBe("220");
		expect(omp.prefs.set).toHaveBeenLastCalledWith("sidebarWidth", 220);
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
		// One count: the running pill with the kind glyph, not "1" twice.
		expect(toggle?.querySelector("[data-family-agents]")).toBeNull();
		expect(toggle?.querySelector("[data-family-running]")?.textContent).toBe("1");
		expect(toggle?.querySelector("[data-family-running] svg")).not.toBeNull();
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
		expect(container.querySelector(`[data-family-done="${TWO}"]`)).toBeNull();
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

	it("drops the family when its last subagent is done, and the next fan-out starts folded", async () => {
		installMockOmp(LIST);
		seedSubagentTab(false);
		await mount(<Sidebar />);
		expect(useSidebarSubagentsStore.getState().expanded.has(TWO)).toBe(false);

		// Everything finished: nothing to list, so no chip and no group, and no "n done" row.
		setSubagentStatus("aborted");
		await flush();
		expect(subagentGroup()).toBeNull();
		expect(disclosure()).toBeNull();
		expect(container.querySelector(`[data-family-done="${TWO}"]`)).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(TWO)).toBe(false);

		setSubagentStatus("running");
		await flush();
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
		expect(subagentGroup()).toBeNull();

		await fire(disclosure(), "onClick");
		expect(subagentGroup()).not.toBeNull();
		// The last live one finishes: the open family goes with it and its remembered state is dropped.
		setSubagentStatus("aborted");
		await flush();
		expect(subagentGroup()).toBeNull();
		expect(disclosure()).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(TWO)).toBe(false);
	});

	it("keeps a fainter sweep on the title while its turn is idle and a subagent still works, and none once it is done", async () => {
		installMockOmp(LIST);
		seedSubagentTab(false);
		const edge = () => rowFor("Session /work/alpha/two").querySelector(".omp-live-text");
		await mount(<Sidebar />);
		expect(edge()?.getAttribute("data-working")).toBe("turn");
		expect(slotOf(rowFor("Session /work/alpha/two"))).toBe("turn");

		// The turn ends; the subagent it started runs on: the same sweep, the background form.
		await act(async () => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, status: "ready" } : tab)),
			}));
		});
		await flush();
		expect(rowFor("Session /work/alpha/two").getAttribute("data-signal")).toBeNull();
		expect(edge()?.getAttribute("data-working")).toBe("background");
		expect(slotOf(rowFor("Session /work/alpha/two"))).toBe("background");

		setSubagentStatus("aborted");
		await flush();
		// The work ended: the title is plain text again.
		expect(edge()?.hasAttribute("data-working")).toBe(false);
		expect(edge()?.textContent).toContain("Session /work/alpha/two");
		expect(slotOf(rowFor("Session /work/alpha/two"))).toBe("age");
	});

	it("draws a running tab whose turn ended but whose background work keeps it unsettled in the background form", async () => {
		installMockOmp(LIST);
		seedSubagentTab(false);
		// No roster entry runs: main's `settling` (stock's background work, shells included) is the only fact.
		setSubagentStatus("aborted");
		const edge = () => rowFor("Session /work/alpha/two").querySelector(".omp-live-text");
		await mount(<Sidebar />);
		expect(edge()?.getAttribute("data-working")).toBe("turn");

		await act(async () => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, settling: true as const } : tab)),
			}));
		});
		await flush();
		expect(edge()?.getAttribute("data-working")).toBe("background");
		expect(slotOf(rowFor("Session /work/alpha/two"))).toBe("background");
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
		sessionsExtra = [],
		open = true,
	}: {
		tabsExtra?: Array<Record<string, unknown>>;
		sessionsExtra?: ReturnType<typeof session>[];
		open?: boolean;
	} = {}) {
		const omp = installMockOmp([
			...sessionsExtra,
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
		return omp;
	}

	const familyRows = () => [
		...container.querySelectorAll(`[data-sidebar-family="${BOSS}"] [data-sidebar-opened-session]`),
	];

	it("nests each opened session under its opener, one line each, never as a project row", async () => {
		mountFamily();
		await mount(<Sidebar />);

		// Nobody lists them as rows of their own: not the worktrees, not the project's rows.
		const sessionRows = [...container.querySelectorAll("[data-session-group] .omp-sidebar-session-row")];
		expect(sessionRows.some(row => (row.textContent ?? "").includes("Plain helper"))).toBe(false);
		expect(sessionRows.some(row => (row.textContent ?? "").includes("OMPdesk 사이드바 정리"))).toBe(false);

		const boss = rowFor("Session /work/alpha/two");
		// Two of them work: the one highlighted count (no second, plain one beside it).
		expect(boss.querySelector("[data-family-sessions]")).toBeNull();
		expect(boss.querySelector("[data-family-running]")?.textContent).toBe("2");
		// The family is open (the person opened it), right under the boss's row.
		const group = boss.nextElementSibling;
		expect(group?.getAttribute("data-sidebar-family")).toBe(BOSS);

		// The two at work are rows; the finished ones are not listed, and no "n done" row says they exist.
		const rows = familyRows();
		expect(rows.length).toBe(2);
		expect(container.querySelector(`[data-family-done="${BOSS}"]`)).toBeNull();
		const titleOf = (row: { querySelector: Element["querySelector"] }) =>
			row.querySelector("button")?.firstChild?.textContent;
		// Oldest first: the stored worktree session, then the live tab the index has not listed.
		// The Title: label never shows, whether the message was wrapped or not.
		expect(rows.map(titleOf)).toEqual(["OMPdesk 사이드바 정리", "Fix the flaky upload test"]);
		expect(container.textContent).not.toContain("Title:");
		for (const row of rows) {
			// ONE line: a glyph, one button, a token and an age: the folder and the status are the tooltip.
			expect(row.querySelectorAll("button").length).toBe(1);
			expect(row.className).toContain("omp-family-row");
		}
		expect(rows[0]?.querySelector('[data-family-status="running"]')).not.toBeNull();
		expect(rows[0]?.querySelector("button")?.getAttribute("title")).toContain(translate("sidebar.signal.running"));
		// They join the roving list right after the boss, so arrow keys walk the family.
		const roving = [...container.querySelectorAll("[data-roving-item]")].map(item =>
			item.getAttribute("data-roving-item"),
		);
		const bossAt = roving.indexOf(`session:${BOSS}`);
		expect(roving[bossAt + 1]).toBe("session:/wt/a.jsonl");

		expect(container.textContent).not.toContain("검토 대상 확인");
		expect(container.textContent).not.toContain("Plain helper");
	});

	it("nests a session it opened on a paired device under the opener, named by that device, not in the device's list", async () => {
		mountFamily({
			tabsExtra: [
				{
					id: "tw",
					cwd: "C:\\work\\app",
					status: "running",
					kind: "agent",
					unreadDone: false,
					sessionPath: "C:\\s\\remote.jsonl",
					device: "dev-studio",
					task: "Build it on Windows",
					openedBy: "t1",
				},
			],
		});
		useRemoteStore.getState().apply({
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [{ deviceId: "dev-studio", name: "studio", state: "online" }],
			forgotten: [],
		});
		await mount(<Sidebar />);

		const remote = familyRows().find(row => row.textContent?.includes("Build it on Windows"));
		expect(remote).toBeDefined();
		expect(remote?.getAttribute("data-session-path")).toBe("C:\\s\\remote.jsonl");
		expect(remote?.querySelector('[data-family-status="running"]')).not.toBeNull();
		expect(remote?.querySelector("[data-family-device]")?.textContent).toBe("studio");
		// The boss's light counts it among the sessions at work.
		expect(rowFor("Session /work/alpha/two").querySelector("[data-family-running]")?.textContent).toBe("3");
		// A running child's token is the working arc.
		expect(remote?.querySelector('[data-family-status="running"] .omp-working-arc')).not.toBeNull();
		// It is the boss's child: the device's own list does not repeat it.
		const device = container.querySelector('[data-sidebar-device="dev-studio"]');
		expect(device?.textContent ?? "").not.toContain("Build it on Windows");
	});

	it("keeps the working arc on the idle boss while only a session it opened on a paired device runs", async () => {
		mountFamily({
			tabsExtra: [
				{
					id: "tw",
					cwd: "C:\\work\\app",
					status: "running",
					kind: "agent",
					unreadDone: false,
					sessionPath: "C:\\s\\remote.jsonl",
					device: "dev-studio",
					task: "Build it on Windows",
					openedBy: "t1",
				},
			],
		});
		const setTab = async (id: string, change: Record<string, unknown>) => {
			await act(async () => {
				useTabsStore.setState(state => ({
					tabs: state.tabs.map(tab => (tab.id === id ? { ...tab, ...change } : tab)),
				}));
			});
			await flush();
		};
		await mount(<Sidebar />);
		await setTab("ta", { status: "ready" });
		await setTab("tc", { status: "ready" });
		const boss = () => rowFor("Session /work/alpha/two");
		expect(boss().getAttribute("data-signal")).toBeNull();
		expect(slotOf(boss())).toBe("background");

		await setTab("tw", { status: "ready" });
		expect(slotOf(boss())).toBe("age");
	});

	it("leaves another device's session at the same path in that device's list", async () => {
		const omp = mountFamily({
			tabsExtra: [
				{
					id: "tw",
					cwd: "C:\\work\\app",
					status: "running",
					kind: "agent",
					unreadDone: false,
					sessionPath: "C:\\s\\remote.jsonl",
					device: "dev-studio",
					task: "Build it on Windows",
					openedBy: "t1",
				},
			],
		});
		// Two Windows PCs keep sessions under the same user path.
		const local = omp.sessions.list.getMockImplementation();
		omp.sessions.list.mockImplementation(async (scope, device) =>
			device === "dev-other"
				? [session("C:\\s\\remote.jsonl", "C:\\work\\app", { title: "Other PC work", device: "dev-other" })]
				: device === undefined && local
					? local(scope, device)
					: [],
		);
		useRemoteStore.getState().apply({
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [
				{ deviceId: "dev-studio", name: "studio", state: "online" },
				{ deviceId: "dev-other", name: "other", state: "online" },
			],
			forgotten: [],
		});
		await mount(<Sidebar />);

		const other = container.querySelector('[data-sidebar-device="dev-other"]');
		expect(other?.textContent ?? "").toContain("Other PC work");
	});

	it("nests two children at the same path on two devices as two rows, each with its own key", async () => {
		const child = (id: string, device: string, task: string) => ({
			id,
			cwd: "C:\\work\\app",
			status: "running",
			kind: "agent",
			unreadDone: false,
			sessionPath: "C:\\s\\remote.jsonl",
			device,
			task,
			openedBy: "t1",
		});
		mountFamily({
			tabsExtra: [child("tw", "dev-studio", "Build on studio"), child("tx", "dev-other", "Build on other")],
		});
		useRemoteStore.getState().apply({
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [
				{ deviceId: "dev-studio", name: "studio", state: "online" },
				{ deviceId: "dev-other", name: "other", state: "online" },
			],
			forgotten: [],
		});
		await mount(<Sidebar />);

		const remote = familyRows().filter(row => row.getAttribute("data-session-path") === "C:\\s\\remote.jsonl");
		expect(remote.map(row => row.querySelector("[data-family-device]")?.textContent).toSorted()).toEqual([
			"other",
			"studio",
		]);
		const roving = remote.map(row => row.querySelector("button")?.getAttribute("data-roving-item"));
		expect(new Set(roving).size).toBe(2);
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
			await act(async () => useTabsStore.setState({ switchTab: original }));
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
		expect(familyRows().length).toBe(2);
		const betaRows = [...container.querySelectorAll('[data-session-group="/work/beta"] .omp-sidebar-session-row')];
		expect(betaRows.length).toBe(1);
		expect(betaRows[0]?.textContent).toContain("Session /work/beta/three");
	});

	it("starts folded, whatever runs, and drops the family when everything it opened is done", async () => {
		mountFamily({ open: false });
		await mount(<Sidebar />);
		const boss = rowFor("Session /work/alpha/two");
		expect(boss.querySelector("[data-family-running]")?.textContent).toBe("2");
		expect(container.querySelector(`[data-sidebar-family="${BOSS}"]`)).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(BOSS)).toBe(false);

		await fire(boss.querySelector("[data-sidebar-subagents-toggle]"), "onClick");
		expect(familyRows().length).toBe(2);
		act(() => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab =>
					tab.status === "running"
						? { ...tab, status: "ready", lastRun: { stopReason: "stop", text: "ok" } }
						: tab,
				),
			}));
		});
		await flush();
		// Everything it opened is finished: nothing is listed, no fold and no chip say so.
		expect(familyRows().length).toBe(0);
		expect(boss.querySelector("[data-sidebar-subagents-toggle]")).toBeNull();
		expect(doneFold(BOSS)).toBeNull();
		expect(container.querySelector(`[data-sidebar-family="${BOSS}"]`)).toBeNull();
		expect(useSidebarSubagentsStore.getState().expanded.has(BOSS)).toBe(false);
	});

	it("keeps a finished session that failed as a row with the failed mark, never in the done row", async () => {
		mountFamily();
		await mount(<Sidebar />);
		act(() => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab =>
					tab.id === "ta" ? { ...tab, status: "ready", lastRun: { stopReason: "error", text: "boom" } } : tab,
				),
			}));
		});
		await flush();
		const failed = familyRows().find(row => row.getAttribute("data-session-path") === "/wt/a.jsonl");
		expect(failed?.querySelector('[data-family-status="failed"]')).not.toBeNull();
		expect(failed?.getAttribute("data-child-status")).toBe("problem");
		expect(failed?.querySelector("button")?.getAttribute("title")).toContain(translate("sidebar.row.failed"));
	});

	it("keeps a finished worktree session with unmerged commits as a row until it is merged", async () => {
		mountFamily();
		await mount(<Sidebar />);
		act(() => {
			useAgentReviewStore.setState({
				byTab: {
					t1: [
						{
							tabId: "ta",
							title: "x",
							state: "needs-review",
							branch: "omp/agent/agent-aaaaaa",
							baseBranch: "main",
							commitsAhead: 2,
							files: 1,
							added: 3,
							removed: 0,
							uncommitted: 0,
							answer: "",
						},
					],
				},
			});
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab =>
					tab.id === "ta" ? { ...tab, status: "ready", lastRun: { stopReason: "stop", text: "ok" } } : tab,
				),
			}));
		});
		await flush();
		const row = familyRows().find(entry => entry.getAttribute("data-session-path") === "/wt/a.jsonl");
		expect(row?.getAttribute("data-child-status")).toBe("problem");
		expect(row?.querySelector("button")?.getAttribute("title")).toContain(translate("sidebar.family.unmerged"));
		// Merged (the review item is gone): it folds like any finished session.
		act(() => useAgentReviewStore.setState({ byTab: { t1: [] } }));
		await flush();
		expect(familyRows().some(entry => entry.getAttribute("data-session-path") === "/wt/a.jsonl")).toBe(false);
	});

	it("lists no session main closed after its work landed, and no finished helper either", async () => {
		mountFamily();
		await mount(<Sidebar />);
		act(() => {
			useTabsStore.setState(state => ({ tabs: state.tabs.filter(tab => tab.id !== "tb") }));
			useClosedChildrenStore.setState({
				rows: [
					{ path: "/wt/b.jsonl", openedBySession: BOSS, title: "Landed task", cwd: "/work/alpha", closedAt: 1 },
				],
			});
		});
		await flush();
		// Only the two at work are listed; the closed session and the finished plain helper are not, and no fold says so.
		expect(doneFold(BOSS)).toBeNull();
		expect(familyRows().length).toBe(2);
		expect(rowFor("Session /work/alpha/two").querySelector("[data-family-running]")?.textContent).toBe("2");
		expect(container.textContent).not.toContain("검토 대상 확인");
		expect(container.textContent).not.toContain("Landed task");
		expect(container.textContent).not.toContain("Plain helper");
	});

	/** A relaunch: the tabs that came back, and no tab for anything the boss opened. */
	function relaunchedWith(...ids: string[]) {
		useTabsStore.setState(state => ({ tabs: state.tabs.filter(tab => ids.includes(tab.id)) }));
	}
	const doneFold = (key: string) => container.querySelector(`[data-family-done="${key}"]`);
	const openedPaths = (scope: string) =>
		[...container.querySelectorAll(`${scope} [data-sidebar-opened-session]`)].map(row =>
			row.getAttribute("data-session-path"),
		);

	it("lists no closed session after a relaunch, in no parallel-work group either", async () => {
		// A family left open stays open across a relaunch (remembered): this one was folded.
		mountFamily({ open: false });
		relaunchedWith("t0", "t1");
		await mount(<Sidebar />);
		// The store reads the pref once on mount: the record is what main wrote.
		act(() => {
			useClosedChildrenStore.setState({
				rows: [
					{ path: "/wt/b.jsonl", openedBySession: BOSS, title: "Landed task", cwd: "/work/alpha", closedAt: 1 },
				],
			});
		});
		await flush();

		expect(doneFold(BOSS)).toBeNull();
		expect(container.querySelector(`[data-sidebar-family="${BOSS}"]`)).toBeNull();
		expect(container.textContent).not.toContain("Landed task");
	});

	it("lists no closed session whose work landed, though its opener has no tab either", async () => {
		mountFamily();
		relaunchedWith("t0");
		await mount(<Sidebar />);
		// The store reads the pref once on mount: the record is what main wrote.
		act(() => {
			useClosedChildrenStore.setState({
				rows: [
					{ path: "/wt/b.jsonl", openedBySession: BOSS, title: "Landed task", cwd: "/work/alpha", closedAt: 1 },
				],
			});
		});
		await flush();

		expect(rowFor("Session /work/alpha/two").querySelector("[data-sidebar-subagents-toggle]")).toBeNull();
		expect(doneFold(BOSS)).toBeNull();
		expect(container.querySelector(`[data-sidebar-family="${BOSS}"]`)).toBeNull();
		expect(container.textContent).not.toContain("Landed task");
	});

	it("lists no session opened before provenance was kept once it finished, though its agent brief names the opener", async () => {
		// A family left open stays open across a relaunch (remembered): this one was folded.
		mountFamily({
			open: false,
			sessionsExtra: [
				session("/work/alpha/legacy.jsonl", "/work/alpha", {
					title: null,
					firstMessage: wrapAgentMessage("Title: Legacy job\nDetails.", "Session /work/alpha/two.jsonl"),
					created: "2026-02-05T00:00:00Z",
					modified: "2026-02-05T00:00:00Z",
				}),
			],
		});
		relaunchedWith("t0", "t1");
		await mount(<Sidebar />);

		const rows = [...container.querySelectorAll("[data-session-group] .omp-sidebar-session-row")];
		expect(rows.some(row => (row.textContent ?? "").includes("Legacy job"))).toBe(false);
		expect(container.textContent).not.toContain("Legacy job");
		expect(doneFold(BOSS)).toBeNull();
		expect(rowFor("Session /work/alpha/two").querySelector("[data-family-sessions]")).toBeNull();
	});

	it("lists no finished closed session that no opener row holds: no done fold, no parallel-work group", async () => {
		mountFamily();
		relaunchedWith("t0", "t1");
		await mount(<Sidebar />);

		// /wt/a names a sender nobody here is titled as; /wt/b has no brief and only its `omp/agent/…` branch.
		expect(doneFold(BOSS)).toBeNull();
		expect(doneFold("group:/work/alpha")).toBeNull();
		expect(container.querySelector("[data-sidebar-loose-children]")).toBeNull();
		const sessionRows = [...container.querySelectorAll("[data-session-group] .omp-sidebar-session-row")];
		expect(sessionRows.some(row => (row.textContent ?? "").includes("OMPdesk 사이드바 정리"))).toBe(false);
		expect(container.textContent).not.toContain("OMPdesk 사이드바 정리");
	});

	it("still lists a closed session no opener row holds when it failed, as a plain row without a fold", async () => {
		mountFamily({
			sessionsExtra: [
				session("/work/alpha/broken.jsonl", "/work/alpha", {
					title: "Broken helper",
					firstMessage: wrapAgentMessage("Title: Broken helper\nDetails.", "Nobody listed"),
					status: "error",
					created: "2026-02-06T00:00:00Z",
					modified: "2026-02-06T00:00:00Z",
				}),
			],
		});
		relaunchedWith("t0", "t1");
		await mount(<Sidebar />);
		expect(doneFold("group:/work/alpha")).toBeNull();
		expect(openedPaths('[data-sidebar-loose-children="group:/work/alpha"]')).toEqual(["/work/alpha/broken.jsonl"]);
	});

	it("lists a finished session a paired device's agent opened here: its opener is on that device", async () => {
		mountFamily({
			sessionsExtra: [
				session("/work/alpha/from-mac.jsonl", "/work/alpha", {
					title: null,
					firstMessage: wrapAgentMessage("Title: Measure memory\nDetails.", "A session on the Mac"),
					promptOriginDevice: "mac-1",
					created: "2026-02-06T00:00:00Z",
					modified: "2026-02-06T00:00:00Z",
				}),
			],
		});
		relaunchedWith("t0", "t1");
		await mount(<Sidebar />);
		const rows = [...container.querySelectorAll("[data-session-group] .omp-sidebar-session-row")];
		expect(rows.map(row => row.getAttribute("data-session-path"))).toContain("/work/alpha/from-mac.jsonl");
	});

	it("reads an opened session as its task while the index lists it without a first message", async () => {
		mountFamily({
			sessionsExtra: [
				session("/wt/c.jsonl", "/work/alpha", {
					title: null,
					firstMessage: "",
					messageCount: 1,
					created: "2026-02-03T00:00:00Z",
					modified: "2026-02-03T00:00:00Z",
				}),
			],
			tabsExtra: [
				{
					id: "tf",
					cwd: "/work/alpha",
					status: "running",
					kind: "agent",
					unreadDone: false,
					sessionPath: "/wt/c.jsonl",
					task: "Rebuild the index",
					openedBy: "t1",
				},
			],
		});
		await mount(<Sidebar />);
		const titles = familyRows().map(row => row.querySelector("button")?.firstChild?.textContent);
		expect(titles).toContain("Rebuild the index");
		expect(container.textContent).not.toContain(translate("sidebar.untitled"));
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
		expect(familyRows().length).toBe(2);
	});

	it("lights the idle boss's row faintly while a session it opened runs; a waiting one keeps its warning look", async () => {
		mountFamily();
		await mount(<Sidebar />);
		const boss = () => rowFor("Session /work/alpha/two");
		const edge = () => boss().querySelector(".omp-live-text");
		const setTab = async (id: string, change: Record<string, unknown>) => {
			await act(async () => {
				useTabsStore.setState(state => ({
					tabs: state.tabs.map(tab => (tab.id === id ? { ...tab, ...change } : tab)),
				}));
			});
			await flush();
		};
		// The boss's own turn is idle; two sessions it opened run.
		expect(boss().getAttribute("data-signal")).toBeNull();
		expect(edge()?.getAttribute("data-working")).toBe("background");
		expect(slotOf(boss())).toBe("background");

		// One now waits for the person: its row keeps the warning look and no light; the other still runs.
		await setTab("ta", { awaitingInput: "input" });
		const waiting = familyRows().find(row => row.getAttribute("data-session-path") === "/wt/a.jsonl");
		expect(waiting?.getAttribute("data-signal")).toBe("waiting");
		expect(waiting?.querySelector('[data-working="turn"], [data-working="background"]')).toBeNull();
		expect(waiting?.querySelector(".omp-working-arc")).toBeNull();
		expect(edge()?.getAttribute("data-working")).toBe("background");
		expect(slotOf(boss())).toBe("background");

		// Nothing runs behind the idle boss any more (one waits, the other finished): no light.
		await setTab("tc", { status: "ready" });
		expect(boss().querySelector("[data-working]")).toBeNull();
		expect(slotOf(boss())).toBe("age");
	});

	it("lights the boss's row in a window viewing it while a session its agent opened runs as another window's tab", async () => {
		// A web page viewing the boss holds only the boss's tab: the sessions its agent opened are tabs of the desktop
		// window that opened them, so main's review list is all this window knows of them. The index names the child's
		// opener by a title the boss has since changed, so only the review list ties them.
		const omp = installMockOmp([
			session("/wt/x.jsonl", WT_A, {
				title: null,
				firstMessage: wrapAgentMessage("Title: Fix the upload\nDetails follow.", "An older title"),
				created: "2026-02-01T00:00:00Z",
				modified: "2026-02-01T00:00:00Z",
			}),
			...LIST,
		]);
		useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{
					id: "t1",
					cwd: "/work/alpha",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					sessionPath: BOSS,
					shared: true,
				},
			] as never,
			activeTabId: "t1",
			bundles: new Map(),
		});
		ensureTabRuntime("t1");
		useSidebarSubagentsStore.setState({ expanded: new Set([BOSS]) });
		const item = {
			tabId: "desk-child",
			sessionPath: "/wt/x.jsonl",
			title: "Fix the upload",
			state: "running" as const,
			commitsAhead: 0,
			files: 0,
			added: 0,
			removed: 0,
			uncommitted: 0,
			answer: "",
		};
		// The page just opened: no push has come yet, so it asks main for the viewed tab's list.
		const ask = vi.fn(async (tabId: string, command: { type: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data: tabId === "t1" && command.type === "agent_control_review" ? { items: [item], usage: {} } : {},
		}));
		(omp.rpc as unknown as Record<string, unknown>).commandForTab = ask;
		await mount(<Sidebar />);
		const boss = () => rowFor("Session /work/alpha/two");
		const child = () =>
			container.querySelector(`[data-sidebar-family="${BOSS}"] [data-session-path="/wt/x.jsonl"]`) as Element | null;
		expect(boss().getAttribute("data-signal")).toBeNull();
		expect(boss().querySelector(".omp-live-text")?.getAttribute("data-working")).toBe("background");
		expect(child()?.getAttribute("data-child-status")).toBe("running");
		expect(slotOf(boss())).toBe("background");

		// It waits on the person: no light on the idle boss, the child keeps its warning look.
		act(() => useAgentReviewStore.setState({ byTab: { t1: [{ ...item, waiting: true }] } }));
		await flush();
		expect(boss().querySelector(".omp-live-edge:not([data-leaving])")).toBeNull();
		expect(child()?.getAttribute("data-child-status")).toBe("waiting");

		// It finished and its work landed (main drops the item): nothing runs behind the boss.
		act(() => useAgentReviewStore.setState({ byTab: { t1: [] } }));
		await flush();
		expect(boss().querySelector(".omp-live-edge:not([data-leaving])")).toBeNull();
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
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [{ deviceId: "dev-studio", name: "studio", state }],
			forgotten: [],
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
		expect(container.querySelector("[data-sidebar-device-add]")).toBeNull();
		// With no device groups the project folder button sits beside the search, as it always did.
		expect(container.querySelector("[data-sidebar-open-project]")).not.toBeNull();
		expect(omp.sessions.list.mock.calls.every(call => call.length === 1)).toBe(true);
	});

	it("puts the project folder button on this device's header, not beside the search, once a host is paired", async () => {
		const omp = installWithRemote();
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		// Every device header ends in its own button; the search row's would be a second one for this device.
		expect(container.querySelector("[data-sidebar-open-project]")).toBeNull();
		const header = container.querySelector('[data-sidebar-device-header="local"]');
		const add = header?.querySelector('[data-sidebar-device-add="local"]') ?? null;
		expect(add?.getAttribute("aria-label")).toBe(
			translate("remote.sidebar.addProject", { name: translate("remote.sidebar.thisDevice") }),
		);
		// The chevron stays and still folds the list.
		expect(header?.querySelector('[data-sidebar-device-toggle="local"]')?.getAttribute("aria-expanded")).toBe("true");

		omp.system.showOpenDialog.mockResolvedValueOnce(["/work/new-app"]);
		await fire(add, "onClick");
		await act(async () => {});
		expect(omp.system.showOpenDialog).toHaveBeenLastCalledWith(
			undefined,
			expect.objectContaining({ directory: true, buttonLabel: translate("sidebar.project.newFolderButton") }),
		);
		// Started on this computer: the untouched tab re-rooted, else a new local tab; never on the host.
		const spawnedCwds = omp.tabs.spawn.mock.calls.map(([payload]) =>
			payload && typeof payload === "object" && "cwd" in payload ? payload.cwd : undefined,
		);
		expect([...omp.sidecar.setProject.mock.calls.map(([cwd]) => cwd), ...spawnedCwds]).toEqual(["/work/new-app"]);
		expect(omp.tabs.spawn).not.toHaveBeenCalledWith(expect.objectContaining({ device: expect.anything() }));
	});

	it("gives every device its own Chats section after its projects, its New chat starting the chat on that device", async () => {
		const omp = installWithRemote();
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		// Every device header ends in its project button; a new chat is each device's Chats section's.
		expect(container.querySelector('[data-sidebar-device-add="local"]')).not.toBeNull();
		expect(container.querySelector('[data-sidebar-device-add="dev-studio"]')).not.toBeNull();
		const local = container.querySelector('[data-sidebar-chats="local"] [data-sidebar-new-chat]');
		expect(local?.getAttribute("aria-label")).toBe(translate("sidebar.newChat"));
		const host = container.querySelector(
			'[data-sidebar-device="dev-studio"] [data-sidebar-chats="dev-studio"] [data-sidebar-device-new-chat="dev-studio"]',
		);
		expect(host?.getAttribute("aria-label")).toBe(translate("remote.sidebar.newChat", { name: "studio" }));

		// This device's starts a chat here; never on the host, never a folder dialog.
		await fire(local, "onClick");
		await act(async () => {});
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "chat" }));
		expect(omp.tabs.spawn.mock.lastCall?.[0]).not.toHaveProperty("device");
		// The host's starts it on the host, in its own workspace.
		await fire(host, "onClick");
		await act(async () => {});
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "chat", cwd: undefined, device: "dev-studio" }),
		);
		expect(omp.system.showOpenDialog).not.toHaveBeenCalled();
	});

	it("lights a host's session that no tab here holds while the host works on it, before anyone opens it", async () => {
		installWithRemote();
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);
		const row = () =>
			container.querySelector(
				'[data-device-session="/Users/kim/.omp/agent/sessions/app/one.jsonl"]',
			) as unknown as Element;
		expect(slotOf(row())).toBe("age");

		const live = (state: "turn" | "background" | "waiting") =>
			act(async () => {
				const remote = useRemoteStore.getState().state;
				if (!remote) throw new Error("no remote state");
				useRemoteStore.getState().apply({
					...remote,
					hosts: [
						{
							deviceId: "dev-studio",
							name: "studio",
							state: "online",
							live: [{ sessionPath: "/Users/kim/.omp/agent/sessions/app/one.jsonl", state }],
						},
					],
				});
			});
		await live("turn");
		expect(slotOf(row())).toBe("turn");
		expect(row().textContent).toContain(translate("sidebar.signal.running"));
		await live("background");
		expect(slotOf(row())).toBe("background");
		await live("waiting");
		expect(slotOf(row())).toBe("age");
		expect(row().querySelector(".omp-live-text")?.getAttribute("data-working")).toBe("waiting");

		// The host no longer says it works on it (or the link went down): the row goes quiet.
		pairHost("online");
		await act(async () => {});
		expect(slotOf(row())).toBe("age");
		expect(row().querySelector(".omp-live-text")?.getAttribute("data-working")).toBeNull();
	});

	it("lists an online host's projects and sessions under its own header and opens them remotely", async () => {
		const omp = installWithRemote();
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		expect(container.querySelector('[data-sidebar-device-toggle="local"]')?.textContent).toBe(
			translate("remote.sidebar.thisDevice"),
		);
		const section = container.querySelector('[data-sidebar-device="dev-studio"]');
		expect(section?.getAttribute("data-device-state")).toBe("online");
		expect(section?.querySelector("[data-sidebar-device-toggle]")?.textContent).toContain("studio");
		// A narrow sidebar cuts a long device name: hovering the header names it whole.
		expect(section?.querySelector("[data-sidebar-device-toggle]")?.getAttribute("title")).toBe("studio");
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

	it("puts a host worktree's session under its project, as the host's git says, and removes them together", async () => {
		const omp = installWithRemote();
		const WT = "/Users/kim/.omp/wt/gui-agent-a1b2c3-0a1b2c3";
		omp.sessions.list.mockImplementation(async (_scope, device) =>
			device === "dev-studio"
				? [...REMOTE, session("/Users/kim/.omp/agent/sessions/wt/two.jsonl", WT, { title: "Worktree fix", device })]
				: LIST,
		);
		omp.sidebarProjects.lists["dev-studio"] = {
			projects: [{ path: "/Users/kim/code/app", addedAt: 1 }],
			removed: [],
			worktrees: { [WT]: "/Users/kim/code/app" },
		};
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		const section = container.querySelector('[data-sidebar-device="dev-studio"]');
		expect(section?.querySelector(`[data-device-group="${WT}"]`)).toBeNull();
		const app = section?.querySelector('[data-device-group="/Users/kim/code/app"]');
		expect(app?.textContent).toContain("Remote fix");
		expect(app?.textContent).toContain("Worktree fix");
		expect(section?.querySelectorAll("[data-device-group]")).toHaveLength(1);

		await fire(app?.querySelector(".group\\/head") ?? null, "onContextMenu");
		await fire(menuItem(translate("sidebar.menu.removeProject")), "onClick");
		expect(section?.querySelector("[data-device-group]")).toBeNull();
		expect(section?.textContent).not.toContain("Worktree fix");
	});

	it("shows the host's own project list, empty projects too, and removes one there", async () => {
		const omp = installWithRemote();
		omp.sidebarProjects.lists["dev-studio"] = {
			projects: [
				{ path: "/Users/kim/code/app", addedAt: 1 },
				{ path: "/Users/kim/code/empty", addedAt: 2 },
			],
			removed: [],
			worktrees: {},
		};
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		const section = container.querySelector('[data-sidebar-device="dev-studio"]');
		// The host's list, read over the link: an empty project there keeps its header here.
		expect(omp.sidebarProjects.command).toHaveBeenCalledWith({ action: "get" }, "dev-studio");
		const empty = section?.querySelector('[data-device-group="/Users/kim/code/empty"]');
		expect(empty?.textContent).toContain("empty");
		expect(empty?.querySelector("[data-device-session]")).toBeNull();
		// This computer's own list never shows the host's project.
		expect(container.querySelector('[data-workspace-group="/Users/kim/code/empty"]')).toBeNull();

		await fire(empty?.querySelector(".group\\/head") ?? null, "onContextMenu");
		await fire(menuItem(translate("sidebar.menu.removeProject")), "onClick");
		expect(omp.sidebarProjects.command).toHaveBeenCalledWith(
			{ action: "remove", path: "/Users/kim/code/empty" },
			"dev-studio",
		);
		expect(section?.querySelector('[data-device-group="/Users/kim/code/empty"]')).toBeNull();
		expect(omp.sidebarProjects.lists["dev-studio"]?.removed).toEqual(["/Users/kim/code/empty"]);
	});

	it("shows an offline host as one offline line with no sessions", async () => {
		const omp = installWithRemote();
		seedStores();
		pairHost("offline");
		await mount(<Sidebar />);

		const section = container.querySelector('[data-sidebar-device="dev-studio"]');
		expect(section?.getAttribute("data-device-state")).toBe("offline");
		const badge = section?.querySelector("[data-device-offline]");
		expect(badge?.textContent).toBe(translate("remote.state.offline"));
		expect(badge?.getAttribute("title")).toBe(translate("remote.sidebar.offline"));
		expect(section?.querySelector("[data-device-session]")).toBeNull();
		expect(omp.sessions.list).not.toHaveBeenCalledWith("global", "dev-studio");
		expect(section?.querySelector('[data-sidebar-device-add="dev-studio"]')?.getAttribute("disabled")).not.toBeNull();
	});

	it("puts the host's no-project sessions in its Chats section, by the host's own workspace, as the host does", async () => {
		const omp = installWithRemote();
		const work = session("/Users/kim/.omp/agent/sessions/-.omp-work/two.jsonl", "/Users/kim/.omp/work", {
			title: "Opened in the host's workspace",
			device: "dev-studio",
		});
		omp.sessions.list.mockImplementation(async (_scope, device) =>
			device === "dev-studio" ? [...REMOTE, work] : LIST,
		);
		omp.sidecar.defaultWorkspace.mockImplementation(async (device?: string) =>
			device === "dev-studio" ? "/Users/kim/.omp/work" : "/default/work",
		);
		seedStores();
		pairHost("online");
		await mount(<Sidebar />);

		const chats = () => container.querySelector('[data-sidebar-chats="dev-studio"]');
		expect(omp.sidecar.defaultWorkspace).toHaveBeenCalledWith("dev-studio");
		expect(chats()?.textContent).toContain("Opened in the host's workspace");
		expect(chats()?.textContent).not.toContain("Remote fix");
		expect(container.querySelector('[data-sidebar-device="dev-studio"] [data-device-group]')?.textContent).toContain(
			"Remote fix",
		);
	});

	describe("order", () => {
		function pairHosts(ids: readonly string[]): void {
			pairHost("online");
			const remote = useRemoteStore.getState().state;
			if (!remote) throw new Error("no remote state");
			useRemoteStore.getState().apply({
				...remote,
				hosts: ids.map(deviceId => ({ deviceId, name: deviceId.replace("dev-", ""), state: "offline" as const })),
			});
		}
		const order = () =>
			[...container.querySelectorAll("[data-device-slot]")].map(slot =>
				(slot as unknown as Element).getAttribute("data-device-slot"),
			);
		const header = (id: string) => container.querySelector(`[data-device-drag-handle="${id}"]`);
		async function altArrow(id: string, key: "ArrowUp" | "ArrowDown"): Promise<void> {
			const element = header(id) as unknown as Record<string, unknown>;
			const propsKey = Object.getOwnPropertyNames(element).find(name => name.startsWith("__reactProps$")) ?? "";
			const props = element[propsKey] as { onKeyDown: (event: unknown) => void };
			await act(async () =>
				props.onKeyDown({ key, altKey: true, shiftKey: false, preventDefault() {}, stopPropagation() {} }),
			);
			await flush();
		}

		it("shows the saved order, with a device it does not name after the named ones", async () => {
			installWithRemote();
			seedStores();
			useSidebarFolds.setState({ deviceOrder: ["dev-studio", LOCAL_DEVICE, "dev-unpaired"] });
			pairHosts(["dev-office", "dev-studio"]);
			await mount(<Sidebar />);

			expect(order()).toEqual(["dev-studio", LOCAL_DEVICE, "dev-office"]);
			// The unpaired device leaves the saved order once the host list says it is gone.
			expect(useSidebarFolds.getState().deviceOrder).toEqual(["dev-studio", LOCAL_DEVICE]);
		});

		it("moves a section from its header menu and with Alt+arrows, and remembers it", async () => {
			const omp = installWithRemote();
			seedStores();
			pairHosts(["dev-studio"]);
			await mount(<Sidebar />);
			expect(order()).toEqual([LOCAL_DEVICE, "dev-studio"]);

			await fire(header("dev-studio"), "onContextMenu");
			expect(menuItemLabels()).toEqual(["Move up", "Move down"]);
			const moveUp = [...document.body.querySelectorAll('[role="menuitem"]')].find(item =>
				(item.textContent ?? "").includes("Move up"),
			);
			await fire(moveUp as unknown as Element, "onClick");
			expect(order()).toEqual(["dev-studio", LOCAL_DEVICE]);
			expect(omp.prefs.set).toHaveBeenLastCalledWith(
				"sidebarFolds",
				expect.objectContaining({ deviceOrder: ["dev-studio", LOCAL_DEVICE] }),
			);

			await altArrow("dev-studio", "ArrowDown");
			expect(order()).toEqual([LOCAL_DEVICE, "dev-studio"]);
			// Past the edge nothing moves.
			await altArrow("dev-studio", "ArrowDown");
			expect(order()).toEqual([LOCAL_DEVICE, "dev-studio"]);
			expect(useSidebarFolds.getState().deviceOrder).toEqual([LOCAL_DEVICE, "dev-studio"]);
		});

		it("draws a remembered host above this device on the first frame, before the host list is read", async () => {
			installWithRemote();
			seedStores();
			useRemoteStore.getState().reset();
			useSidebarFolds.setState({
				deviceOrder: ["dev-studio", LOCAL_DEVICE],
				knownHosts: [{ id: "dev-studio", name: "studio" }],
			});
			await mount(<Sidebar />);

			// First frame: the host's header sits above this device's list, quietly waiting.
			expect(order()).toEqual(["dev-studio", LOCAL_DEVICE]);
			const section = container.querySelector('[data-sidebar-device="dev-studio"]');
			expect(section?.getAttribute("data-device-pending")).toBe("");
			expect(section?.querySelector("[data-sidebar-device-toggle]")?.textContent).toContain("studio");
			expect(container.querySelector('[data-sidebar-device-header="local"]')).not.toBeNull();
			const row = container.querySelector("[data-session-path]");

			// The first read fills the same section in place: nothing is added above or remounted.
			await act(async () => pairHosts(["dev-studio"]));
			await flush();
			expect(order()).toEqual(["dev-studio", LOCAL_DEVICE]);
			expect(
				container.querySelector('[data-sidebar-device="dev-studio"]')?.getAttribute("data-device-pending"),
			).toBeNull();
			expect(container.querySelector("[data-session-path]")).toBe(row);
		});

		it("shows a connecting host's last known rows without asking it, and keeps them when it comes online", async () => {
			const omp = installWithRemote();
			seedStores();
			sessionListFeed("global", "dev-studio").store.setState({ sessions: REMOTE, isLoading: false });
			pairHost("connecting");
			await mount(<Sidebar />);

			const section = container.querySelector('[data-sidebar-device="dev-studio"]');
			const row = section?.querySelector("[data-device-session]");
			expect(row?.textContent).toContain("Remote fix");
			expect(omp.sessions.list).not.toHaveBeenCalledWith("global", "dev-studio");

			await act(async () => pairHost("online"));
			await flush();
			expect(omp.sessions.list).toHaveBeenCalledWith("global", "dev-studio");
			expect(container.querySelector('[data-sidebar-device="dev-studio"] [data-device-session]')).toBe(row);
		});

		it("drops a remembered host the first read no longer lists, and remembers the hosts it does", async () => {
			installWithRemote();
			seedStores();
			useRemoteStore.getState().reset();
			useSidebarFolds.setState({
				deviceOrder: ["dev-gone", LOCAL_DEVICE],
				knownHosts: [{ id: "dev-gone", name: "old box" }],
			});
			await mount(<Sidebar />);
			expect(order()).toEqual(["dev-gone", LOCAL_DEVICE]);

			await act(async () => pairHosts(["dev-office"]));
			await flush();
			expect(order()).toEqual([LOCAL_DEVICE, "dev-office"]);
			expect(useSidebarFolds.getState().knownHosts).toEqual([{ id: "dev-office", name: "office", offline: true }]);
			expect(useSidebarFolds.getState().deviceOrder).toEqual([LOCAL_DEVICE]);
		});

		it("keeps this device's rows mounted when the first host is paired", async () => {
			installWithRemote();
			seedStores();
			await mount(<Sidebar />);
			const row = container.querySelector("[data-session-path]");
			expect(row).not.toBeNull();

			await act(async () => pairHosts(["dev-studio"]));
			await flush();
			expect(order()).toEqual([LOCAL_DEVICE, "dev-studio"]);
			// The same element, not a remount: focus, an open rename field and row state survive pairing.
			expect(container.querySelector("[data-session-path]")).toBe(row);
		});

		it("keeps the order across a relaunch", async () => {
			const omp = installWithRemote();
			seedStores();
			pairHosts(["dev-studio"]);
			await mount(<Sidebar />);
			await altArrow("dev-studio", "ArrowUp");
			const saved = omp.prefs.set.mock.calls.findLast(([key]) => key === "sidebarFolds")?.[1];
			expect(saved).toEqual(expect.objectContaining({ deviceOrder: ["dev-studio", LOCAL_DEVICE] }));

			await act(async () => root.unmount());
			container.remove();
			useSidebarFolds.getState().reset();
			omp.prefs.get.mockImplementation(async key => (key === "sidebarFolds" ? saved : null));
			await mount(<Sidebar />);
			expect(order()).toEqual(["dev-studio", LOCAL_DEVICE]);
		});
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

	it("closes and deletes a host's session from its row, naming the host and deleting it there", async () => {
		const omp = installWithRemote();
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
		});
		pairHost("online");
		await mount(<Sidebar />);

		const row = () => container.querySelector(`[data-device-session="${remotePath}"]`);
		expect(row()?.querySelectorAll("button[aria-label]:not([data-sidebar-row-menu])")).toHaveLength(0);
		await openRowMenu(row());
		expect(menuItem("Close session").hasAttribute("disabled")).toBe(false);
		await fire(menuItem("Delete"), "onClick");
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("Remote fix on studio");
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			b => (b.textContent ?? "").trim() === "Delete",
		) as unknown as Element;
		await fire(confirm, "onClick");
		expect(omp.sessions.delete).toHaveBeenCalledWith(remotePath, "dev-studio");
		expect(useTabsStore.getState().tabs.some(tab => tab.id === "tr")).toBe(false);
	});
});

describe("Sidebar archive and move", () => {
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

		await openRowMenu(rowFor("Session /work/alpha/one"));
		await fire(menuItem("Archive"), "onClick");
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
		await openRowMenu(archivedRow);
		expect(menuItemLabels()).not.toContain("Archive");
		await fire(menuItem("Restore"), "onClick");
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
		await fire(rowFor("Session /work/alpha/one"), "onContextMenu");
		expect(menuItem("Archive").hasAttribute("disabled")).toBe(true);
		expect(menuItem("Move to project…").hasAttribute("disabled")).toBe(true);
		expect(menuItem("Save diagnostic bundle").hasAttribute("disabled")).toBe(false);
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
			await act(async () =>
				useTabsStore.setState({
					openTab: original.openTab,
					switchTab: original.switchTab,
					splitTab: original.splitTab,
				}),
			);
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
		// A pane is not "open elsewhere": it is on screen. The open tab elsewhere is said in words only (tooltip,
		// screen-reader text): no dot leads a row.
		const open = translate("sidebar.row.open");
		expect(rowFor("Pane A").textContent).not.toContain(open);
		expect(rowFor("Outside D").textContent).toContain(open);
		expect(rowFor("Outside D").querySelector("[data-sidebar-session-icon], [data-sidebar-row-end] svg")).toBeNull();
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
			await act(async () => useTabsStore.setState({ openTab: original.openTab, switchTab: original.switchTab }));
		}
	});
});

describe("Sidebar worktree sessions", () => {
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

	const openTab = (id: string, cwd: string, sessionPath: string) =>
		useTabsStore.setState(state => ({
			tabs: [...state.tabs, { id, cwd, status: "ready", kind: "agent", unreadDone: false, sessionPath }] as never,
		}));

	const rowsOf = (group: string) =>
		[...container.querySelectorAll(`[data-session-group="${group}"] .omp-sidebar-session-row`)].map(row => ({
			text: row.textContent ?? "",
			mark: row.querySelector("[data-sidebar-worktree]")?.getAttribute("data-sidebar-worktree") ?? null,
			tooltip: row.querySelector("button[title]")?.getAttribute("title") ?? "",
			child: row.getAttribute("data-session-run-child") === "true",
		}));

	it("lists a worktree's sessions among its project's own rows, each marked by what it is for", async () => {
		mountWithWorktrees();
		// A parallel child no opener row holds stays a row while a tab holds it.
		openTab("tch", CHILD, "/wt/child.jsonl");
		await mount(<Sidebar />);

		// No group of their own: the project's group is the only one alpha has.
		const groups = [...container.querySelectorAll("[data-workspace-group]")].map(element =>
			(element as unknown as Element).getAttribute("data-workspace-group"),
		);
		expect(groups).not.toContain(AUTOPILOT);
		expect(groups).not.toContain(CHILD);
		expect(groups).not.toContain("/work/alpha#agent");

		// In the project's order (newest first), the worktree rows among the others.
		const rows = rowsOf("/work/alpha").filter(row => !row.text.includes("New session"));
		expect(rows.map(row => row.text)).toEqual([
			expect.stringContaining("Cycle 3"),
			expect.stringContaining("Approach A"),
			expect.stringContaining("Session /work/alpha/one"),
			expect.stringContaining("Session /work/alpha/two"),
		]);
		expect(rows.map(row => row.mark)).toEqual(["autopilot", "agent", null, null]);
		expect(rows[0]?.tooltip).toContain("Autopilot");
		expect(rows[1]?.tooltip).toContain("Parallel work");
		// The folder names stay out of the sidebar.
		expect(container.textContent).not.toContain("gui-2026");
		expect(container.textContent).not.toContain("gui-agent");
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
		openTab("ta", CHILD, "/wt/a.jsonl");
		openTab("tb", CHILD_B, "/wt/b.jsonl");
		await mount(<Sidebar />);
		const rows = rowsOf("/work/alpha").map(row => row.text);
		expect(rows.some(text => text.includes("Approach A"))).toBe(true);
		expect(rows.some(text => text.includes("Approach B"))).toBe(true);
		expect(rows.some(text => text.includes("Approach C"))).toBe(false);
		expect(container.textContent).not.toContain("gui-agent");
	});

	it("keeps a discarded worktree's session while a tab holds it, a paired device's tab here included", async () => {
		const DISCARDED = "/home/me/.omp/wt/h1/gui-agent-c3d4e5-0a1b2c3";
		const omp = installMockOmp([
			session("/wt/hosted.jsonl", DISCARDED, { title: "Held by the device", created: "2026-02-02T00:00:00Z" }),
			session("/wt/local.jsonl", DISCARDED, { title: "Held here", created: "2026-02-01T00:00:00Z" }),
			...LIST,
		]);
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(async (cwds: string[]) =>
				Object.fromEntries(
					cwds.map(cwd => [
						cwd,
						cwd === "/work/alpha" ? { project: "alpha", root: "/work/alpha", worktree: null } : null,
					]),
				),
			),
		};
		seedStores();
		openTab("tl", DISCARDED, "/wt/local.jsonl");
		useHostedSessionsStore.setState({
			sessions: [
				{ sessionPath: "/wt/hosted.jsonl", cwd: DISCARDED, kind: "agent", status: "exited", device: "Mac" },
			],
		});
		await mount(<Sidebar />);
		const rows = [...container.querySelectorAll(".omp-sidebar-session-row")].map(row => row.textContent ?? "");
		expect(rows.some(text => text.includes("Held by the device"))).toBe(true);
		expect(rows.some(text => text.includes("Held here"))).toBe(true);
	});

	it("names the group after the project, not the worktree, when only worktree sessions exist", async () => {
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
		expect(container.querySelector(`[data-workspace-group="${AUTOPILOT}"]`)).toBeNull();
		const header = container.querySelector('[data-workspace-group="/elsewhere/beta"]');
		expect(header?.textContent?.trim()).toBe("beta");
		// A new session from its + starts in the project's own checkout.
		expect(header?.querySelector("[data-sidebar-group-new]")?.getAttribute("data-sidebar-group-new")).toBe(
			"/elsewhere/beta",
		);
		await act(async () => {
			(header?.querySelector("button[aria-expanded]") as unknown as HTMLButtonElement | null)?.click();
		});
		expect(rowsOf("/elsewhere/beta").map(row => row.mark)).toEqual(["autopilot"]);
	});

	it("puts a worktree's session in its project's group when the project's folder is spelled through a symlink", async () => {
		// macOS: the session says /var/…, git's main checkout (realpath'd) is /private/var/…; a subfolder keeps its own group.
		const omp = installMockOmp([
			session("/wt/auto.jsonl", AUTOPILOT, { title: "Cycle 3", created: "2026-02-03T00:00:00Z" }),
			session("/var/w/alpha/mine.jsonl", "/var/w/alpha", { title: "Own row" }),
			session("/var/w/alpha/sub/s.jsonl", "/var/w/alpha/sub", { title: "Sub row" }),
		]);
		const real = { project: "alpha", root: "/private/var/w/alpha", worktree: null };
		(omp as unknown as Record<string, unknown>).projectOrigins = {
			get: vi.fn(async (cwds: string[]) =>
				Object.fromEntries(
					cwds.map(cwd => [
						cwd,
						cwd === AUTOPILOT
							? {
									project: "alpha",
									root: "/private/var/w/alpha",
									worktree: { kind: "autopilot", branch: "autopilot/x", slug: "x" },
								}
							: cwd.startsWith("/var/w/alpha")
								? real
								: null,
					]),
				),
			),
		};
		seedStores();
		useSessionStore.setState({ cwd: "/var/w/alpha" });
		await mount(<Sidebar />);
		const groups = [...container.querySelectorAll("[data-workspace-group]")].map(element =>
			(element as unknown as Element).getAttribute("data-workspace-group"),
		);
		expect(groups).not.toContain("/private/var/w/alpha");
		expect(groups).toContain("/var/w/alpha/sub");
		expect(rowsOf("/var/w/alpha").map(row => row.text)).toEqual([
			expect.stringContaining("Cycle 3"),
			expect.stringContaining("Own row"),
		]);
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
		for (const folder of [AUTOPILOT, DOCS, TESTS, BUGS]) expect(groups).not.toContain(folder);
		expect(container.textContent).not.toMatch(/c2-docs|c3-bugs|c2-tests/);

		// In the project's group: the run's row where its recency puts it, its children right under it, newest first,
		// one step in and with no mark of their own; then the project's older rows.
		const rows = rowsOf("/work/alpha").filter(row => !row.text.includes("New session"));
		expect(rows.map(row => row.child)).toEqual([false, true, true, true, false, false]);
		expect(rows[0]?.text).toContain("Cycle 3");
		expect(rows[0]?.mark).toBe("autopilot");
		expect(rows[1]?.text).toContain("Fix the flaky upload test");
		expect(rows[2]?.text).toContain("Cover the upload retry");
		expect(rows[3]?.text).toContain("Docs pass");
		expect(rows.slice(1, 4).map(row => row.mark)).toEqual([null, null, null]);
		expect(rows[4]?.text).toContain("Session /work/alpha/one");
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

	it("lists a session's own edits first in its ⋯ sheet, delete within the first screen, and no Open (the row's tap opens it)", async () => {
		installMockOmp(LIST);
		seedStores();
		document.documentElement.dataset.platform = "web";
		Object.assign(window, {
			matchMedia: (query: string) => ({
				matches: query === TOUCH_QUERY,
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
			// The touch sheet is a back layer (the system back gesture closes it).
			history: { pushState: () => {}, back: () => {} },
		});
		resetShellModeForTests();
		await mount(<Sidebar />);
		await fire(rowFor("Session /work/alpha/one")?.querySelector("[data-sidebar-row-menu]") ?? null, "onClick");
		expect(menuItemLabels().map(label => label.replace(/⌘.*$/, ""))).toEqual([
			"Rename session",
			"Pin to top",
			"Move to project…",
			"Archive",
			"Delete",
			"Open in new tab",
			"Open in split view",
			"Open in new window",
			"Hide from other agents",
			"Save diagnostic bundle",
			"Save diagnostic bundle (anonymized)",
			"Copy file path",
			"Show in folder",
		]);
	});
});

describe("Sidebar remembered folds", () => {
	const savedFolds = (omp: MockOmp) => omp.prefs.set.mock.calls.findLast(call => call[0] === "sidebarFolds")?.[1];

	it("saves a folded project, the Archived section and a host fold, and a relaunch reads them back", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useRemoteStore.getState().apply({
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [{ deviceId: "dev-studio", name: "studio", state: "online" }],
			forgotten: [],
		});
		await mount(<Sidebar />);
		expect(container.querySelector('[data-session-group="/work/alpha"]')).not.toBeNull();

		await fire(groupToggle("/work/alpha"), "onClick");
		await fire(container.querySelector("[data-sidebar-device-toggle='local']"), "onClick");
		await fire(container.querySelector("[data-sidebar-device-toggle='dev-studio']"), "onClick");
		expect(container.querySelector('[data-session-group="/work/alpha"]')).toBeNull();
		const saved = savedFolds(omp);
		expect(saved).toMatchObject({ groups: { "/work/alpha": true }, devices: { local: true, "dev-studio": true } });

		// A relaunch: the window is gone, the stores start empty, and the saved pref is read back.
		await act(async () => root.unmount());
		container.remove();
		useSidebarFolds.getState().reset();
		omp.prefs.get.mockImplementation(async key => (key === "sidebarFolds" ? saved : null));
		await mount(<Sidebar />);
		expect(useSidebarFolds.getState().groups).toEqual({ "/work/alpha": true });
		expect(container.querySelector("[data-sidebar-device-toggle='dev-studio']")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		// This device's list is folded under its header: no project group is listed at all.
		expect(container.querySelector("[data-workspace-group]")).toBeNull();
		expect(container.querySelector("[data-sidebar-device-toggle='local']")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
	});

	it("prunes the folds of folders, hosts and sessions that no longer exist once a live read lands", async () => {
		installMockOmp(LIST);
		seedStores();
		useRemoteStore.getState().apply({
			tailnet: "ready",
			host: {
				enabled: false,
				name: "laptop",
				port: null,
				addresses: [],
				listenError: null,
				peers: [],
				keepAwake: true,
				keepingAwake: false,
				usedBy: [],
			},
			hosts: [],
			forgotten: [],
		});
		const folds = useSidebarFolds.getState();
		folds.setGroupFolded("/work/alpha", false);
		folds.setGroupFolded("/work/removed", true);
		folds.setDeviceFolded("dev-unpaired", true);
		useSidebarSubagentsStore.setState({ expanded: new Set([LIST[0]?.path ?? "", "/s/deleted.jsonl", "tab:t0"]) });
		await mount(<Sidebar />);

		expect(useSidebarFolds.getState().groups).toEqual({ "/work/alpha": false });
		expect(useSidebarFolds.getState().devices).toEqual({});
		expect([...useSidebarSubagentsStore.getState().expanded]).toEqual([LIST[0]?.path ?? "", "tab:t0"]);
	});
});
