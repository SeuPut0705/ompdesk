/**
 * tabs store contract tests:
 * - boot GET_TABS reconciliation (initial sidecar = tab 0, never duplicated)
 * - switchTab snapshots the current tab's session-scoped slices (messages,
 *   session meta, todos, subagents, queue, model, composer draft), restores
 *   the target's bundle for instant paint, fires SET_ACTIVE_TAB BEFORE
 *   hydrate, then hydrates from the target sidecar
 * - closeTab keeps ≥1 tab and activates a neighbor when the active tab closes
 * - applyTabStatus stamps unreadDone on background run completion
 * - useSessionTabs completes the open-in-new-tab flow (pending session path
 *   applied on the tab's first ready push while active)
 *
 * Harness: linkedom + react-dom (same as use-rpc-events.test.tsx) — the hook
 * test needs React; store tests just reuse the globals.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentControlViewEvent } from "../../shared/agent-control";
import type {
	IpcSignIn,
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabStatusPayload,
} from "../../shared/ipc-types";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ModelInfo,
	RpcResponse,
	RpcSessionState,
	SubagentSnapshot,
	TodoPhase,
} from "../../shared/rpc-types";
import { readSplitNode, type SplitLayout, type SplitPlacement, splitTabIds } from "../../shared/split-layout";
import { attachTabSession, hydrateSession, hydrateTabSession, refreshSessionState } from "../hooks/use-rpc-events";
import { translate } from "../lib/i18n";
import { acceptsActiveTabEvents } from "../lib/tab-routing";
import { readUnreadMarks, UNREAD_MARKS_KEY } from "../lib/unread-marks";
import { routeCommands } from "../test-support/route-commands";
import { type ComposerStore, useComposerStore } from "./composer";
import { type ExtensionUiStore, useExtensionUiStore } from "./extension-ui";
import { useForkHandoffStore } from "./fork-handoff";
import { type MessagesStore, useMessagesStore } from "./messages";
import { useModelStore } from "./model";
import { usePlanApprovalStore } from "./plan-approval";
import { useQueueStore } from "./queue";
import { type SessionStore, useSessionStore } from "./session";
import { sessionRuntime, sessionRuntimeStore, setFocusedSessionRuntime } from "./session-runtime-context";
import { useSubagentsStore } from "./subagents";
import { ensureTabRuntime } from "./tab-runtime";
import {
	endTabSignIn,
	isTabClosed,
	pushTabExtensionUiRequest,
	restoreTabComposer,
	restoreTabExtensionUiRequests,
	type SessionTab,
	settleTabExtensionUiRequests,
	settleTabPlanApproval,
	tabChipLabel,
	tabDisplayTitle,
	useSessionTabs,
	useTabsStore,
} from "./tabs";
import { useToastStore } from "./toast";
import { useTodoStore } from "./todo";
import { useToolsStore } from "./tools";
import { useUiStore } from "./ui";

// A web page and the desktop differ in what the tabs store keeps (lib/unread-marks.ts); `webMode.on` picks one.
const webMode = vi.hoisted(() => ({ on: false }));
vi.mock("../web/runtime", () => ({ webRuntime: () => (webMode.on ? {} : null), setWebRuntime: () => {} }));

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function serverState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
		sessionId: "srv",
		sessionName: null,
		sessionFile: null,
		cwd: "/srv",
		isStreaming: false,
		isCompacting: false,
		contextUsage: null,
		messageCount: 0,
		queuedMessageCount: 0,
		planModeEnabled: false,
		todoPhases: [],
		...overrides,
	} as RpcSessionState;
}

function msg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function tabInfo(tabId: string, cwd: string, status: IpcTabInfo["status"] = "ready"): IpcTabInfo {
	return { tabId, cwd, status, kind: "agent" };
}

interface MockOmp {
	tabs: {
		list: Mock<() => Promise<IpcTabInfo[]>>;
		spawn: Mock<(payload: IpcSpawnTabPayload) => Promise<IpcSpawnTabResult | null>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
		setView: Mock<
			(tabId: string, ids: string[], split?: SplitLayout, remembered?: SplitLayout[]) => Promise<boolean>
		>;
	};
	events: {
		onTabStatus: Mock<(callback: (payload: IpcTabStatusPayload) => void) => () => void>;
	};
	rpc: {
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscriptPage: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
		switchSession: Mock<(sessionPath: string) => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
}

type TabStatusHandler = (payload: IpcTabStatusPayload) => void;

function installMockOmp(): { omp: MockOmp; emitTabStatus: TabStatusHandler } {
	let tabStatusHandler: TabStatusHandler = () => {};
	const omp: MockOmp = {
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => null),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
			setView: vi.fn(async () => true),
		},
		events: {
			onTabStatus: vi.fn((callback: TabStatusHandler) => {
				tabStatusHandler = callback;
				return () => {};
			}),
		},
		rpc: routeCommands({
			getState: vi.fn(async () => ok(serverState())),
			getTranscriptPage: vi.fn(async () => ok({ messages: [], totalMessages: 0 })),
			getSubagents: vi.fn(async () => ok({ subagents: [] })),
			getGoal: vi.fn(async () => ok({ enabled: false })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			switchSession: vi.fn(async () => ok({})),
			setSubagentSubscription: vi.fn(async () => ok({})),
		}),
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return { omp, emitTabStatus: payload => tabStatusHandler(payload) };
}

/** Seed two tabs without going through spawn: t0 active, t1 background. */
function seedTabs(active: "t0" | "t1" | "t2" = "t0"): void {
	useTabsStore.setState({
		tabs: [
			{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
			{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			{ kind: "agent", id: "t2", cwd: "/gamma", status: "ready", unreadDone: false },
		],
		activeTabId: active,
		bundles: new Map(),
	});
	for (const tabId of ["t0", "t1", "t2"]) ensureTabRuntime(tabId);
	setFocusedSessionRuntime(active);
}

/** Fill the live stores with t0's recognizable session state. */
function fillLiveStores(tag: string): void {
	useSessionStore.setState({
		sessionId: `s-${tag}`,
		sessionName: `Session ${tag}`,
		cwd: `/${tag}`,
		isStreaming: false,
		status: "ready",
		planModeEnabled: true,
		goal: { objective: `goal-${tag}` },
	});
	useMessagesStore.setState({ messages: [msg(`hello-${tag}`)] });
	useTodoStore.getState().setPhases([{ name: `phase-${tag}`, tasks: [] } as TodoPhase]);
	useQueueStore.setState({
		steering: [{ id: `q-${tag}`, text: `steer-${tag}`, editable: true, timestamp: 1 }],
		followUp: [],
	});
	useSubagentsStore.setState({
		subagents: new Map<string, SubagentSnapshot>([
			[`a-${tag}`, { id: `a-${tag}`, index: 1, agent: "worker", status: "running", lastUpdate: 1, kind: "sub" }],
		]),
	});
	useModelStore.setState({
		model: { provider: "p", id: `m-${tag}` } as ModelInfo,
		fastModeEnabled: true,
	});
	useComposerStore.getState().setDraft(`draft-${tag}`);
	useComposerStore
		.getState()
		.setImages([
			{ content: { type: "image", data: `image-${tag}`, mimeType: "image/png" }, preview: `preview-${tag}` },
		]);
	usePlanApprovalStore.getState().showProposal({
		planFilePath: `/plan-${tag}.md`,
		planContent: `plan-${tag}`,
		options: ["execute"],
	});
	usePlanApprovalStore.getState().setFeedback(`feedback-${tag}`);
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: `ui-${tag}`,
		method: "confirm",
		title: `Confirm ${tag}`,
		message: `Message ${tag}`,
	});
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: `status-${tag}`,
		method: "setStatus",
		statusKey: `status-${tag}`,
		statusText: `Status ${tag}`,
	});
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: `widget-${tag}`,
		method: "setWidget",
		widgetKey: `widget-${tag}`,
		widgetLines: [`Widget ${tag}`],
	});
}

let omp: MockOmp;
let emitTabStatus: TabStatusHandler;

function resetAll(): void {
	useTabsStore.getState().reset();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useTodoStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSubagentsStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	usePlanApprovalStore.getState().clearProposal();
	useExtensionUiStore.getState().clearAll();
	useUiStore.getState().closeSessionOverlays();
	useUiStore.getState().closeDestination();
	useForkHandoffStore.getState().closeHandoffDialog();
}

afterEach(() => {
	resetAll();
	vi.restoreAllMocks();
	({ omp, emitTabStatus } = installMockOmp());
});

({ omp, emitTabStatus } = installMockOmp());

describe("tabs store boot reconciliation", () => {
	it("adopts the window's initial sidecar as tab 0 and never duplicates it", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);

		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");

		// Reconcile again (and after a status push that pre-created the entry):
		// merge is by tabId, so the initial sidecar appears exactly once.
		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().tabs).toHaveLength(1);

		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", title: "Alpha" });
		await useTabsStore.getState().reconcileTabs();
		const tabs = useTabsStore.getState().tabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.title).toBe("Alpha");
	});

	it("keeps renderer-known tabs the reply misses and re-converges active on reload", async () => {
		seedTabs("t1");
		// Main knows only two of three tabs (the third spawned mid-reply).
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta")]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1", "t2"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		// >1 tabs after a renderer reload: main re-converges to the renderer's pick.
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
	});

	it("restores main's persisted active tab when renderer state is empty", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), { ...tabInfo("t1", "/beta"), active: true }]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
	});

	it("retains the restored transcript path before session metadata arrives", async () => {
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/alpha"), sessionPath: "/sessions/restored.jsonl", active: true },
		]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs[0]).toMatchObject({
			id: "t0",
			sessionPath: "/sessions/restored.jsonl",
		});
	});

	it("invalidates a parked bundle when boot reconciliation observes a replacement session", async () => {
		seedTabs();
		fillLiveStores("old");
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "ready",
			title: "Old",
			sessionId: "s-old",
		});
		await useTabsStore.getState().switchTab("t1");
		const oldRuntime = sessionRuntime("t0");
		expect(oldRuntime).not.toBeNull();
		omp.tabs.list.mockResolvedValue([
			{ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", title: null, sessionId: "s-new" },
			tabInfo("t1", "/beta"),
			tabInfo("t2", "/gamma"),
		]);

		await useTabsStore.getState().reconcileTabs();

		expect(sessionRuntime("t0")).not.toBe(oldRuntime);
		expect(useTabsStore.getState().tabs[0]).toMatchObject({ sessionId: "s-new", title: undefined });
	});

	it("forgets a background tab's deleted session: no file, id or title survives", () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t1",
			cwd: "/beta",
			status: "asleep",
			sessionPath: "/sessions/beta.jsonl",
			sessionId: "s-beta",
			title: "Beta title",
		});
		// Main reports the tab holds no session file any more.
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "asleep", sessionPath: null });
		const tab = useTabsStore.getState().tabs.find(entry => entry.id === "t1");
		expect(tab).toMatchObject({ sessionPath: undefined, sessionId: undefined, title: undefined });
	});

	it("retains unsent input when restarting an unpersisted session changes its identity", () => {
		seedTabs();
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "before-restart" });
		useComposerStore.getState().setDraft("unsent recovery draft");
		useComposerStore.getState().setSubmissionUncertain(true);
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "starting",
			sessionId: "before-restart",
		});
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "after-restart" });
		expect(useComposerStore.getState()).toMatchObject({
			draft: "unsent recovery draft",
			sending: false,
			submissionUncertain: true,
		});
	});

	it("keeps the draft when a snapshot of the process being restarted lands during the restart", async () => {
		seedTabs();
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "before-restart" });
		useComposerStore.getState().setDraft("unsent recovery draft");
		// A hydration of the old process (a large transcript after a turn ends) is still in flight.
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		const stale = hydrateTabSession("t0");
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "starting",
			sessionId: "before-restart",
		});
		// The new process's ready must fetch afresh, never join the old process's read.
		const newState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(newState.promise);
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "before-restart" });
		const fresh = attachTabSession("t0");
		oldState.resolve(ok(serverState({ sessionId: "before-restart" })));
		await stale;
		expect(omp.rpc.getState).toHaveBeenCalledTimes(2);
		// Main pushes the id the new process reports before it hands that get_state back.
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "after-restart" });
		newState.resolve(ok(serverState({ sessionId: "after-restart" })));
		await fresh;
		expect(useComposerStore.getState().draft).toBe("unsent recovery draft");
	});

	it("keeps the draft when an agent_start re-sync of the process being restarted lands during the restart", async () => {
		seedTabs();
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "before-restart" });
		useSessionStore.setState({ sessionId: "before-restart" });
		useComposerStore.getState().setDraft("unsent recovery draft");
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		const stale = refreshSessionState("t0");
		// TAB_STATUS starting lands before the full status channel resets the session store.
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "starting",
			sessionId: "before-restart",
		});
		oldState.resolve(ok(serverState({ sessionId: "before-restart" })));
		await stale;
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "after-restart" });
		expect(useComposerStore.getState().draft).toBe("unsent recovery draft");
	});

	it("keeps the draft when a runtime-less hydration of the process being restarted lands during the restart", async () => {
		// Boot race: the active tab has no runtime yet, so hydration takes the legacy path.
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", sessionId: "before-restart", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		setFocusedSessionRuntime("t0");
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		const stale = hydrateSession();
		expect(sessionRuntime("t0")).toBeNull();
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "starting",
			sessionId: "before-restart",
		});
		useComposerStore.getState().setDraft("unsent recovery draft");
		oldState.resolve(ok(serverState({ sessionId: "before-restart" })));
		await stale;
		expect(useSessionStore.getState().sessionId).toBe("");
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready", sessionId: "after-restart" });
		expect(useComposerStore.getState().draft).toBe("unsent recovery draft");
	});
});

