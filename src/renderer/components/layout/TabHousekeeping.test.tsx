/**
 * TabHousekeeping: startup-placeholder pruning and the armed-close timeout
 * that outlived the removed tab strip. linkedom + react-dom harness.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { StoreApi } from "zustand";
import type { IpcSpawnTabPayload, IpcTabInfo, IpcTabStatusPayload, SessionInfo } from "../../../shared/ipc-types";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { closeActiveTab } from "../../lib/tab-close";
import { useComposerStore } from "../../stores/composer";
import { type MessagesStore, useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { deleteSessionRuntime } from "../../stores/session-runtime-context";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useSubagentsStore } from "../../stores/subagents";
import { createTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { TabHousekeeping } from "./TabHousekeeping";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(window as unknown as { innerHeight: number; innerWidth: number }).innerWidth = 1024;
(window as unknown as { innerHeight: number; innerWidth: number }).innerHeight = 768;

interface TestElement {
	textContent: string | null;
	remove(): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): TestElement[];
	appendChild(child: TestElement): void;
}

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function listedSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		title: null,
		cwd: "/work/infron",
		created: "2026-08-16T00:00:00Z",
		modified: "2026-08-16T00:00:00Z",
		messageCount: 0,
		size: 512,
		status: "complete",
		firstMessage: "",
		...overrides,
	};
}

interface MockOmp {
	sessions: {
		list: Mock<() => Promise<SessionInfo[]>>;
		/** The feed's read, answered by `list` (a test sets that). */
		listShared: () => Promise<{ version: string; sessions: SessionInfo[] }>;
	};
	tabs: {
		list: Mock<() => Promise<IpcTabInfo[]>>;
		spawn: Mock<(payload: IpcSpawnTabPayload) => Promise<{ tabId: string } | null>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
		setView: Mock<(tabId: string, visibleTabIds: string[], split?: unknown) => Promise<boolean>>;
	};
	events: {
		onTabStatus: Mock<(callback: (payload: IpcTabStatusPayload) => void) => () => void>;
		onSessionsChanged: Mock<(callback: () => void) => () => void>;
	};
	rpc: {
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscriptPage: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
		commandForTab: Mock<(tabId: string, command: RpcCommand) => Promise<RpcResponse>>;
	};
}

function installMockOmp(): MockOmp {
	const omp: MockOmp = {
		sessions: {
			list: vi.fn(async () => []),
			listShared: async () => ({ version: "test.1", sessions: await omp.sessions.list() }),
		},
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => ({ tabId: "t9" })),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
			setView: vi.fn(async () => true),
		},
		events: {
			onTabStatus: vi.fn(() => () => {}),
			onSessionsChanged: vi.fn(() => () => {}),
		},
		rpc: {
			getState: vi.fn(async () =>
				ok({
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
				}),
			),
			getTranscriptPage: vi.fn(async () => ok({ messages: [], totalMessages: 0 })),
			getSubagents: vi.fn(async () => ok({ subagents: [] })),
			getGoal: vi.fn(async () => ok({ enabled: false })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			setSubagentSubscription: vi.fn(async () => ok({})),
			commandForTab: vi.fn(async (tabId, command) => {
				switch (command.type) {
					case "get_state":
						return ok({
							sessionId: "srv",
							sessionName: null,
							sessionFile: null,
							cwd: tabId === "t1" ? "/beta" : "/srv",
							isStreaming: false,
							isCompacting: false,
							contextUsage: null,
							messageCount: 0,
							queuedMessageCount: 0,
							planModeEnabled: false,
							todoPhases: [],
						});
					case "get_transcript_page":
						return ok({ messages: [], totalMessages: 0 });
					case "get_subagents":
						return ok({ subagents: [] });
					case "get_queue":
						return ok({ steering: [], followUp: [] });
					default:
						return ok({ enabled: false });
				}
			}),
		},
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

let omp: MockOmp;
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

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useTabsStore.getState().reset();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useSidebarPrefs.getState().reset();
	useMessagesStore.getState().reset();
	useTodoStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSubagentsStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	// The arm-confirm and worktree-prompt flags live in the UI store; a chip left
	// armed by the previous test renders ✓/✕ instead of ×, so the next test's
	// `[aria-label="Close tab"]` query finds nothing.
	useUiStore.setState({ armedCloseTab: null, worktreeClosePrompt: null });
	vi.restoreAllMocks();
	omp = installMockOmp();
});

omp = installMockOmp();