describe("tabs store switch", () => {
	it("openTab spawns in the current cwd, registers the tab, and switches to it", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		useSessionStore.setState({ cwd: "/alpha" });
		omp.tabs.spawn.mockResolvedValue({ tabId: "t1" });

		const tabId = await useTabsStore.getState().openTab();

		expect(tabId).toBe("t1");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({ cwd: "/alpha", sessionPath: undefined, kind: "agent" });
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
	});

	it("opens Work as an agent in the main-owned default workspace", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		useSessionStore.setState({ cwd: "/alpha" });
		omp.tabs.spawn.mockResolvedValue({ tabId: "t-work", cwd: "/Users/test/.omp/work" });

		const tabId = await useTabsStore.getState().openTab({ work: true });

		expect(tabId).toBe("t-work");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: undefined,
			sessionPath: undefined,
			kind: "agent",
			defaultWorkspace: true,
			worktree: undefined,
		});
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t-work")?.cwd).toBe("/Users/test/.omp/work");
	});

	it("hydrates a fresh tab when its ready push beats full route wiring", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		useSessionStore.setState({ cwd: "/alpha", status: "ready" });
		omp.tabs.spawn.mockResolvedValue({ tabId: "t1" });
		const route = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(route.promise);

		const opening = useTabsStore.getState().openTab({ kind: "chat" });
		await Promise.resolve();
		await Promise.resolve();
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");

		// The light per-tab channel reports ready before main finishes attaching
		// the full active-tab channel, so no full ready event will replay.
		useTabsStore.getState().applyTabStatus({ kind: "chat", tabId: "t1", cwd: "/alpha", status: "ready" });
		route.resolve(true);
		await opening;

		expect(useSessionStore.getState().status).toBe("ready");
		expect(useSessionStore.getState().sessionId).toBe("srv");
		expect(omp.rpc.getState).toHaveBeenCalled();
	});

	it("keeps shortcuts live when a new tab opens while the boot reconcile's route is in flight", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		const bootRoute = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(bootRoute.promise);
		const booting = useTabsStore.getState().reconcileTabs();
		await vi.waitFor(() => expect(omp.tabs.setActive).toHaveBeenCalledWith("t0"));

		// ⌘T lands before main answers the boot route: the switch to t1 begins behind it.
		omp.tabs.spawn.mockResolvedValue({ tabId: "t1" });
		const opening = useTabsStore.getState().openTab();
		await vi.waitFor(() => expect(useTabsStore.getState().activeTabId).toBe("t1"));
		expect(acceptsActiveTabEvents()).toBe(false);

		bootRoute.resolve(true);
		await booting;
		await opening;

		expect(omp.tabs.setActive).toHaveBeenLastCalledWith("t1");
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		// The switch settled on t1, so the keymap (which refuses chords while a route is unsettled) takes ⌘, again.
		expect(acceptsActiveTabEvents()).toBe(true);
	});

	it("reports a failed spawn as an error toast without mutating the tab list", async () => {
		seedTabs();
		omp.tabs.spawn.mockResolvedValue(null);

		const tabId = await useTabsStore.getState().openTab();

		expect(tabId).toBeNull();
		expect(useTabsStore.getState().tabs).toHaveLength(3);
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(true);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(omp.tabs.setActive).not.toHaveBeenCalledWith("t5");
	});

	it("surfaces a kind-mismatch refusal as an error toast and adds no tab", async () => {
		seedTabs();
		omp.tabs.spawn.mockResolvedValue({ tabId: null, refusal: "kind-mismatch" });

		const tabId = await useTabsStore.getState().openTab({ sessionPath: "/sessions/agent.jsonl", kind: "chat" });

		expect(tabId).toBeNull();
		expect(useTabsStore.getState().tabs).toHaveLength(3);
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(true);
		expect(omp.tabs.setActive).not.toHaveBeenCalledWith("t5");
	});

	it("an owned refusal naming a tab of this window it has not listed yet switches to that tab, never asks for another window", async () => {
		// A web page's open: its own window already holds the session (a tab main restored while the page loaded).
		seedTabs();
		const openInNewWindow = vi.fn(async () => true);
		Object.assign(omp, { sessions: { openInNewWindow } });
		omp.tabs.spawn.mockResolvedValue({ tabId: null, refusal: "owned", ownerTabId: "t9", ownerWinId: -1 });
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/alpha"), active: true, visible: true },
			tabInfo("t1", "/beta"),
			tabInfo("t2", "/gamma"),
			{ ...tabInfo("t9", "/delta"), sessionPath: "/sessions/held.jsonl" },
		]);

		const tabId = await useTabsStore.getState().openTab({ sessionPath: "/sessions/held.jsonl" });

		expect(tabId).toBe("t9");
		expect(useTabsStore.getState().activeTabId).toBe("t9");
		expect(openInNewWindow).not.toHaveBeenCalled();
		expect(omp.tabs.spawn).toHaveBeenCalledTimes(1);
	});

	it("fires SET_ACTIVE_TAB before hydrating from the target sidecar", async () => {
		seedTabs();

		await useTabsStore.getState().switchTab("t1");

		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
		expect(omp.rpc.getState).toHaveBeenCalled();
		const setActiveOrder = omp.tabs.setActive.mock.invocationCallOrder[0];
		const getStateOrder = omp.rpc.getState.mock.invocationCallOrder[0];
		expect(setActiveOrder).toBeDefined();
		expect(getStateOrder).toBeDefined();
		expect(setActiveOrder!).toBeLessThan(getStateOrder!);
	});

	it("closes outgoing session overlays while keeping the open destination page", async () => {
		seedTabs();
		useUiStore.getState().openActiveTools();
		useUiStore.getState().openModes("goal");
		useUiStore.getState().openInsights("usage");
		useForkHandoffStore.getState().openHandoffDialog();

		await useTabsStore.getState().switchTab("t1");

		expect(useUiStore.getState().activeToolsOpen).toBe(false);
		expect(useUiStore.getState().modesOpen).toBe(false);
		expect(useForkHandoffStore.getState().handoffDialogOpen).toBe(false);
		expect(useUiStore.getState().destination).toBe("insights");
		expect(useUiStore.getState().insightsTab).toBe("usage");
	});

	it("serializes rapid switches and hydrates only the latest visible tab", async () => {
		seedTabs();
		const firstRoute = Promise.withResolvers<boolean>();
		const secondRoute = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(firstRoute.promise).mockReturnValueOnce(secondRoute.promise);

		const firstSwitch = useTabsStore.getState().switchTab("t1");
		const secondSwitch = useTabsStore.getState().switchTab("t2");
		await Promise.resolve();

		// UI selection remains immediate even while main-process routing catches up.
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(acceptsActiveTabEvents()).toBe(false);
		expect(omp.tabs.setActive).toHaveBeenCalledTimes(1);

		firstRoute.resolve(true);
		await firstSwitch;
		expect(omp.tabs.setActive).toHaveBeenCalledTimes(2);
		// The superseded t1 route must not hydrate into t2's visible stores.
		expect(acceptsActiveTabEvents()).toBe(false);
		expect(omp.rpc.getState).not.toHaveBeenCalled();

		secondRoute.resolve(true);
		await Promise.all([firstSwitch, secondSwitch]);

		expect(omp.tabs.setActive.mock.calls.map(call => call[0])).toEqual(["t1", "t2"]);
		expect(omp.rpc.getState).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(acceptsActiveTabEvents()).toBe(true);
	});

	it("snapshots the current tab's slices and restores the target's — draft included", async () => {
		seedTabs();
		fillLiveStores("t0");

		// Gate the transcript so the restored (pre-hydrate) state is observable.
		const gate = Promise.withResolvers<RpcResponse>();
		omp.rpc.getTranscriptPage.mockReturnValueOnce(gate.promise);
		const firstSwitch = useTabsStore.getState().switchTab("t1");

		// t1 has no bundle: stores reset to empty instantly, before any RPC settles.
		expect(useComposerStore.getState().draft).toBe("");
		expect(useComposerStore.getState().images).toEqual([]);
		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(useSessionStore.getState().sessionId).toBe("");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
		expect(useExtensionUiStore.getState().statusWidgets).toEqual({});

		gate.resolve(ok({ messages: [msg("server-t1")] }));
		await firstSwitch;

		// Hydrate applied the target sidecar's state; the (empty) draft is untouched.
		expect(useSessionStore.getState().sessionId).toBe("srv");
		expect(useMessagesStore.getState().messages.map(m => messageText(m))).toEqual(["server-t1"]);

		// t0's bundle is parked; t1 now gets its own recognizable live state.
		fillLiveStores("t1");
		pushTabExtensionUiRequest("t0", {
			type: "extension_ui_request",
			id: "ui-t0-late",
			method: "confirm",
			title: "Late t0 request",
			message: "Still belongs to t0",
		});
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["ui-t1"]);
		const gate2 = Promise.withResolvers<RpcResponse>();
		omp.rpc.getTranscriptPage.mockReturnValueOnce(gate2.promise);
		const secondSwitch = useTabsStore.getState().switchTab("t0");

		// Instant restore of t0's parked bundle — every slice, before hydrate.
		expect(useComposerStore.getState().draft).toBe("draft-t0");
		expect(useComposerStore.getState().images[0]?.content.data).toBe("image-t0");
		expect(useMessagesStore.getState().messages.map(m => messageText(m))).toEqual(["hello-t0"]);
		expect(useSessionStore.getState().sessionId).toBe("s-t0");
		expect(useSessionStore.getState().sessionName).toBe("Session t0");
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
		expect(useSessionStore.getState().goal?.objective).toBe("goal-t0");
		expect(useTodoStore.getState().phases.map(phase => phase.name)).toEqual(["phase-t0"]);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["q-t0"]);
		expect(useSubagentsStore.getState().subagents.has("a-t0")).toBe(true);
		expect(useModelStore.getState().model?.id).toBe("m-t0");
		expect(useModelStore.getState().fastModeEnabled).toBe(true);
		expect(usePlanApprovalStore.getState().pending?.planContent).toBe("plan-t0");
		expect(usePlanApprovalStore.getState().feedback).toBe("feedback-t0");
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual([
			"ui-t0",
			"ui-t0-late",
		]);
		expect(useExtensionUiStore.getState().statusWidgets).toEqual({ "status-t0": "Status t0" });
		expect(useExtensionUiStore.getState().widgetPanels).toEqual({ "widget-t0": ["Widget t0"] });

		gate2.resolve(ok({ messages: [msg("hello-t0")] }));
		await secondSwitch;

		// Hydrate never touches the composer draft: t0's draft survives the switch.
		expect(useComposerStore.getState().draft).toBe("draft-t0");

		// …and t1's bundle parked its own draft, restored on the way back.
		await useTabsStore.getState().switchTab("t1");
		expect(useComposerStore.getState().draft).toBe("draft-t1");
		expect(useComposerStore.getState().images[0]?.content.data).toBe("image-t1");
		expect(usePlanApprovalStore.getState().pending?.planContent).toBe("plan-t1");
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["ui-t1"]);
	});

	it("settles an approval in its background tab without mutating the visible session", async () => {
		seedTabs();
		fillLiveStores("t0");
		const proposal = usePlanApprovalStore.getState().pending;
		expect(proposal).not.toBeNull();

		await useTabsStore.getState().switchTab("t1");
		fillLiveStores("t1");
		settleTabPlanApproval("t0", "s-t0", proposal!, { clear: true, exitPlanMode: true });

		expect(useSessionStore.getState().sessionId).toBe("s-t1");
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
		expect(usePlanApprovalStore.getState().pending?.planContent).toBe("plan-t1");

		await useTabsStore.getState().switchTab("t0");
		expect(useSessionStore.getState().planModeEnabled).toBe(false);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("restores a failed submit to its background tab without touching the visible composer", async () => {
		seedTabs();
		fillLiveStores("t0");
		await useTabsStore.getState().switchTab("t1");
		useComposerStore.getState().setDraft("visible-t1");

		restoreTabComposer("t0", "replaced-session", "stale-submit", []);
		restoreTabComposer("t0", "s-t0", "failed-t0", [
			{ content: { type: "image", data: "failed-image", mimeType: "image/png" }, preview: "failed-preview" },
		]);

		expect(useComposerStore.getState().draft).toBe("visible-t1");
		expect(useComposerStore.getState().images).toEqual([]);

		await useTabsStore.getState().switchTab("t0");
		// Joined like the abort and dequeue restores (`omp:fill-composer` prepend): a blank line between.
		expect(useComposerStore.getState().draft).toBe("failed-t0\n\ndraft-t0");
		expect(useComposerStore.getState().images.map(image => image.content.data)).toEqual(["failed-image", "image-t0"]);
	});

	it("paints a tab that ran in the background at its present, not the moment it was left", async () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "running" });
		omp.rpc.getTranscriptPage.mockResolvedValueOnce(ok({ messages: [msg("advanced")], totalMessages: 1 }));
		let painted: AgentMessage[] | undefined;
		const unsubscribe = useTabsStore.subscribe(state => {
			if (state.activeTabId !== "t1" || painted) return;
			painted = sessionRuntimeStore<MessagesStore>("t1", "messages")?.getState().messages ?? [];
		});
		await useTabsStore.getState().switchTab("t1");
		unsubscribe();
		expect(JSON.stringify(painted)).toContain("advanced");
	});

	it("paints a background-running tab from its entry when its present is slow, then refetches", async () => {
		seedTabs();
		// t1's run kept going in the background; the pool reported it.
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "running" });
		vi.useFakeTimers();
		try {
			const gate = Promise.withResolvers<RpcResponse>();
			omp.rpc.getTranscriptPage.mockReturnValueOnce(gate.promise);
			const switching = useTabsStore.getState().switchTab("t1");
			await vi.advanceTimersByTimeAsync(0);
			// Its present is on the way: the tab being left stays in view meanwhile.
			expect(useTabsStore.getState().activeTabId).toBe("t0");
			await vi.advanceTimersByTimeAsync(100);
			// The wait is short: the run paints live from the tab entry before get_state confirms it.
			expect(useTabsStore.getState().activeTabId).toBe("t1");
			expect(useSessionStore.getState().isStreaming).toBe(true);
			expect(useSessionStore.getState().status).toBe("ready");
			gate.resolve(ok({ messages: [] }));
			await switching;
			// Hydrate's get_state (mock: not streaming) is authoritative afterwards…
			expect(useSessionStore.getState().isStreaming).toBe(false);
			// …from a fetch begun after the route attached: the early one could miss events.
			expect(omp.rpc.getTranscriptPage).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stamps the outgoing tab's chip when it was streaming in the foreground", async () => {
		seedTabs();
		useSessionStore.setState({ isStreaming: true });

		await useTabsStore.getState().switchTab("t1");

		const t0 = useTabsStore.getState().tabs.find(tab => tab.id === "t0");
		expect(t0?.status).toBe("running");
	});

	it("surfaces a SET_ACTIVE_TAB failure, re-converges from GET_TABS, and hydrates after the retry", async () => {
		seedTabs();
		useToastStore.setState({ toasts: [] });
		omp.tabs.setActive.mockRejectedValueOnce(new Error("routing wedged"));
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);

		await useTabsStore.getState().switchTab("t1");

		// Surfaced, not swallowed…
		expect(useToastStore.getState().toasts.some(toast => toast.title === "Couldn't switch tab")).toBe(true);
		// …re-converged from GET_TABS — reconcile retries SET_ACTIVE_TAB for the
		// renderer's pick, so a transient failure re-points routing here…
		expect(omp.tabs.list).toHaveBeenCalled();
		expect(omp.tabs.setActive).toHaveBeenCalledTimes(2);
		// …then hydrate paints the target instead of leaving the restored empty
		// bundle on screen after the successful retry.
		expect(omp.rpc.getTranscriptPage).toHaveBeenCalledTimes(1);
	});

	it("treats a false SET_ACTIVE_TAB reply as a routing failure and recovers on retry", async () => {
		seedTabs();
		useToastStore.setState({ toasts: [] });
		omp.tabs.setActive.mockResolvedValueOnce(false);
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);

		await useTabsStore.getState().switchTab("t1");

		expect(useToastStore.getState().toasts.some(toast => toast.title === "Couldn't switch tab")).toBe(true);
		expect(omp.rpc.getTranscriptPage).toHaveBeenCalledTimes(1);
	});

	it("does not hydrate when both the tab route and reconciliation route fail", async () => {
		seedTabs();
		omp.tabs.setActive.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);

		await useTabsStore.getState().switchTab("t1");

		expect(omp.rpc.getTranscriptPage).not.toHaveBeenCalled();
	});
});

describe("tabs store close", () => {
	it("keeps the last tab open", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();

		await useTabsStore.getState().closeTab("t0");

		expect(useTabsStore.getState().tabs).toHaveLength(1);
		expect(omp.tabs.close).not.toHaveBeenCalled();
	});

	it("closing the active tab activates its right neighbor first, then releases", async () => {
		seedTabs("t1");

		await useTabsStore.getState().closeTab("t1");

		const state = useTabsStore.getState();
		expect(state.tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(state.activeTabId).toBe("t2");
		// Neighbor was activated BEFORE the release hit main.
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t2");
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		const setActiveOrder = omp.tabs.setActive.mock.invocationCallOrder[0];
		const closeOrder = omp.tabs.close.mock.invocationCallOrder[0];
		expect(setActiveOrder!).toBeLessThan(closeOrder!);
		// The closed tab's parked bundle is gone.
		expect(state.bundles.has("t1")).toBe(false);
	});

	it("closing the last tab in the strip activates its left neighbor", async () => {
		seedTabs("t2");

		await useTabsStore.getState().closeTab("t2");

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
	});

	it("closing a background tab leaves the active tab attached", async () => {
		seedTabs("t0");

		await useTabsStore.getState().closeTab("t1");

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(omp.tabs.setActive).not.toHaveBeenCalledWith("t5");
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
	});

	it("asks before closing the tab that owns unsaved Files edits, and closes it once they are discarded", async () => {
		seedTabs("t0");
		useUiStore.setState({ fileEditDirty: true, fileEditTabId: "t1", pendingFileSwitch: null });
		try {
			await useTabsStore.getState().closeTab("t1");
			expect(omp.tabs.close).not.toHaveBeenCalled();
			expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1", "t2"]);
			expect(useUiStore.getState().pendingFileSwitch).toEqual({ discardedForTabClose: "t1" });

			// Another tab closes as usual: the edits are not its own.
			await useTabsStore.getState().closeTab("t2");
			expect(omp.tabs.close).toHaveBeenCalledWith("t2");

			// Cancel drops the request and keeps the edits and the tab.
			useUiStore.getState().resolveFileSwitch(false);
			expect(useUiStore.getState()).toMatchObject({
				pendingFileSwitch: null,
				discardedForTabClose: null,
				fileEditDirty: true,
			});

			await useTabsStore.getState().closeTab("t1");
			useUiStore.getState().resolveFileSwitch(true);
			expect(useUiStore.getState()).toMatchObject({ discardedForTabClose: "t1", fileEditDirty: false });
		} finally {
			useUiStore.setState({
				fileEditDirty: false,
				fileEditTabId: null,
				pendingFileSwitch: null,
				discardedForTabClose: null,
			});
		}
	});

	it("remembers saved sessions it closes and reopens the most recent one where it ran", async () => {
		seedTabs("t0");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab =>
				tab.id === "t1"
					? { ...tab, sessionPath: "/s/beta.jsonl", title: "Beta plan", device: "host-b" }
					: tab.id === "t2"
						? { ...tab, sessionPath: "/s/gamma.jsonl", kind: "chat" }
						: tab,
			),
		}));
		await useTabsStore.getState().closeTab("t1");
		await useTabsStore.getState().closeTab("t2");
		expect(useTabsStore.getState().closedTabs.map(tab => tab.sessionPath)).toEqual([
			"/s/beta.jsonl",
			"/s/gamma.jsonl",
		]);

		omp.tabs.spawn.mockResolvedValue({ tabId: "t9", cwd: "/gamma" });
		expect(await useTabsStore.getState().reopenClosedTab()).toBe("t9");
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith({ sessionPath: "/s/gamma.jsonl", kind: "chat" });
		expect(useTabsStore.getState().closedTabs.map(tab => tab.sessionPath)).toEqual(["/s/beta.jsonl"]);

		omp.tabs.spawn.mockResolvedValue({ tabId: "t8", cwd: "/beta" });
		await useTabsStore.getState().reopenClosedTab();
		expect(omp.tabs.spawn).toHaveBeenLastCalledWith({
			cwd: "/beta",
			sessionPath: "/s/beta.jsonl",
			kind: "agent",
			device: "host-b",
		});
	});

	it("forgets an unsaved session on close and says so when nothing is left to reopen", async () => {
		seedTabs("t0");
		useToastStore.setState({ toasts: [] });
		await useTabsStore.getState().closeTab("t1");
		expect(useTabsStore.getState().closedTabs).toEqual([]);
		expect(await useTabsStore.getState().reopenClosedTab()).toBeNull();
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual(["No closed tab to reopen"]);
	});

	it("keeps a reopen entry when the reopen fails so the user can retry", async () => {
		seedTabs("t0");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, sessionPath: "/s/beta.jsonl" } : tab)),
		}));
		await useTabsStore.getState().closeTab("t1");
		omp.tabs.spawn.mockResolvedValue(null);
		expect(await useTabsStore.getState().reopenClosedTab()).toBeNull();
		expect(useTabsStore.getState().closedTabs.map(tab => tab.sessionPath)).toEqual(["/s/beta.jsonl"]);
	});

	it("a deleted session's tab closes like a closed tab, and the closed-tab history forgets the session", async () => {
		seedTabs("t0");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, sessionPath: "/s/beta.jsonl" } : tab)),
			closedTabs: [
				{ sessionPath: "/s/beta.jsonl", cwd: "/beta", kind: "agent" },
				{ sessionPath: "/s/kept.jsonl", cwd: "/kept", kind: "agent" },
			],
		}));

		expect(await useTabsStore.getState().closeDeletedSession("/s/beta.jsonl", "t1")).toBe(true);
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		// No session takes its place, and ⇧⌘T cannot bring the deleted one back.
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
		expect(useTabsStore.getState().closedTabs.map(tab => tab.sessionPath)).toEqual(["/s/kept.jsonl"]);

		// A stored session no tab holds: only the history forgets it.
		expect(await useTabsStore.getState().closeDeletedSession("/s/kept.jsonl", undefined)).toBe(true);
		expect(useTabsStore.getState().closedTabs).toEqual([]);
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
	});

	it("the window's last tab gives way to the empty start tab, not to a new session", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		useTabsStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, sessionPath: "/s/alpha.jsonl" })) }));
		omp.tabs.spawn.mockResolvedValue({ tabId: "start", cwd: "/work" });

		expect(await useTabsStore.getState().closeDeletedSession("/s/alpha.jsonl", "t0")).toBe(true);
		expect(omp.tabs.spawn).toHaveBeenCalledWith({ kind: "agent", defaultWorkspace: true, placeholder: true });
		const state = useTabsStore.getState();
		expect(state.tabs).toEqual([expect.objectContaining({ id: "start", placeholder: true })]);
		expect(state.activeTabId).toBe("start");
		expect(omp.tabs.close).toHaveBeenCalledWith("t0");
	});

	it("keeps a deleted session's tab whose unsaved Files edits ask first, so nothing may be deleted", async () => {
		seedTabs("t0");
		useUiStore.setState({ fileEditDirty: true, fileEditTabId: "t1", pendingFileSwitch: null });
		try {
			expect(await useTabsStore.getState().closeDeletedSession("/s/beta.jsonl", "t1")).toBe(false);
			expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1", "t2"]);
			expect(isTabClosed("t1")).toBe(false);
			expect(omp.tabs.close).not.toHaveBeenCalled();
		} finally {
			useUiStore.setState({
				fileEditDirty: false,
				fileEditTabId: null,
				pendingFileSwitch: null,
				discardedForTabClose: null,
			});
		}
	});

	it("drops a tab main closed because its session was deleted elsewhere, as its own close", async () => {
		seedTabs("t1");
		useToastStore.setState({ toasts: [] });
		const left = [tabInfo("t0", "/alpha"), tabInfo("t2", "/gamma")];
		// Main already released it: its close answers false and its list no longer names it.
		omp.tabs.close.mockResolvedValue(false);
		omp.tabs.list.mockResolvedValue(left);

		await useTabsStore.getState().applyTabList(left, ["t1"]);
		const state = useTabsStore.getState();
		expect(state.tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(state.activeTabId).toBe("t2");
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});

describe("tabs store close races and failures", () => {
	const mainTabs = () => [tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")];

	it("does not revive a closing tab when a reconcile lands before main released it, and drops its runtime once released", async () => {
		seedTabs("t0");
		const release = Promise.withResolvers<boolean>();
		omp.tabs.close.mockReturnValue(release.promise);
		// Main still lists t1 until its release completes.
		omp.tabs.list.mockResolvedValue(mainTabs().map(info => ({ ...info, active: info.tabId === "t0" })));

		const closing = useTabsStore.getState().closeTab("t1");
		await vi.waitFor(() => expect(omp.tabs.close).toHaveBeenCalledWith("t1"));
		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		// Kept, hidden, until main answers: a refused close brings the tab back as it was.
		expect(sessionRuntime("t1")).not.toBeNull();

		release.resolve(true);
		await closing;
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(sessionRuntime("t1")).toBeNull();
	});

	it("does not let a reconcile bring a closing tab back through the split main still reports", async () => {
		seedTabs("t0");
		const release = Promise.withResolvers<boolean>();
		omp.tabs.close.mockReturnValue(release.promise);
		const split: SplitLayout = { axis: "columns", ratio: 0.5, first: { tabId: "t0" }, second: { tabId: "t1" } };
		omp.tabs.list.mockResolvedValue(
			mainTabs().map(info => ({
				...info,
				active: info.tabId === "t0",
				visible: info.tabId !== "t2",
				split,
			})),
		);

		const closing = useTabsStore.getState().closeTab("t1");
		await vi.waitFor(() => expect(omp.tabs.close).toHaveBeenCalledWith("t1"));
		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().split).toBeNull();
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		release.resolve(true);
		await closing;
	});

	it.each([
		["rejects", () => omp.tabs.close.mockRejectedValue(new Error("EBUSY"))],
		["answers false", () => omp.tabs.close.mockResolvedValue(false)],
	])("says so and shows the tab again when main's close %s", async (_label, fail) => {
		seedTabs("t0");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, sessionPath: "/s/beta.jsonl" } : tab)),
		}));
		useToastStore.setState({ toasts: [] });
		fail();
		omp.tabs.list.mockResolvedValue(mainTabs().map(info => ({ ...info, active: info.tabId === "t0" })));
		// Main still holds the tab's ask, and its draft lives in its runtime.
		pushTabExtensionUiRequest("t1", { type: "extension_ui_request", id: "ask-t1", method: "ask", questions: [] });
		sessionRuntimeStore<ComposerStore>("t1", "composer")?.setState({ draft: "half a thought" });

		await useTabsStore.getState().closeTab("t1");

		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("tabs.closeFailed"));
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1", "t2"]);
		expect(isTabClosed("t1")).toBe(false);
		expect(sessionRuntime("t1")).not.toBeNull();
		// The tab comes back as it was: its ask still answerable, its draft still there.
		expect(
			sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi")
				?.getState()
				.pendingRequests.map(request => request.id),
		).toEqual(["ask-t1"]);
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.awaitingInput).toBe("input");
		expect(sessionRuntimeStore<ComposerStore>("t1", "composer")?.getState().draft).toBe("half a thought");
		// Nothing was closed, so there is nothing to reopen.
		expect(useTabsStore.getState().closedTabs).toEqual([]);
	});

	it("closing a tab main no longer has stays closed without an error", async () => {
		seedTabs("t0");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, sessionPath: "/s/beta.jsonl" } : tab)),
		}));
		useToastStore.setState({ toasts: [] });
		omp.tabs.close.mockResolvedValue(false);
		omp.tabs.list.mockResolvedValue(
			[tabInfo("t0", "/alpha"), tabInfo("t2", "/gamma")].map(info => ({ ...info, active: info.tabId === "t0" })),
		);

		await useTabsStore.getState().closeTab("t1");

		expect(useToastStore.getState().toasts).toEqual([]);
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(isTabClosed("t1")).toBe(true);
		expect(useTabsStore.getState().closedTabs.map(entry => entry.sessionPath)).toEqual(["/s/beta.jsonl"]);
	});

	it("settles when routing the split without the closing pane fails: no tab is left in no pane", async () => {
		seedTabs("t0");
		const split: SplitLayout = { axis: "columns", ratio: 0.5, first: { tabId: "t0" }, second: { tabId: "t1" } };
		useTabsStore.setState({ split });
		useToastStore.setState({ toasts: [] });
		omp.tabs.setActive.mockRejectedValue(new Error("ipc down"));
		omp.tabs.list
			.mockResolvedValueOnce(
				mainTabs().map(info => ({ ...info, active: info.tabId === "t0", visible: info.tabId !== "t2", split })),
			)
			.mockResolvedValue(
				[tabInfo("t0", "/alpha"), tabInfo("t2", "/gamma")].map(info => ({ ...info, active: info.tabId === "t0" })),
			);

		await expect(useTabsStore.getState().closeTab("t1")).resolves.toBeUndefined();

		const state = useTabsStore.getState();
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		expect(state.tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(state.split).toBeNull();
		expect(state.activeTabId).toBe("t0");
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("tabs.switchFailed"));
	});

	it("settles when routing the split without a pane resolves false", async () => {
		seedTabs("t0");
		useTabsStore.setState({
			split: { axis: "columns", ratio: 0.5, first: { tabId: "t0" }, second: { tabId: "t1" } },
		});
		useToastStore.setState({ toasts: [] });
		omp.tabs.setActive.mockResolvedValue(false);
		omp.tabs.list.mockResolvedValue(mainTabs().map(info => ({ ...info, active: info.tabId === "t0" })));

		await expect(useTabsStore.getState().removePane("t1")).resolves.toBeUndefined();

		expect(useTabsStore.getState().split).toBeNull();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1", "t2"]);
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("tabs.switchFailed"));
	});
});