describe("TabHousekeeping", () => {
	it("removes a truly empty startup placeholder after a real session tab exists", async () => {
		omp.sessions.list.mockResolvedValue([
			listedSession("s-empty"),
			listedSession("s-real", { firstMessage: "Real work", messageCount: 2 }),
		]);
		useTabsStore.setState({
			tabs: [
				{
					kind: "chat",
					id: "t-empty",
					sessionId: "s-empty",
					cwd: "/neutral",
					status: "ready",
					placeholder: true,
					unreadDone: false,
				},
				{
					kind: "agent",
					id: "t-real",
					sessionId: "s-real",
					cwd: "/work/infron",
					status: "ready",
					placeholder: false,
					unreadDone: false,
				},
			],
			activeTabId: "t-real",
			bundles: new Map(),
		});

		await mount(<TabHousekeeping />);
		await flush();

		expect(omp.tabs.close).toHaveBeenCalledWith("t-empty");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t-real"]);
	});

	it("keeps an empty startup tab when it contains an unsent draft", async () => {
		omp.sessions.list.mockResolvedValue([
			listedSession("s-empty"),
			listedSession("s-real", { firstMessage: "Real work", messageCount: 2 }),
		]);
		useTabsStore.setState({
			tabs: [
				{
					kind: "chat",
					id: "t-empty",
					sessionId: "s-empty",
					cwd: "/neutral",
					status: "ready",
					placeholder: true,
					unreadDone: false,
				},
				{
					kind: "agent",
					id: "t-real",
					sessionId: "s-real",
					cwd: "/work/infron",
					status: "ready",
					placeholder: false,
					unreadDone: false,
				},
			],
			activeTabId: "t-empty",
			bundles: new Map(),
		});
		useComposerStore.getState().setDraft("do not lose this");

		await mount(<TabHousekeeping />);
		await flush();

		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t-empty", "t-real"]);
	});

	it("closes an empty new session the person showed and left, never one it never showed", async () => {
		omp.sessions.list.mockResolvedValue([]);
		const fresh = { kind: "agent" as const, cwd: "/work/infron", status: "ready" as const, unreadDone: false };
		useTabsStore.setState({
			tabs: [
				{ ...fresh, id: "t-left", unstarted: true },
				{ ...fresh, id: "t-background", unstarted: true },
				{ ...fresh, id: "t-now", unstarted: true },
			],
			activeTabId: "t-left",
			bundles: new Map(),
		});
		await mount(<TabHousekeeping />);
		expect(omp.tabs.close).not.toHaveBeenCalled();

		await act(async () => {
			useTabsStore.setState({ activeTabId: "t-now" });
		});
		await flush();
		expect(omp.tabs.close).toHaveBeenCalledWith("t-left");
		expect(omp.tabs.close).not.toHaveBeenCalledWith("t-background");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t-background", "t-now"]);
	});

	it("keeps a new session the person left with a prompt still waiting for its omp", async () => {
		omp.sessions.list.mockResolvedValue([]);
		const fresh = { kind: "agent" as const, cwd: "/work/infron", status: "starting" as const, unreadDone: false };
		useTabsStore.setState({
			tabs: [
				{ ...fresh, id: "t-sent", unstarted: true },
				{ ...fresh, id: "t-now", unstarted: true },
			],
			activeTabId: "t-sent",
			bundles: new Map(),
		});
		// Enter before the tab was ready: the draft is gone, the prompt an optimistic live row the ready gate holds.
		const runtime = createTabRuntime("t-sent");
		(runtime.stores.get("messages") as StoreApi<MessagesStore>).setState({
			liveMessages: [{ role: "user", content: "fix the parser", timestamp: 1 } as AgentMessage],
		});
		await mount(<TabHousekeeping />);
		await act(async () => {
			useTabsStore.setState({ activeTabId: "t-now" });
		});
		await flush();
		expect(omp.tabs.close).not.toHaveBeenCalled();
		deleteSessionRuntime("t-sent");
	});

	it("keeps a new session the person left once it holds something", async () => {
		omp.sessions.list.mockResolvedValue([]);
		const fresh = { kind: "agent" as const, cwd: "/work/infron", status: "ready" as const, unreadDone: false };
		useTabsStore.setState({
			tabs: [
				{ ...fresh, id: "t-left", unstarted: false },
				{ ...fresh, id: "t-now", unstarted: true },
			],
			activeTabId: "t-left",
			bundles: new Map(),
		});
		await mount(<TabHousekeeping />);
		await act(async () => {
			useTabsStore.setState({ activeTabId: "t-now" });
		});
		await flush();
		expect(omp.tabs.close).not.toHaveBeenCalled();
	});

	it("an armed close auto-cancels after the timeout", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "running", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabHousekeeping confirmCloseMs={25} />);

		let armed: unknown;
		await act(async () => {
			armed = closeActiveTab();
		});
		expect(armed).toBe("armed");
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 60);
			await promise;
		});

		expect(useUiStore.getState().armedCloseTab).toBeNull();
		expect(omp.tabs.close).not.toHaveBeenCalled();
	});
});