describe("tabs store position jumps", () => {
	it("focuses the tab at a strip position and the last tab, ignoring positions past the end", async () => {
		seedTabs("t0");
		await useTabsStore.getState().switchTabAt(2);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		await useTabsStore.getState().switchTabAt("last");
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		await useTabsStore.getState().switchTabAt(7);
		expect(useTabsStore.getState().activeTabId).toBe("t2");
	});
});

describe("tabs store applyTabStatus", () => {
	it("sets unreadDone when a background run settles, cleared on visit", async () => {
		seedTabs();

		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "running" });
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.unreadDone).toBe(false);

		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.unreadDone).toBe(true);

		await useTabsStore.getState().switchTab("t1");
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.unreadDone).toBe(false);
	});

	it("does not badge the active tab's own run settling", () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "running" });
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready" });
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t0")?.unreadDone).toBe(false);
	});

	it("mirrors only the active tab's keyed connection status into the composer", () => {
		seedTabs();
		useSessionStore.setState({ status: "starting", cwd: "" });

		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready" });
		expect(useSessionStore.getState().status).toBe("ready");
		expect(useSessionStore.getState().cwd).toBe("/alpha");

		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "exited" });
		expect(useSessionStore.getState().status).toBe("ready");
		expect(useSessionStore.getState().cwd).toBe("/alpha");
	});

	it("upserts unknown tabs and preserves title/sessionId across pushes", () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t9", cwd: "/new", status: "starting" });
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toContain("t9");

		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready", title: "Beta", sessionId: "s9" });
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		const t1 = useTabsStore.getState().tabs.find(tab => tab.id === "t1");
		expect(t1?.title).toBe("Beta");
		expect(t1?.sessionId).toBe("s9");
	});

	it("clears a stale transcript path when main reports a fresh unsaved session", () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "ready",
			sessionPath: "/sessions/old.jsonl",
		});
		expect(useTabsStore.getState().tabs[0]?.sessionPath).toBe("/sessions/old.jsonl");

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "ready",
			sessionPath: null,
		});
		expect(useTabsStore.getState().tabs[0]?.sessionPath).toBeUndefined();
	});

	it("drops a parked bundle when the sidecar replaces its session", async () => {
		seedTabs();
		fillLiveStores("old");
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/old",
			status: "ready",
			title: "Old title",
			sessionId: "s-old",
		});
		await useTabsStore.getState().switchTab("t1");
		const oldRuntime = sessionRuntime("t0");
		expect(oldRuntime).not.toBeNull();

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/old",
			status: "ready",
			title: null,
			sessionId: "s-new",
		});

		const tab = useTabsStore.getState().tabs.find(entry => entry.id === "t0");
		expect(tab?.title).toBeUndefined();
		expect(tab?.sessionId).toBe("s-new");
		expect(sessionRuntime("t0")).not.toBe(oldRuntime);
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionId: "s-new", cwd: "/old" })));

		await useTabsStore.getState().switchTab("t0");
		expect(useComposerStore.getState().draft).toBe("");
		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});
});

describe("tabs store background tab signals", () => {
	const tabOf = (id: string) => useTabsStore.getState().tabs.find(tab => tab.id === id);

	it("clears retry and compaction rows once main reports the run is over", () => {
		seedTabs();
		const session = sessionRuntimeStore<SessionStore>("t1", "session")!;
		session.setState({
			retryInfo: { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "529", startedAt: 1 },
			compactionInfo: { reason: "threshold", action: "compacting" },
		});
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "running" });
		expect(session.getState().retryInfo).not.toBeNull();
		expect(session.getState().compactionInfo).toBeNull();

		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		expect(session.getState().retryInfo).toBeNull();
	});

	it("notifies when a background run ends, telling a failure from a success", async () => {
		seedTabs();
		const notify = vi.fn();
		const rpc = window.omp.rpc as unknown as Record<string, unknown>;
		rpc.commandForTab = vi.fn(async () => ok({ values: { "error.notify": "on", "completion.notify": "on" } }));
		(window.omp as unknown as Record<string, unknown>).system = { notify };
		const doc = document as unknown as { hasFocus?: () => boolean };
		const previousFocus = doc.hasFocus;
		doc.hasFocus = () => false;
		try {
			const status = (payload: Partial<IpcTabStatusPayload>) =>
				useTabsStore
					.getState()
					.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready", ...payload });
			status({ status: "running", title: "Beta job" });
			status({ lastRun: { stopReason: "error", errorMessage: "boom" } });
			await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
			expect(notify).toHaveBeenCalledWith(
				"Beta job",
				translate("events.notificationErrorDetail", { error: "boom" }),
				"t1",
				"error",
			);

			status({ status: "running" });
			status({ lastRun: { stopReason: "stop" } });
			await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
			expect(notify).toHaveBeenLastCalledWith(
				"Beta job",
				translate("events.notificationComplete"),
				"t1",
				"completion",
			);

			// Main's outcome carries the reply's start: the banner reads its prose, Markdown removed.
			status({ status: "running" });
			status({ lastRun: { stopReason: "stop", reply: "## Done\n\nFixed **the parser**." } });
			await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
			expect(notify).toHaveBeenLastCalledWith("Beta job", "Done. Fixed the parser.", "t1", "completion");

			// A run the user aborted stays quiet.
			status({ status: "running" });
			status({ lastRun: { stopReason: "aborted" } });
			const tick = Promise.withResolvers<void>();
			setTimeout(tick.resolve, 0);
			await tick.promise;
			expect(notify).toHaveBeenCalledTimes(3);
		} finally {
			doc.hasFocus = previousFocus;
		}
	});

	it("flags a background tab blocked on the user until omp withdraws the request", () => {
		seedTabs();
		pushTabExtensionUiRequest("t1", {
			type: "extension_ui_request",
			id: "confirm-bg",
			method: "confirm",
			title: "Proceed?",
			message: "ok?",
		});
		expect(tabOf("t1")?.awaitingInput).toBe("input");
		expect(tabOf("t0")?.awaitingInput).toBeUndefined();
		// Status pushes rebuild the entry; the flag survives them.
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "running" });
		expect(tabOf("t1")?.awaitingInput).toBe("input");

		pushTabExtensionUiRequest("t1", {
			type: "extension_ui_request",
			id: "cancel-bg",
			method: "cancel",
			targetId: "confirm-bg",
		});
		expect(tabOf("t1")?.awaitingInput).toBeUndefined();
	});

	it("shows again the asks a reloaded page missed, once each, and flags their tabs", () => {
		seedTabs();
		const ask: ExtensionUIRequest = { type: "extension_ui_request", id: "ask-t1", method: "ask", questions: [] };
		const live: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "live-t1",
			method: "confirm",
			title: "Go?",
			message: "?",
		};
		pushTabExtensionUiRequest("t1", live);
		restoreTabExtensionUiRequests([
			{ tabId: "t1", request: ask },
			{ tabId: "t1", request: live },
		]);
		restoreTabExtensionUiRequests([{ tabId: "t1", request: ask }]);
		const pending = sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi")?.getState().pendingRequests;
		expect(pending?.map(request => request.id)).toEqual(["live-t1", "ask-t1"]);
		expect(tabOf("t1")?.awaitingInput).toBe("input");
	});

	it("does not double an ask a paired host's re-attach sends again, and shows it again once its card closed", () => {
		seedTabs();
		const ask: ExtensionUIRequest = { type: "extension_ui_request", id: "ask-t1", method: "ask", questions: [] };
		const pending = () =>
			sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi")
				?.getState()
				.pendingRequests.map(request => request.id);
		pushTabExtensionUiRequest("t1", ask);
		pushTabExtensionUiRequest("t1", ask);
		expect(pending()).toEqual(["ask-t1"]);
		pushTabExtensionUiRequest("t1", { type: "extension_ui_request", id: "c", method: "cancel", targetId: "ask-t1" });
		expect(pending()).toEqual([]);
		pushTabExtensionUiRequest("t1", ask);
		expect(pending()).toEqual(["ask-t1"]);
		expect(tabOf("t1")?.awaitingInput).toBe("input");
	});

	// A web page catching up in place after its link dropped (web/resync-page.ts): the `cancel` of an ask answered
	// on another device meanwhile was among the missed events.
	it("settles the asks after a reconnect: missed ones appear, answered ones go, a status stays", () => {
		seedTabs();
		const pending = (tabId: string) =>
			sessionRuntimeStore<ExtensionUiStore>(tabId, "extensionUi")
				?.getState()
				.pendingRequests.map(request => request.id);
		const answered: ExtensionUIRequest = { type: "extension_ui_request", id: "old", method: "ask", questions: [] };
		const missed: ExtensionUIRequest = { type: "extension_ui_request", id: "new", method: "ask", questions: [] };
		pushTabExtensionUiRequest("t1", answered);
		expect(tabOf("t1")?.awaitingInput).toBe("input");
		settleTabExtensionUiRequests([{ tabId: "t2", request: missed }]);
		expect(pending("t1")).toEqual([]);
		expect(tabOf("t1")?.awaitingInput).toBeUndefined();
		expect(pending("t2")).toEqual(["new"]);
	});

	it("takes the host's list as the whole truth after a reconnect: a restarted host's old tab ids go", async () => {
		seedTabs("t1");
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("n0", "/alpha"), active: true }, tabInfo("n1", "/beta")]);
		await useTabsStore.getState().reconcileTabs({ dropUnlisted: true });
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["n0", "n1"]);
		expect(useTabsStore.getState().activeTabId).toBe("n0");
		expect(sessionRuntime("t1")).toBeNull();
	});

	it("gives a tab it learns only from the list the list's status (its TAB_STATUS went by before the page knew it)", async () => {
		seedTabs("t1");
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("n0", "/alpha"), active: true },
			tabInfo("n1", "/beta", "running"),
		]);
		await useTabsStore.getState().reconcileTabs({ dropUnlisted: true });
		const session = (id: string) => sessionRuntimeStore<SessionStore>(id, "session")?.getState();
		expect(session("n0")).toMatchObject({ status: "ready", cwd: "/alpha", isStreaming: false });
		expect(session("n1")).toMatchObject({ status: "ready", cwd: "/beta", isStreaming: true });
	});

	describe("a provider sign-in's requests, restored", () => {
		const paste: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "paste-t1",
			method: "input",
			title: "Paste the authorization code",
		};
		const link: Extract<ExtensionUIRequest, { method: "open_url" }> = {
			type: "extension_ui_request",
			id: "url-t1",
			method: "open_url",
			url: "https://claude.ai/oauth",
			launchUrl: "http://localhost:1455/launch",
		};
		const extensionUi = () => sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi")?.getState();
		let respondExtensionUi: Mock<() => Promise<void>>;
		beforeEach(() => {
			respondExtensionUi = vi.fn(async () => {});
			(window.omp as unknown as Record<string, unknown>).ui = { respondExtensionUi };
		});

		it.each([
			[
				"a reloaded page's restore",
				(signIn: IpcSignIn) => restoreTabExtensionUiRequests([{ tabId: "t1", request: paste, signIn }]),
			],
			["a re-attach's re-sent frame", (signIn: IpcSignIn) => pushTabExtensionUiRequest("t1", paste, signIn)],
		])("go to the login store while `login` runs, through %s: no chat card, no 'needs input'", (_path, deliver) => {
			seedTabs();
			deliver({ active: true, providerId: "anthropic", link });
			expect(extensionUi()?.pendingRequests.map(request => request.id)).toEqual(["paste-t1"]);
			expect(extensionUi()?.loginRequestIds).toEqual({ "paste-t1": true });
			// The panel can show the sign-in again: provider and the page it opened, with the sign-in counted in flight.
			expect(extensionUi()?.adoptedLogin).toEqual({ providerId: "anthropic", link, hidden: false, ended: null });
			expect(extensionUi()?.inlineLogins).toBe(1);
			expect(tabOf("t1")?.awaitingInput).toBeUndefined();
			expect(respondExtensionUi).not.toHaveBeenCalled();
		});

		it.each([
			[
				"a reloaded page's restore",
				(signIn: IpcSignIn) => restoreTabExtensionUiRequests([{ tabId: "t1", request: paste, signIn }]),
			],
			["a re-attach's re-sent frame", (signIn: IpcSignIn) => pushTabExtensionUiRequest("t1", paste, signIn)],
		])("are answered `cancelled` once `login` has answered, through %s: never shown", (_path, deliver) => {
			seedTabs();
			deliver({ active: false, providerId: null });
			expect(respondExtensionUi).toHaveBeenCalledWith(
				{ type: "extension_ui_response", id: "paste-t1", cancelled: true },
				"t1",
			);
			expect(extensionUi()?.pendingRequests).toEqual([]);
			expect(extensionUi()?.loginRequestIds).toEqual({});
			expect(extensionUi()?.adoptedLogin).toBeNull();
			expect(tabOf("t1")?.awaitingInput).toBeUndefined();
		});

		it("is over when main says `login` answered: the paste is cancelled and the outcome kept for the panel", () => {
			seedTabs();
			restoreTabExtensionUiRequests([
				{ tabId: "t1", request: paste, signIn: { active: true, providerId: "anthropic" } },
			]);
			endTabSignIn("t1", null);
			expect(respondExtensionUi).toHaveBeenCalledWith(
				{ type: "extension_ui_response", id: "paste-t1", cancelled: true },
				"t1",
			);
			expect(extensionUi()?.pendingRequests).toEqual([]);
			expect(extensionUi()?.inlineLogins).toBe(0);
			expect(extensionUi()?.adoptedLogin).toMatchObject({ providerId: "anthropic", ended: { error: null } });
			// A sign-in this page started itself has no adopted state: nothing to settle.
			respondExtensionUi.mockClear();
			extensionUi()?.dismissAdoptedLogin();
			endTabSignIn("t1", "denied");
			expect(extensionUi()?.adoptedLogin).toBeNull();
			expect(respondExtensionUi).not.toHaveBeenCalled();
		});

		it("leave a sign-in a panel of this page started to that panel", () => {
			seedTabs();
			extensionUi()?.beginInlineLogin();
			pushTabExtensionUiRequest("t1", paste, { active: true, providerId: "anthropic" });
			expect(extensionUi()?.adoptedLogin).toBeNull();
			expect(extensionUi()?.inlineLogins).toBe(1);
			expect(extensionUi()?.loginRequestIds).toEqual({ "paste-t1": true });
		});
	});

	it("tells a background tool approval from a question", () => {
		seedTabs();
		pushTabExtensionUiRequest("t1", {
			type: "extension_ui_request",
			id: "approval-bg",
			method: "select",
			title: "Allow tool: bash\nrm -rf build",
			options: ["Approve", "Deny"],
		});
		expect(tabOf("t1")?.awaitingInput).toBe("approval");
	});
});

describe("useSessionTabs hook", () => {
	let container: { remove(): void };
	let root: Root;

	async function mount(): Promise<void> {
		const element = document.createElement("div") as unknown as { remove(): void };
		container = element;
		document.body.appendChild(element as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(<Probe />);
		});
	}

	function Probe(): null {
		useSessionTabs();
		return null;
	}

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root.unmount();
			});
		}
		container?.remove();
	});

	it("reconciles on mount and subscribes to TAB_STATUS", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);

		await mount();

		expect(omp.tabs.list).toHaveBeenCalled();
		expect(omp.events.onTabStatus).toHaveBeenCalled();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});

	it("hydrates the restored active tab when it was ready before renderer subscriptions", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), { ...tabInfo("t1", "/beta"), active: true }]);
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionId: "restored", cwd: "/beta" })));

		await mount();
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(useSessionStore.getState()).toMatchObject({ sessionId: "restored", cwd: "/beta", status: "ready" });
		expect(omp.rpc.getTranscriptPage).toHaveBeenCalled();
	});

	it("restores transcript and controls when metadata arrives before the boot status snapshot", async () => {
		ensureTabRuntime("t0");
		setFocusedSessionRuntime("t0");
		useSessionStore.setState({ sessionId: "restored", cwd: "/alpha", status: "starting" });
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("t0", "/alpha"), active: true }]);
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionId: "restored", cwd: "/alpha", messageCount: 1 })));
		omp.rpc.getTranscriptPage.mockResolvedValue(ok({ messages: [msg("restored history")] }));
		await mount();
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
		expect(useSessionStore.getState()).toMatchObject({ sessionId: "restored", status: "ready" });
		expect(useMessagesStore.getState().messages).toEqual([msg("restored history")]);
	});

	it("restores history when metadata precedes ready on the light channel", async () => {
		useTabsStore.setState({
			tabs: [{ kind: "chat", id: "t1", cwd: "/beta", status: "starting", unreadDone: false }],
			activeTabId: "t1",
			bundles: new Map(),
		});
		await mount();
		ensureTabRuntime("t1");
		setFocusedSessionRuntime("t1");
		useSessionStore.setState({ sessionId: "restored", status: "starting" });
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionId: "restored", messageCount: 1 })));
		omp.rpc.getTranscriptPage.mockResolvedValue(ok({ messages: [msg("restored history")] }));

		await act(async () => {
			emitTabStatus({ kind: "chat", tabId: "t1", cwd: "/beta", status: "ready" });
		});
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(useSessionStore.getState().status).toBe("ready");
		expect(useMessagesStore.getState().messages).toEqual([msg("restored history")]);
	});

	it("applies a tab's pending session path on its first ready push while active", async () => {
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		});
		// The switch + hydrate run in a trailing microtask chain.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/s.json");
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();

		// A duplicate ready push must not re-enter the flow.
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		});
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
	});

	it("skips the ready-time switchSession when the sidecar is already on the pending session", async () => {
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		// Spawned WITH --session /s.json: get_state already reports that file,
		// so a second switch would only abort the in-flight resume.
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionFile: "/s.json" })));
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		});
		// The gate + hydrate run in a trailing microtask chain.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		// No redundant switch — but the transcript still hydrates and the
		// pending path is consumed.
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(omp.rpc.getTranscriptPage).toHaveBeenCalled();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("does not switch the session for a background tab's pending path", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		});

		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		// Pending path survives for when the user actually switches to t1.
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.pendingSessionPath).toBe("/s.json");
	});

	it("subscribes subagent frames on a tab's ready only while it is active (F-HYDRATE)", async () => {
		seedTabs();
		useSessionStore.setState({ sessionId: "active" });
		await mount();
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
		omp.rpc.setSubagentSubscription.mockClear();

		// Background ready: renderer RPC routes through the ACTIVE tab, so a
		// background tab's ready must NOT fire the command (it would land on
		// the wrong sidecar). hydrateSession re-asserts on switch-in instead.
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", status: "ready" });
		});
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", status: "ready" });
		});
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledWith("progress");
	});
});

describe("tabChipLabel (F-HYDRATE)", () => {
	function chip(id: string, cwd: string, title?: string): SessionTab {
		const tab: SessionTab = { id, cwd, status: "ready", kind: "agent", unreadDone: false };
		if (title !== undefined) tab.title = title;
		return tab;
	}

	it("prefers the session title, then the cwd basename, then the new-session label", () => {
		expect(tabChipLabel(chip("t0", "/work/alpha", "Alpha plan"), [])).toBe("Alpha plan");
		expect(tabChipLabel(chip("t1", "/work/beta"), [])).toBe("beta");
		expect(tabChipLabel(chip("t2", ""), [])).toBe("New session");
		// Empty-string titles (never-generated auto-title slot) fall through too.
		expect(tabChipLabel(chip("t3", "/work/gamma", ""), [])).toBe("gamma");
	});

	it("keeps an untitled global chat unnamed instead of exposing its internal cwd as a workspace", () => {
		const chat = { ...chip("chat-0", "/Users/tester"), kind: "chat" as const };
		expect(tabChipLabel(chat, [chat])).toBe("New session");
	});

	it("suffixes identical untitled labels in tab order, first occurrence bare", () => {
		const tabs = [chip("t0", "/work/gui"), chip("t1", "/other/gui"), chip("t2", "/tmp/gui")];
		expect(tabs.map(tab => tabChipLabel(tab, tabs))).toEqual(["gui", "gui #2", "gui #3"]);
		// Distinct basenames never collide, even beside a suffixed group.
		const mixed = [chip("t0", "/work/gui"), chip("t1", "/work/beta"), chip("t2", "/other/gui")];
		expect(mixed.map(tab => tabChipLabel(tab, mixed))).toEqual(["gui", "beta", "gui #2"]);
	});

	it("never suffixes titled tabs — a title is itself the disambiguator", () => {
		const tabs = [chip("t0", "/work/gui"), chip("t1", "/other/gui", "Release plan")];
		// The titled tab left the collision set, so the untitled one stays bare.
		expect(tabs.map(tab => tabChipLabel(tab, tabs))).toEqual(["gui", "Release plan"]);
	});

	it("names a tab another session's agent opened by its task until it has a title", () => {
		const child = { ...chip("t0", "/wt/gui-2026-10-17-c2-docs-aaaaaaa"), task: "Fix the flaky upload test" };
		const sibling = { ...chip("t1", "/wt/gui-2026-10-17-c2-tests-bbbbbbb"), task: "Cover the upload retry" };
		expect([child, sibling].map(tab => tabChipLabel(tab, [child, sibling]))).toEqual([
			"Fix the flaky upload test",
			"Cover the upload retry",
		]);
		expect(tabChipLabel({ ...child, title: "Named by stock" }, [child])).toBe("Named by stock");
	});

	it("never shows the Title: label of a task in a tab's name", () => {
		expect(tabChipLabel(chip("t0", "/wt/x", "Title: 안내 문구 점검"), [])).toBe("안내 문구 점검");
		expect(tabChipLabel({ ...chip("t1", "/wt/y"), task: "Title: Fix it" }, [])).toBe("Fix it");
	});

	it("uses indexed session content instead of a cwd fallback on every tab surface", () => {
		const tab = chip("t0", "/work/Infron");
		expect(tabDisplayTitle(tab, [tab], { title: null, firstMessage: "Review the MySQL migration" }, "Untitled")).toBe(
			"Review the MySQL migration",
		);
	});
});

describe("tab runtime lifecycle guards", () => {
	it("keeps static store access on a focused tab whose runtime was rebuilt by a session change", () => {
		seedTabs("t0");
		const before = sessionRuntime("t0");
		expect(before).not.toBeNull();
		// Stamp the tab's session identity first (sessionChanged only fires when
		// BOTH the cached and the incoming frame carry a sessionId/sessionPath).
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "ready",
			sessionId: "s-old",
			sessionPath: "/old.jsonl",
		});

		// In-place session switch: TAB_STATUS carries a NEW sessionId for the
		// focused tab (e.g. /new) — the runtime is rebuilt around it.
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			status: "ready",
			sessionId: "s-new",
			sessionPath: "/new.jsonl",
		});

		const rebuilt = sessionRuntime("t0");
		expect(rebuilt).not.toBeNull();
		expect(rebuilt).not.toBe(before);
		// Focus must survive the rebuild: static (focus-following) access still
		// resolves to t0's fresh runtime store, never the module-level default.
		const rebuiltSession = rebuilt?.stores.get("session") as { getState: () => unknown } | undefined;
		expect(useSessionStore.getState()).toBe(rebuiltSession?.getState());
	});

	it("tombstones a closed tab: late extension requests never resurrect a ghost runtime", async () => {
		seedTabs("t0");
		await useTabsStore.getState().closeTab("t1");

		expect(isTabClosed("t1")).toBe(true);
		pushTabExtensionUiRequest("t1", {
			type: "extension_ui_request",
			id: "ui-late",
			method: "confirm",
			title: "Late",
			message: "Late request",
		});
		expect(sessionRuntime("t1")).toBeNull();

		// reset() clears tombstones (test isolation; live ids are never reused).
		useTabsStore.getState().reset();
		expect(isTabClosed("t1")).toBe(false);
	});

	it("refuses to re-split a tab that already occupies a pane", async () => {
		seedTabs("t0");
		useTabsStore.setState({
			split: { axis: "columns", first: { tabId: "t0" }, second: { tabId: "t1" }, ratio: 0.7 },
		});

		await useTabsStore.getState().splitTab("t1", "top");

		// No ratio reset, no axis flip, no focus move.
		expect(useTabsStore.getState().split).toEqual({
			axis: "columns",
			first: { tabId: "t0" },
			second: { tabId: "t1" },
			ratio: 0.7,
		});
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});
});

describe("four-pane layouts", () => {
	const placements: SplitPlacement[] = ["left", "right", "top", "bottom"];
	function seed() {
		seedTabs();
		useTabsStore.setState(state => ({
			tabs: [
				...state.tabs,
				...["t3", "t4"].map(id => ({
					id,
					kind: "agent" as const,
					cwd: "/project",
					status: "ready" as const,
					unreadDone: false,
				})),
			],
		}));
	}

	it.each(placements)("adds third and fourth panes at %s of the target", async placement => {
		installMockOmp();
		seed();
		await useTabsStore.getState().splitTab("t1", "right");
		await useTabsStore.getState().splitTab("t2", placement, "t0");
		const three = useTabsStore.getState().split!;
		expect(splitTabIds(three)).toHaveLength(3);
		expect("tabId" in three.first).toBe(false);
		if (!("tabId" in three.first)) {
			expect(three.first.axis).toBe(placement === "left" || placement === "right" ? "columns" : "rows");
			expect(splitTabIds(three.first)).toEqual(
				placement === "left" || placement === "top" ? ["t2", "t0"] : ["t0", "t2"],
			);
		}
		await useTabsStore.getState().splitTab("t3", placement, "t1");
		const four = useTabsStore.getState().split!;
		expect(splitTabIds(four)).toHaveLength(4);
		expect(splitTabIds(four.second)).toEqual(
			placement === "left" || placement === "top" ? ["t3", "t1"] : ["t1", "t3"],
		);
	});

	it("replaces the pointed pane at four without changing geometry", async () => {
		installMockOmp();
		seed();
		await useTabsStore.getState().splitTab("t1", "right");
		await useTabsStore.getState().splitTab("t2", "bottom", "t0");
		await useTabsStore.getState().splitTab("t3", "bottom", "t1");
		await useTabsStore.getState().splitTab("t4", "left", "t2");
		expect(splitTabIds(useTabsStore.getState().split!)).toEqual(["t0", "t4", "t1", "t3"]);
		expect(useTabsStore.getState().split?.axis).toBe("columns");
	});

	it("closing a middle tab collapses only its parent", async () => {
		installMockOmp();
		seed();
		await useTabsStore.getState().splitTab("t1", "right");
		await useTabsStore.getState().splitTab("t2", "right", "t1");
		await useTabsStore.getState().closeTab("t1");
		expect(useTabsStore.getState().split).toEqual({
			axis: "columns",
			ratio: 0.5,
			first: { tabId: "t0" },
			second: { tabId: "t2" },
		});
	});

	it("unsplit keeps the focused pane", async () => {
		installMockOmp();
		seed();
		await useTabsStore.getState().splitTab("t1", "right");
		await useTabsStore.getState().splitTab("t2", "bottom", "t0");
		await useTabsStore.getState().unsplit();
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(useTabsStore.getState().split).toBeNull();
	});

	it("migrates the legacy split at the read boundary", () => {
		expect(readSplitNode({ axis: "rows", firstTabId: "t0", secondTabId: "t1", ratio: 0.7 })).toEqual({
			axis: "rows",
			first: { tabId: "t0" },
			second: { tabId: "t1" },
			ratio: 0.7,
		});
	});
});

describe("remembered splits", () => {
	function seedFive() {
		seedTabs();
		useTabsStore.setState(state => ({
			tabs: [
				...state.tabs,
				...["t3", "t4"].map(id => ({
					id,
					kind: "agent" as const,
					cwd: "/project",
					status: "ready" as const,
					unreadDone: false,
				})),
			],
		}));
		for (const id of ["t3", "t4"]) ensureTabRuntime(id);
	}
	/** t0 | (t1 over t2) with the left pane resized, t2 focused. */
	async function threePanes() {
		seedFive();
		await useTabsStore.getState().splitTab("t1", "right");
		await useTabsStore.getState().splitTab("t2", "bottom", "t1");
		useTabsStore.getState().setSplitRatio(0.3);
		const split = useTabsStore.getState().split;
		if (!split) throw new Error("expected a split");
		return split;
	}

	it("shows a session outside the split alone and remembers the split", async () => {
		const split = await threePanes();
		await useTabsStore.getState().switchTab("t3");
		const state = useTabsStore.getState();
		expect(state.activeTabId).toBe("t3");
		expect(state.split).toBeNull();
		expect(state.rememberedSplits).toEqual([split]);
		// No pane took the session: the remembered split still names its three sessions.
		expect(splitTabIds(state.rememberedSplits[0]!)).toEqual(["t0", "t1", "t2"]);
	});

	it("tells main the remembered splits with every view change", async () => {
		const split = await threePanes();
		await useTabsStore.getState().switchTab("t3");
		expect(omp.tabs.setView).toHaveBeenLastCalledWith("t3", ["t3"], undefined, [split]);
	});

	it("restores a remembered split as it was with the clicked session focused", async () => {
		const split = await threePanes();
		await useTabsStore.getState().switchTab("t3");
		await useTabsStore.getState().switchTab("t1");
		const state = useTabsStore.getState();
		expect(state.split).toEqual(split);
		expect(state.activeTabId).toBe("t1");
		expect(state.rememberedSplits).toEqual([]);
		expect(omp.tabs.setView).toHaveBeenLastCalledWith("t1", ["t0", "t1", "t2"], split, []);
	});

	it("moves only the focus when the picked session is a pane of the split on screen", async () => {
		const split = await threePanes();
		await useTabsStore.getState().switchTab("t0");
		expect(useTabsStore.getState().split).toEqual(split);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(useTabsStore.getState().rememberedSplits).toEqual([]);
	});

	it("still switches to a background-running session when a ratio step lands while its present loads", async () => {
		await threePanes();
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t3", cwd: "/project", status: "running" });
		vi.useFakeTimers();
		try {
			const gate = Promise.withResolvers<RpcResponse>();
			omp.rpc.getTranscriptPage.mockReturnValueOnce(gate.promise);
			const switching = useTabsStore.getState().switchTab("t3");
			await vi.advanceTimersByTimeAsync(0);
			// A divider drag (or ⌘-bracket step) re-sizes the split on screen while t3's present is on the way.
			useTabsStore.getState().setSplitRatio(0.4);
			gate.resolve(ok({ messages: [] }));
			await vi.advanceTimersByTimeAsync(300);
			await switching;
			const state = useTabsStore.getState();
			expect(state.activeTabId).toBe("t3");
			expect(state.split).toBeNull();
			expect(state.rememberedSplits.map(split => splitTabIds(split))).toEqual([["t0", "t1", "t2"]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("swaps remembered splits when a member of another one is picked", async () => {
		const first = await threePanes();
		await useTabsStore.getState().switchTab("t3");
		await useTabsStore.getState().splitTab("t4", "right");
		const second = useTabsStore.getState().split!;
		expect(splitTabIds(second)).toEqual(["t3", "t4"]);
		await useTabsStore.getState().switchTab("t0");
		expect(useTabsStore.getState().split).toEqual(first);
		expect(useTabsStore.getState().rememberedSplits).toEqual([second]);
		await useTabsStore.getState().switchTab("t4");
		expect(useTabsStore.getState().split).toEqual(second);
		expect(useTabsStore.getState().rememberedSplits).toEqual([first]);
	});

	it("drops a closed tab from its remembered split and dissolves a split left with one session", async () => {
		await threePanes();
		await useTabsStore.getState().switchTab("t3");
		await useTabsStore.getState().closeTab("t1");
		const left = useTabsStore.getState().rememberedSplits;
		expect(left).toHaveLength(1);
		expect(splitTabIds(left[0]!)).toEqual(["t0", "t2"]);
		await useTabsStore.getState().closeTab("t0");
		expect(useTabsStore.getState().rememberedSplits).toEqual([]);
		// With nothing remembered, picking the remaining member is a plain solo pick.
		await useTabsStore.getState().switchTab("t2");
		expect(useTabsStore.getState().split).toBeNull();
	});

	it("takes a session dropped into a new split out of the one it was remembered in", async () => {
		const first = await threePanes();
		await useTabsStore.getState().switchTab("t3");
		await useTabsStore.getState().splitTab("t0", "right");
		expect(splitTabIds(useTabsStore.getState().split!)).toEqual(["t3", "t0"]);
		const remembered = useTabsStore.getState().rememberedSplits;
		expect(remembered).toHaveLength(1);
		expect(splitTabIds(remembered[0]!)).toEqual(["t1", "t2"]);
		expect(remembered[0]).toEqual(first.second);
	});

	it("reads the remembered splits main restored at boot", async () => {
		const remembered: SplitLayout = { axis: "columns", ratio: 0.4, first: { tabId: "t1" }, second: { tabId: "t2" } };
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/a"), active: true, visible: true },
			{ ...tabInfo("t1", "/b"), rememberedSplit: remembered },
			tabInfo("t2", "/c"),
		]);
		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().rememberedSplits).toEqual([remembered]);
		await useTabsStore.getState().switchTab("t2");
		expect(useTabsStore.getState().split).toEqual(remembered);
		expect(useTabsStore.getState().activeTabId).toBe("t2");
	});

	it("never keeps a split holding a session that is on screen", async () => {
		const stale: SplitLayout = { axis: "columns", ratio: 0.5, first: { tabId: "t0" }, second: { tabId: "t1" } };
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/a"), active: true, visible: true },
			{ ...tabInfo("t1", "/b"), rememberedSplit: stale },
		]);
		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().rememberedSplits).toEqual([]);
	});
});

function messageText(message: AgentMessage): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}

describe("tabs other windows show too (multi-viewer)", () => {
	const tabOf = (id: string) => useTabsStore.getState().tabs.find(tab => tab.id === id);
	const viewed = (tabId: string, viewerCount: number, shared = false): IpcTabInfo => ({
		...tabInfo(tabId, `/${tabId}`),
		viewerCount,
		...(shared ? { shared: true } : {}),
	});
	const messagesOf = (tabId: string) => sessionRuntimeStore<MessagesStore>(tabId, "messages")?.getState();

	it("takes who else shows a tab from the tab list, and keeps it across a status push", async () => {
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/t0"), active: true, visible: true },
			viewed("t1", 2, true),
		]);
		await useTabsStore.getState().reconcileTabs();
		expect(tabOf("t1")).toMatchObject({ shared: true, viewerCount: 2 });
		expect(tabOf("t0")?.viewerCount).toBeUndefined();

		// A status push carries no viewer fields: it never says "nobody shows it".
		useTabsStore.getState().applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/t1", status: "running" });
		expect(tabOf("t1")).toMatchObject({ shared: true, viewerCount: 2, status: "running" });
	});

	it("applyTabList updates the viewer count of known tabs without asking main for the list again", async () => {
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("t0", "/t0"), active: true, visible: true }, tabInfo("t1", "/t1")]);
		await useTabsStore.getState().reconcileTabs();
		omp.tabs.list.mockClear();

		await useTabsStore.getState().applyTabList([tabInfo("t0", "/t0"), viewed("t1", 1)]);
		expect(tabOf("t1")?.viewerCount).toBe(1);
		await useTabsStore.getState().applyTabList([tabInfo("t0", "/t0"), tabInfo("t1", "/t1")]);
		expect(tabOf("t1")?.viewerCount).toBeUndefined();
		expect(omp.tabs.list).not.toHaveBeenCalled();
	});

	it("applyTabList reconciles when it names a tab this window does not know (a viewer was attached)", async () => {
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("t0", "/t0"), active: true, visible: true }]);
		await useTabsStore.getState().reconcileTabs();
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/t0"), active: true, visible: true },
			viewed("t9", 1, true),
		]);

		await useTabsStore.getState().applyTabList([tabInfo("t0", "/t0"), viewed("t9", 1, true)]);

		expect(tabOf("t9")).toMatchObject({ shared: true, viewerCount: 1 });
	});

	it("applyTabList lets go of a shared tab its owner closed", async () => {
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/t0"), active: true, visible: true },
			viewed("t1", 1, true),
		]);
		await useTabsStore.getState().reconcileTabs();
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("t0", "/t0"), active: true, visible: true }]);

		await useTabsStore.getState().applyTabList([tabInfo("t0", "/t0")]);

		expect(tabOf("t1")).toBeUndefined();
		expect(tabOf("t0")).toBeDefined();
	});

	it("tells the tab's messages store it is shared, and that it no longer is", async () => {
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("t0", "/t0"), active: true, visible: true }, tabInfo("t1", "/t1")]);
		await useTabsStore.getState().reconcileTabs();
		expect(messagesOf("t1")?.sharedTab).toBe(false);

		await useTabsStore.getState().applyTabList([tabInfo("t0", "/t0"), viewed("t1", 1)]);
		expect(messagesOf("t1")?.sharedTab).toBe(true);
		expect(messagesOf("t0")?.sharedTab).toBe(false);

		await useTabsStore.getState().applyTabList([tabInfo("t0", "/t0"), tabInfo("t1", "/t1")]);
		expect(messagesOf("t1")?.sharedTab).toBe(false);
	});

	describe("a card another window answered first", () => {
		const ask: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "ask-1",
			method: "confirm",
			title: "Run?",
			message: "m",
		};
		const cancel: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "c-1",
			method: "cancel",
			targetId: "ask-1",
		};
		const pending = () =>
			sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi")
				?.getState()
				.pendingRequests.map(request => request.id);

		it("closes the card and says the other device answered", () => {
			seedTabs();
			pushTabExtensionUiRequest("t1", ask);
			useToastStore.setState({ toasts: [] });

			pushTabExtensionUiRequest("t1", cancel, undefined, true);

			expect(pending()).toEqual([]);
			expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual([
				translate("extDialog.answeredElsewhere"),
			]);
		});

		it("stays quiet when this window's own answer already closed it, or when it is a plain cancel", () => {
			seedTabs();
			useToastStore.setState({ toasts: [] });
			pushTabExtensionUiRequest("t1", cancel, undefined, true);
			expect(useToastStore.getState().toasts).toEqual([]);

			pushTabExtensionUiRequest("t1", ask);
			pushTabExtensionUiRequest("t1", cancel);
			expect(pending()).toEqual([]);
			expect(useToastStore.getState().toasts).toEqual([]);
		});
	});
});

describe("a web page's own done marks", () => {
	const tabOf = (id: string) => useTabsStore.getState().tabs.find(tab => tab.id === id);
	const storage = new Map<string, string>();
	beforeEach(() => {
		storage.clear();
		(globalThis as Record<string, unknown>).localStorage = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
		};
		webMode.on = true;
	});
	afterEach(() => {
		webMode.on = false;
		delete (globalThis as Record<string, unknown>).localStorage;
	});

	const list = (status: IpcTabInfo["status"] = "ready"): IpcTabInfo[] => [
		{ ...tabInfo("t0", "/t0"), active: true, visible: true },
		tabInfo("t1", "/t1", status),
		tabInfo("t2", "/t2"),
	];

	it("writes the tabs with a done mark and the running ones whenever the tab list changes", async () => {
		omp.tabs.list.mockResolvedValue(list("running"));
		await useTabsStore.getState().reconcileTabs();
		expect(readUnreadMarks()).toEqual({ unread: [], running: ["t1"] });

		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t2" ? { ...tab, unreadDone: true } : tab)),
		}));
		expect(readUnreadMarks().unread).toContain("t2");
	});

	it("an owned refusal it cannot place never opens the session again through 'open in a new window'", async () => {
		// On a web page that call is this same openTab: main refuses again, and the page would loop for good.
		omp.tabs.list.mockResolvedValue(list());
		await useTabsStore.getState().reconcileTabs();
		const openInNewWindow = vi.fn(async () => true);
		Object.assign(omp, { sessions: { openInNewWindow } });
		omp.tabs.spawn.mockResolvedValue({ tabId: null, refusal: "owned", ownerTabId: "elsewhere", ownerWinId: 1 });

		expect(await useTabsStore.getState().openTab({ sessionPath: "/sessions/held.jsonl" })).toBe("elsewhere");
		expect(openInNewWindow).not.toHaveBeenCalled();
		expect(omp.tabs.spawn).toHaveBeenCalledTimes(1);
	});

	it("restores a marked tab, and a tab that was running and finished while the page was away", async () => {
		storage.set(UNREAD_MARKS_KEY, JSON.stringify({ unread: ["t2"], running: ["t1"] }));
		omp.tabs.list.mockResolvedValue(list());
		await useTabsStore.getState().reconcileTabs();
		expect(tabOf("t1")?.unreadDone).toBe(true);
		expect(tabOf("t2")?.unreadDone).toBe(true);
		expect(tabOf("t0")?.unreadDone).toBe(false);
	});

	it("does not mark a tab that is still running, nor one the page already knew", async () => {
		storage.set(UNREAD_MARKS_KEY, JSON.stringify({ unread: [], running: ["t1"] }));
		omp.tabs.list.mockResolvedValue(list("running"));
		await useTabsStore.getState().reconcileTabs();
		expect(tabOf("t1")?.unreadDone).toBe(false);

		omp.tabs.list.mockResolvedValue(list());
		await useTabsStore.getState().reconcileTabs();
		expect(tabOf("t1")?.unreadDone).toBe(false);
	});

	it("leaves the desktop's marks in memory only", async () => {
		webMode.on = false;
		storage.set(UNREAD_MARKS_KEY, JSON.stringify({ unread: ["t2"], running: [] }));
		omp.tabs.list.mockResolvedValue(list());
		await useTabsStore.getState().reconcileTabs();
		expect(tabOf("t2")?.unreadDone).toBe(false);
		expect(storage.get(UNREAD_MARKS_KEY)).toBe(JSON.stringify({ unread: ["t2"], running: [] }));
	});
});

describe("agent control view requests", () => {
	const tabOf = (id: string) => useTabsStore.getState().tabs.find(tab => tab.id === id);
	const live = (...ids: string[]): IpcTabInfo[] =>
		ids.map((id, index) => ({ ...tabInfo(id, `/${id}`), active: index === 0, visible: index === 0 }));
	let viewHandler: ((event: AgentControlViewEvent) => void) | null = null;

	beforeEach(() => {
		viewHandler = null;
		(omp.events as Record<string, unknown>).onAgentControlView = vi.fn(
			(callback: (event: AgentControlViewEvent) => void) => {
				viewHandler = callback;
				return () => {
					viewHandler = null;
				};
			},
		);
	});

	async function bootWith(...ids: string[]): Promise<void> {
		omp.tabs.list.mockResolvedValue(live(...ids));
		await useTabsStore.getState().reconcileTabs();
	}

	it("focus switches to the tab like a sidebar pick", async () => {
		await bootWith("t0", "t1");
		await useTabsStore.getState().applyAgentView({ tabId: "t1", how: "focus" });
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(useTabsStore.getState().split).toBeNull();
	});

	it("split-right and split-down put both panes on screen beside the focused one", async () => {
		await bootWith("t0", "t1", "t2");
		await useTabsStore.getState().applyAgentView({ tabId: "t1", how: "split-right" });
		expect(useTabsStore.getState().split).toMatchObject({ axis: "columns" });
		expect(splitTabIds(useTabsStore.getState().split!)).toEqual(["t0", "t1"]);
		await useTabsStore.getState().unsplit();
		await useTabsStore.getState().applyAgentView({ tabId: "t2", how: "split-down" });
		expect(useTabsStore.getState().split).toMatchObject({ axis: "rows" });
		expect(splitTabIds(useTabsStore.getState().split!)).toEqual(["t1", "t2"]);
	});

	it("a split request for a tab already on screen just focuses it", async () => {
		await bootWith("t0", "t1");
		await useTabsStore.getState().applyAgentView({ tabId: "t1", how: "split-right" });
		await useTabsStore.getState().applyAgentView({ tabId: "t0", how: "split-down" });
		expect(splitTabIds(useTabsStore.getState().split!)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});

	it("reconciles first when the tab was only just spawned, then applies the request", async () => {
		await bootWith("t0");
		omp.tabs.list.mockResolvedValue(live("t0", "t9"));
		expect(tabOf("t9")).toBeUndefined();
		await useTabsStore.getState().applyAgentView({ tabId: "t9", how: "focus" });
		expect(tabOf("t9")).toBeDefined();
		expect(useTabsStore.getState().activeTabId).toBe("t9");
	});

	it("ignores a tab that never shows up", async () => {
		await bootWith("t0");
		await useTabsStore.getState().applyAgentView({ tabId: "ghost", how: "split-right" });
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(useTabsStore.getState().split).toBeNull();
	});

	it("close closes the tab the way the user's close does", async () => {
		await bootWith("t0", "t1");
		await useTabsStore.getState().applyAgentView({ tabId: "t1", how: "close" });
		expect(tabOf("t1")).toBeUndefined();
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});

	it("a tab main spawns in the background appears without switching the current view", async () => {
		await bootWith("t0");
		omp.tabs.list.mockResolvedValue(live("t0", "t5"));
		await useTabsStore.getState().applyTabList(live("t0", "t5"));
		expect(tabOf("t5")).toBeDefined();
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(useTabsStore.getState().split).toBeNull();
		expect(omp.tabs.setActive).not.toHaveBeenCalledWith("t5");
	});

	it("useSessionTabs routes the pushed event to the store", async () => {
		await bootWith("t0", "t1");
		const element = document.createElement("div");
		document.body.appendChild(element as never);
		const root = createRoot(element as unknown as Element);
		function Probe(): null {
			useSessionTabs();
			return null;
		}
		await act(async () => {
			root.render(<Probe />);
		});
		await act(async () => {
			viewHandler?.({ tabId: "t1", how: "focus" });
		});
		await vi.waitFor(() => expect(useTabsStore.getState().activeTabId).toBe("t1"));
		await act(async () => {
			root.unmount();
		});
		expect(viewHandler).toBeNull();
	});
});

describe("a web window with no tab", () => {
	beforeEach(() => {
		webMode.on = true;
	});
	afterEach(() => {
		webMode.on = false;
	});

	it("opens the empty start tab in the host's default workspace instead of waiting on a tab that never comes", async () => {
		omp.tabs.list.mockResolvedValue([]);
		omp.tabs.spawn.mockResolvedValue({ tabId: "start", cwd: "/host/work" });

		await useTabsStore.getState().reconcileTabs();

		expect(omp.tabs.spawn).toHaveBeenCalledTimes(1);
		expect(omp.tabs.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ defaultWorkspace: true, placeholder: true }),
		);
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["start"]);
		expect(useTabsStore.getState().tabs[0]?.placeholder).toBe(true);
		expect(useTabsStore.getState().activeTabId).toBe("start");
	});

	it("opens it once while reconciles overlap, and never on the desktop", async () => {
		omp.tabs.list.mockResolvedValue([]);
		const spawned = Promise.withResolvers<IpcSpawnTabResult | null>();
		omp.tabs.spawn.mockReturnValue(spawned.promise);

		const first = useTabsStore.getState().reconcileTabs();
		await useTabsStore.getState().reconcileTabs();
		spawned.resolve({ tabId: "start", cwd: "/host/work" });
		await first;
		expect(omp.tabs.spawn).toHaveBeenCalledTimes(1);

		useTabsStore.getState().reset?.();
		webMode.on = false;
		omp.tabs.spawn.mockClear();
		await useTabsStore.getState().reconcileTabs();
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
	});
});

describe("tabs of the last run (the tab snapshot)", () => {
	const ghost = (id: string, extra: Partial<SessionTab> = {}): SessionTab => ({
		id,
		cwd: "/p",
		kind: "agent",
		status: "starting",
		unreadDone: false,
		ghost: true,
		...extra,
	});

	it("adopts each ghost into the real tab of its session: same place, same selection, no ghost left", async () => {
		useTabsStore.setState({
			tabs: [
				ghost("old-a", { sessionPath: "/s/a.jsonl", title: "Alpha" }),
				ghost("old-b", { sessionPath: "/s/b.jsonl", title: "Beta" }),
				ghost("old-gone", { sessionPath: "/s/gone.jsonl" }),
			],
			activeTabId: "old-b",
		});
		ensureTabRuntime("old-b");
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("new-a", "/p"), sessionPath: "/s/a.jsonl" },
			{ ...tabInfo("new-b", "/p"), sessionPath: "/s/b.jsonl" },
		]);

		await useTabsStore.getState().reconcileTabs();

		const state = useTabsStore.getState();
		expect(state.tabs.map(tab => tab.id)).toEqual(["new-a", "new-b"]);
		expect(state.tabs.some(tab => tab.ghost)).toBe(false);
		expect(state.tabs.map(tab => tab.title)).toEqual(["Alpha", "Beta"]);
		expect(state.activeTabId).toBe("new-b");
		expect(sessionRuntime("old-b")).toBeNull();
	});

	it("takes the next blank ghost for a tab with no session yet, and falls back to main's active tab", async () => {
		useTabsStore.setState({ tabs: [ghost("old-blank")], activeTabId: "old-blank" });
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("new-1", "/p"), active: true }]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["new-1"]);
		expect(useTabsStore.getState().activeTabId).toBe("new-1");
	});

	it("carries the draft typed into a ghost to the real tab of its session", async () => {
		useTabsStore.setState({
			tabs: [ghost("old-a", { sessionPath: "/s/a.jsonl" }), ghost("old-b", { sessionPath: "/s/b.jsonl" })],
			activeTabId: "old-a",
		});
		const typed = ensureTabRuntimeComposer("old-a");
		const image: ComposerStore["images"][number] = {
			content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			preview: "data:image/png;base64,aW1hZ2U=",
		};
		typed.getState().setDraft("typed into the ghost");
		typed.getState().setImages([image]);
		ensureTabRuntime("old-b");
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("new-a", "/p"), sessionPath: "/s/a.jsonl" },
			{ ...tabInfo("new-b", "/p"), sessionPath: "/s/b.jsonl" },
		]);

		await useTabsStore.getState().reconcileTabs();

		const real = sessionRuntimeStore<ComposerStore>("new-a", "composer");
		expect(real?.getState().draft).toBe("typed into the ghost");
		expect(real?.getState().images).toEqual([image]);
		expect(sessionRuntimeStore<ComposerStore>("new-b", "composer")?.getState().draft).toBe("");
		expect(sessionRuntime("old-a")).toBeNull();
	});

	it("carries the draft of a blank ghost with no session file to the real tab that takes its place", async () => {
		useTabsStore.setState({ tabs: [ghost("old-blank")], activeTabId: "old-blank" });
		ensureTabRuntimeComposer("old-blank").getState().setDraft("fixture stream");
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("new-1", "/p"), sessionId: "s-new", active: true }]);

		await useTabsStore.getState().reconcileTabs();

		expect(sessionRuntimeStore<ComposerStore>("new-1", "composer")?.getState().draft).toBe("fixture stream");
	});

	it("keeps what the real tab already holds over the ghost's draft", async () => {
		useTabsStore.setState({ tabs: [ghost("old-a", { sessionPath: "/s/a.jsonl" })], activeTabId: "old-a" });
		ensureTabRuntimeComposer("old-a").getState().setDraft("from the ghost");
		ensureTabRuntimeComposer("new-a").getState().setDraft("already typed");
		omp.tabs.list.mockResolvedValue([{ ...tabInfo("new-a", "/p"), sessionPath: "/s/a.jsonl" }]);

		await useTabsStore.getState().reconcileTabs();

		expect(sessionRuntimeStore<ComposerStore>("new-a", "composer")?.getState().draft).toBe("already typed");
	});

	function ensureTabRuntimeComposer(id: string) {
		ensureTabRuntime(id);
		const composer = sessionRuntimeStore<ComposerStore>(id, "composer");
		if (!composer) throw new Error(`no composer for ${id}`);
		return composer;
	}

	it("drops the ghosts when main lists none of them, and never switches to or closes a ghost", async () => {
		useTabsStore.setState({ tabs: [ghost("g1"), ghost("g2")], activeTabId: "g1" });
		await useTabsStore.getState().switchTab("g2");
		await useTabsStore.getState().closeTab("g2");
		expect(useTabsStore.getState().activeTabId).toBe("g1");
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
		expect(omp.tabs.close).not.toHaveBeenCalled();

		omp.tabs.list.mockResolvedValue([tabInfo("live", "/q")]);
		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["live"]);
	});
});

describe("a command for a starting tab", () => {
	it("waits invisibly for ready and then goes out; a tab that failed releases it", async () => {
		useTabsStore.setState({
			tabs: [{ id: "t-start", cwd: "/p", kind: "agent", status: "starting", unreadDone: false }],
			activeTabId: "t-start",
		});
		const runtime = ensureTabRuntime("t-start");
		const commandForTab = vi.fn(async () => ok({}));
		(window as unknown as { omp: { rpc: { commandForTab: typeof commandForTab } } }).omp.rpc.commandForTab =
			commandForTab;

		const sent = runtime.command({ type: "get_state" });
		await Promise.resolve();
		expect(commandForTab).not.toHaveBeenCalled();

		useTabsStore.setState({
			tabs: [{ id: "t-start", cwd: "/p", kind: "agent", status: "ready", unreadDone: false }],
		});
		await sent;
		expect(commandForTab).toHaveBeenCalledTimes(1);
	});
});
