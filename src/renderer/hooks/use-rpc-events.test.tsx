/**
 * Contract tests for the pending-model indicator: the chat must show a live
 * "waiting for model response" row between turn_start and the first streamed
 * message, because a stalled provider request (slow first event, transport
 * retry) is otherwise indistinguishable from a dead UI. Covers the
 * useRpcEvents event wiring (which events arm/clear `awaitingModelSince`) and
 * the PendingModelRow elapsed-time rendering. Rendered with react-dom/client
 * into a linkedom document (same harness as ForkHandoffDialogs.test.tsx).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSidecarStatusPayload, IpcSignIn } from "../../shared/ipc-types";
import type {
	AgentMessage,
	AgentSessionEvent,
	CommandOutputFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	ModelCatalogUpdateFrame,
	PromptResultFrame,
	RpcCommand,
	RpcResponse,
	SessionInfoUpdateFrame,
	TodoPhase,
} from "../../shared/rpc-types";
import { TurnStatusRow } from "../components/chat/ChatStream";
import { formatClock } from "../lib/format";
import { I18nProvider, translate } from "../lib/i18n";
import { useAutopilotStore } from "../stores/autopilot";
import type { ExtensionUiStore } from "../stores/extension-ui";
import { type MessagesStore, useMessagesStore } from "../stores/messages";
import { type ModelStore, useModelStore } from "../stores/model";
import type { PlanApprovalStore } from "../stores/plan-approval";
import { type SessionStore, useSessionStore } from "../stores/session";
import { sessionRuntime, sessionRuntimeStore, setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { useSettingsStore } from "../stores/settings";
import { useSubagentsStore } from "../stores/subagents";
import { ensureTabRuntime, replaceTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { selectTodoCardVisible, useTodoStore } from "../stores/todo";
import { type ToolsStore, useToolsStore } from "../stores/tools";
import { loadOlderTranscript } from "./session-hydration";
import { attachTabSession, hydrateSession, hydrateTabSession, useRpcEvents } from "./use-rpc-events";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

type BatchHandler = (events: AgentSessionEvent[]) => void;
type CommandOutputHandler = (frame: CommandOutputFrame) => void;
type PromptResultHandler = (frame: PromptResultFrame) => void;
type ModelCatalogUpdateHandler = (frame: ModelCatalogUpdateFrame) => void;
type Stamped<T extends (...args: never[]) => void> = (...args: [...Parameters<T>, tabId: string]) => void;

interface MockOmp {
	tabs: {
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
	rpc: {
		command: Mock<(command: RpcCommand) => Promise<RpcResponse>>;
		commandForTab: Mock<(tabId: string, command: RpcCommand) => Promise<RpcResponse>>;
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscriptPage: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
		getSettings: Mock<(keys?: string[]) => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
	events: {
		onTabBatch: Mock<(callback: Stamped<BatchHandler>) => () => void>;
		onTabSidecarStatus: Mock<() => () => void>;
		onTabSubagentFrame: Mock<() => () => void>;
		onTabModelCatalogUpdate: Mock<(callback: Stamped<ModelCatalogUpdateHandler>) => () => void>;
		onTabConfigUpdate: Mock<() => () => void>;
		onExtensionUi: Mock<() => () => void>;
		onSignInEnded: Mock<() => () => void>;
		onTabPromptResult: Mock<(callback: Stamped<PromptResultHandler>) => () => void>;
		onTabCommandOutput: Mock<(callback: Stamped<CommandOutputHandler>) => () => void>;
		onTabSessionInfoUpdate: Mock<(callback: (frame: SessionInfoUpdateFrame, tabId: string) => void) => () => void>;
		onTabExtensionError: Mock<(callback: (frame: ExtensionErrorFrame, tabId: string) => void) => () => void>;
	};
	sidecar: { getStatus: Mock<() => Promise<unknown>> };
	sessions: { consumePendingOpen: Mock<() => Promise<unknown>> };
	system: { notify: Mock<(title: string, body: string) => void> };
	prefs: {
		get: Mock<(key: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
}

/** Frames this harness emits belong to the focused tab, as main stamps them. */
const focusedTab = (): string => useTabsStore.getState().activeTabId ?? "";
function installMockOmp(): {
	omp: MockOmp;
	emitBatch: BatchHandler;
	emitCommandOutput: (frame: CommandOutputFrame, tabId?: string) => void;
	emitPromptResult: PromptResultHandler;
	emitModelCatalogUpdate: ModelCatalogUpdateHandler;
} {
	let batchHandler: Stamped<BatchHandler> = () => {};
	let commandOutputHandler: Stamped<CommandOutputHandler> = () => {};
	let promptResultHandler: Stamped<PromptResultHandler> = () => {};
	let modelCatalogUpdateHandler: Stamped<ModelCatalogUpdateHandler> = () => {};
	// Mirror the real server: get_state reports isStreaming=true mid-run, and
	// agent_start triggers refreshSessionState — a static mock would overwrite
	// the event-set flag with stale state and test a race production never has.
	let mockStreaming = false;
	const omp: MockOmp = {
		tabs: { setActive: vi.fn(async () => true) },
		rpc: {
			// Commands reach the per-method doubles below, so assertions read them directly.
			command: vi.fn((command: RpcCommand) => {
				switch (command.type) {
					case "get_state":
						return omp.rpc.getState();
					case "get_transcript_page":
						return omp.rpc.getTranscriptPage();
					case "get_subagents":
						return omp.rpc.getSubagents();
					case "get_goal":
						return omp.rpc.getGoal();
					case "get_queue":
						return omp.rpc.getQueue();
					case "get_settings":
						return omp.rpc.getSettings(command.paths);
					case "set_subagent_subscription":
						return omp.rpc.setSubagentSubscription(command.level);
					default:
						return Promise.resolve({
							type: "response",
							command: command.type,
							success: false,
							error: `Unsupported command: ${command.type}`,
						});
				}
			}),
			commandForTab: vi.fn((_tabId: string, command: RpcCommand) => omp.rpc.command(command)),
			getState: vi.fn(async () =>
				success({
					sessionId: "s1",
					sessionName: null,
					sessionFile: null,
					cwd: "/tmp",
					isStreaming: mockStreaming,
					isCompacting: false,
					contextUsage: null,
					messageCount: 0,
					queuedMessageCount: 0,
					planModeEnabled: false,
					todoPhases: [],
				}),
			),
			getTranscriptPage: vi.fn(async () => success({ messages: [], totalMessages: 0 })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
			getGoal: vi.fn(async () => success({ enabled: false })),
			getQueue: vi.fn(async () => success({ steering: [], followUp: [] })),
			getSettings: vi.fn(async () => success({ values: {} })),
			setSubagentSubscription: vi.fn(async () => success({})),
		},
		events: {
			onTabBatch: vi.fn((callback: Stamped<BatchHandler>) => {
				batchHandler = callback;
				return () => {};
			}),
			onTabSidecarStatus: vi.fn(() => () => {}),
			onTabSubagentFrame: vi.fn(() => () => {}),
			onTabModelCatalogUpdate: vi.fn((callback: Stamped<ModelCatalogUpdateHandler>) => {
				modelCatalogUpdateHandler = callback;
				return () => {};
			}),
			onTabConfigUpdate: vi.fn(() => () => {}),
			onExtensionUi: vi.fn(() => () => {}),
			onSignInEnded: vi.fn(() => () => {}),
			onTabPromptResult: vi.fn((callback: Stamped<PromptResultHandler>) => {
				promptResultHandler = callback;
				return () => {};
			}),
			onTabCommandOutput: vi.fn((callback: Stamped<CommandOutputHandler>) => {
				commandOutputHandler = callback;
				return () => {};
			}),
			onTabSessionInfoUpdate: vi.fn(() => () => {}),
			onTabExtensionError: vi.fn(() => () => {}),
		},
		sidecar: { getStatus: vi.fn(async () => ({ status: "ready", cwd: "/tmp" })) },
		// Boot pulls the pending "open in new window" session before hydrating;
		// null = none pending (the plain-attach path this suite drives).
		sessions: { consumePendingOpen: vi.fn(async () => null) },
		system: { notify: vi.fn() },
		prefs: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
		},
	};
	const ompWindow = window as unknown as { omp: MockOmp };
	ompWindow.omp = omp;
	const emitBatch: BatchHandler = events => {
		for (const event of events) {
			if (event.type === "agent_start") mockStreaming = true;
			if (event.type === "agent_end") mockStreaming = false;
		}
		batchHandler(events, focusedTab());
	};
	return {
		omp,
		emitBatch,
		emitCommandOutput: (frame, tabId = focusedTab()) => commandOutputHandler(frame, tabId),
		emitPromptResult: frame => promptResultHandler(frame, focusedTab()),
		emitModelCatalogUpdate: frame => modelCatalogUpdateHandler(frame, focusedTab()),
	};
}

type TabBatchHandler = (events: AgentSessionEvent[], tabId: string) => void;
type TabSidecarStatusHandler = (payload: IpcSidecarStatusPayload, tabId: string) => void;

/**
 * Tab-routed variant of the legacy harness above: the modern preload exposes
 * onTabBatch/onTabSidecarStatus envelopes and rpc.commandForTab, so events
 * arrive stamped with their originating tab.
 */
function installTabRoutedMockOmp(): {
	emitTabBatch: TabBatchHandler;
	emitTabStatus: TabSidecarStatusHandler;
	notify: Mock<(title: string, body: string) => void>;
	commandForTab: Mock<(tabId: string, command: RpcCommand) => Promise<RpcResponse>>;
} {
	let tabBatchHandler: TabBatchHandler = () => {};
	let tabStatusHandler: TabSidecarStatusHandler = () => {};
	const commandForTab = vi.fn(async (_tabId: string, command: RpcCommand): Promise<RpcResponse> => {
		switch (command.type) {
			case "get_state":
				return success({
					sessionId: "s1",
					sessionName: null,
					sessionFile: null,
					cwd: "/tmp",
					isStreaming: false,
					isCompacting: false,
					contextUsage: null,
					messageCount: 0,
					queuedMessageCount: 0,
					planModeEnabled: false,
					todoPhases: [],
				});
			case "get_transcript_page":
				return success({ messages: [], totalMessages: 0 });
			case "get_subagents":
				return success({ subagents: [] });
			case "get_goal":
				return success({ enabled: false });
			case "get_queue":
				return success({ steering: [], followUp: [] });
			case "get_settings":
				return success({ values: {} });
			default:
				return success({});
		}
	});
	const noopSub = vi.fn(() => () => {});
	const notify = vi.fn();
	const omp = {
		tabs: {
			list: vi.fn(async () => []),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
			setView: vi.fn(async () => true),
		},
		rpc: {
			commandForTab,
			getState: vi.fn(async () => success({})),
		},
		events: {
			onTabBatch: vi.fn((callback: TabBatchHandler) => {
				tabBatchHandler = callback;
				return () => {};
			}),
			onTabSidecarStatus: vi.fn((callback: TabSidecarStatusHandler) => {
				tabStatusHandler = callback;
				return () => {};
			}),
			onTabSubagentFrame: noopSub,
			onTabModelCatalogUpdate: noopSub,
			onTabConfigUpdate: noopSub,
			onExtensionUi: noopSub,
			onSignInEnded: noopSub,
			onTabPromptResult: noopSub,
			onTabCommandOutput: noopSub,
			onTabSessionInfoUpdate: noopSub,
			onTabExtensionError: noopSub,
		},
		sidecar: { getStatus: vi.fn(async () => ({ status: "ready", cwd: "/tmp" })) },
		sessions: { consumePendingOpen: vi.fn(async () => null) },
		system: { notify },
		prefs: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
	};
	(window as unknown as { omp: typeof omp }).omp = omp;
	return {
		emitTabBatch: (events, tabId) => tabBatchHandler(events, tabId),
		emitTabStatus: (payload, tabId) => tabStatusHandler(payload, tabId),
		notify,
		commandForTab,
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

/** Renders the hook under test with no visible chrome of its own. */
function RpcEventsProbe({ heartbeatMs }: { heartbeatMs?: number } = {}) {
	useRpcEvents(heartbeatMs);
	return null;
}

it("does not let a delayed startup snapshot clear the task selected after the request", async () => {
	installTabRoutedMockOmp();
	const status = Promise.withResolvers<IpcSidecarStatusPayload>();
	vi.spyOn(window.omp.sidecar, "getStatus").mockReturnValue(status.promise);
	useTabsStore.setState({
		tabs: [
			{ id: "t0", kind: "agent", cwd: "/alpha", status: "ready", unreadDone: false },
			{ id: "t1", kind: "agent", cwd: "/beta", status: "ready", unreadDone: false },
		],
		activeTabId: "t0",
	});
	ensureTabRuntime("t0");
	ensureTabRuntime("t1");
	setFocusedSessionRuntime("t0");
	await mount(<RpcEventsProbe />);
	const other = sessionRuntimeStore<MessagesStore>("t1", "messages")!;
	other.getState().appendMessage({ role: "user", content: "Task B history", timestamp: 1 });
	useTabsStore.setState({ activeTabId: "t1" });
	setFocusedSessionRuntime("t1");
	status.resolve({ status: "starting", cwd: "/alpha" });
	await flush();
	expect(other.getState().messages).toMatchObject([{ content: "Task B history" }]);
});

it("does not roll a ready task back to starting when its older startup snapshot resolves", async () => {
	const { emitTabStatus } = installTabRoutedMockOmp();
	const status = Promise.withResolvers<IpcSidecarStatusPayload>();
	vi.spyOn(window.omp.sidecar, "getStatus").mockReturnValue(status.promise);
	useTabsStore.setState({
		tabs: [{ id: "t0", kind: "agent", cwd: "/alpha", status: "starting", unreadDone: false }],
		activeTabId: "t0",
	});
	ensureTabRuntime("t0");
	setFocusedSessionRuntime("t0");
	await mount(<RpcEventsProbe />);
	emitTabStatus({ status: "ready", cwd: "/alpha" }, "t0");
	await flush();
	const messages = sessionRuntimeStore<MessagesStore>("t0", "messages")!;
	messages.getState().appendMessage({ role: "user", content: "History loaded after ready", timestamp: 1 });
	status.resolve({ status: "starting", cwd: "/alpha" });
	await flush();
	expect(sessionRuntimeStore<SessionStore>("t0", "session")?.getState().status).toBe("ready");
	expect(messages.getState().messages).toMatchObject([{ content: "History loaded after ready" }]);
});

const assistantMessage: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useTabsStore.getState().reset();
	useAutopilotStore.getState().reset();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	useTodoStore.getState().reset();
	useSettingsStore.getState().reset();
	useSubagentsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	vi.restoreAllMocks();
});

describe("useRpcEvents thinking selection sync", () => {
	it("replaces a stale auto selector when an explicit level event omits configured", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ thinkingLevel: "low", thinkingConfigured: "auto" });

		await act(async () => {
			emitBatch([{ type: "thinking_level_changed", thinkingLevel: "high" }]);
		});

		expect(useModelStore.getState().thinkingLevel).toBe("high");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
	});

	it("keeps auto selected while updating its effective resolved level", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ thinkingLevel: "medium", thinkingConfigured: "medium" });

		await act(async () => {
			emitBatch([{ type: "thinking_level_changed", thinkingLevel: "xhigh", configured: "auto" }]);
		});

		expect(useModelStore.getState().thinkingLevel).toBe("xhigh");
		expect(useModelStore.getState().thinkingConfigured).toBe("auto");
	});

	it("remembers the effort auto picked for the turn until the selection changes", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ thinkingLevel: "medium", thinkingConfigured: "auto" });

		await act(async () => {
			emitBatch([{ type: "thinking_level_changed", thinkingLevel: "high", configured: "auto", resolved: "high" }]);
		});
		expect(useModelStore.getState().thinkingAutoResolved).toBe("high");

		// A same-session re-read at that effort keeps it; any other effort or selector drops it.
		const state = { thinkingLevel: "high", thinkingConfigured: "auto", tokensPerSecond: null } as const;
		useModelStore.getState().setFromState(state as never);
		expect(useModelStore.getState().thinkingAutoResolved).toBe("high");
		useModelStore.getState().setFromState({ ...state, thinkingLevel: "low" } as never);
		expect(useModelStore.getState().thinkingAutoResolved).toBeUndefined();

		await act(async () => {
			emitBatch([{ type: "thinking_level_changed", thinkingLevel: "low", configured: "auto" }]);
		});
		expect(useModelStore.getState().thinkingAutoResolved).toBeUndefined();
	});
});

describe("useRpcEvents model switch sync", () => {
	it("lands a model switch whose get_state races a trailing event from the same batch", async () => {
		const { emitTabBatch, commandForTab } = installTabRoutedMockOmp();
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t-model", cwd: "/alpha", status: "ready", unreadDone: false }],
			activeTabId: "t-model",
		});
		ensureTabRuntime("t-model");
		setFocusedSessionRuntime("t-model");
		await mount(<RpcEventsProbe />);
		await flush();

		const session = sessionRuntimeStore<SessionStore>("t-model", "session")!;
		const model = sessionRuntimeStore<ModelStore>("t-model", "model")!;
		session.getState().reset();
		model.getState().reset();
		session.setState({ sessionId: "s1", isStreaming: true });
		model.setState({ model: { provider: "old", id: "m-old" } });

		// Hold get_state open until the batch has been fully reduced, matching the
		// real 32ms batch where model_changed is followed by the switch's own
		// thinking_level_changed / tool-reconciliation notice frames.
		const state = Promise.withResolvers<RpcResponse>();
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation((tabId, command) =>
			command.type === "get_state" ? state.promise : original(tabId, command),
		);
		await act(async () => {
			emitTabBatch(
				[
					{ type: "model_changed" },
					{ type: "thinking_level_changed", thinkingLevel: "high" },
					{ type: "notice", level: "info", message: "vision mounted", source: "vision" },
				],
				"t-model",
			);
		});
		state.resolve(
			success({
				sessionId: "s1",
				sessionName: null,
				sessionFile: null,
				cwd: "/tmp",
				model: { provider: "new", id: "m-new" },
				thinkingLevel: "high",
				availableThinkingLevels: ["high"],
				isStreaming: false,
				isCompacting: false,
				contextUsage: { tokens: 100, contextWindow: 2000, percent: 5 },
				messageCount: 0,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		await flush();

		// The switch itself must survive the event churn that used to invalidate
		// the whole snapshot, and the new context window comes with it.
		expect(model.getState().model).toMatchObject({ provider: "new", id: "m-new" });
		expect(model.getState().thinkingLevel).toBe("high");
		expect(session.getState().contextUsage).toMatchObject({ contextWindow: 2000 });
		// A model-scoped refresh owns the model slice only: the mid-run streaming
		// flag belongs to agent_start/agent_end, not to this snapshot.
		expect(session.getState().isStreaming).toBe(true);
	});
});

function settledState(overrides: Record<string, unknown>): RpcResponse {
	return success({
		sessionId: "s1",
		sessionName: null,
		sessionFile: null,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		messageCount: 4,
		queuedMessageCount: 0,
		planModeEnabled: false,
		todoPhases: [],
		...overrides,
	});
}

function seedReadyTab(tabId: string) {
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: tabId, cwd: "/alpha", status: "ready", unreadDone: false }],
		activeTabId: tabId,
	});
	ensureTabRuntime(tabId);
	setFocusedSessionRuntime(tabId);
	const session = sessionRuntimeStore<SessionStore>(tabId, "session")!;
	session.getState().reset();
	session.setState({ sessionId: "s1", status: "ready" });
	return session;
}

describe("useRpcEvents context usage sync", () => {
	it("lands the turn's usage reading from a get_state that raced a trailing event", async () => {
		const { emitTabBatch, commandForTab } = installTabRoutedMockOmp();
		const session = seedReadyTab("t-usage");
		session.setState({ contextUsage: { tokens: 40, contextWindow: 2000, percent: 2 } });
		await mount(<RpcEventsProbe />);
		// Drain the boot hydration's command chain first: a get_state still in
		// flight would be caught by the interceptor below and apply the same
		// snapshot through the unguarded hydrate path, hiding the race.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 60);
			await promise;
		});
		session.setState({ contextUsage: { tokens: 40, contextWindow: 2000, percent: 2 } });

		// Hold get_state open until the batch has been fully reduced: agent_end
		// queues the refresh, then the notice behind it moves eventVersion.
		const state = Promise.withResolvers<RpcResponse>();
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation((id, command) =>
			command.type === "get_state" ? state.promise : original(id, command),
		);
		await act(async () => {
			emitTabBatch(
				[{ type: "agent_end" }, { type: "notice", level: "info", message: "task finished", source: "task" }],
				"t-usage",
			);
		});
		state.resolve(settledState({ contextUsage: { tokens: 1200, contextWindow: 2000, percent: 60 } }));
		await flush();

		// The trailing event invalidates the snapshot for everything an event
		// carries — usage has no event carrier, so the turn's reading must land.
		expect(session.getState().contextUsage).toMatchObject({ tokens: 1200, percent: 60 });
	});

	it("refreshes the usage ring from the liveness probe while the session idles", async () => {
		const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
		const session = seedReadyTab("t-idle");
		await mount(<RpcEventsProbe heartbeatMs={25} />);
		emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-idle");
		await flush();
		session.setState({ contextUsage: null });

		const original = commandForTab.getMockImplementation()!;
		const getState = vi
			.spyOn(window.omp.rpc, "commandForTab")
			.mockImplementation((tabId, command) =>
				command.type === "get_state"
					? Promise.resolve(settledState({ contextUsage: { tokens: 900, contextWindow: 1000, percent: 90 } }))
					: original(tabId, command),
			);
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 80);
			await promise;
		});

		// The probe is already paid for (it tokenises the context to answer at
		// all); a session that only idles between turns had no other way to land
		// a snapshot, so its ring stayed on the number from the last turn.
		expect(getState).toHaveBeenCalledWith("t-idle", { type: "get_state", brief: true }, undefined);
		expect(session.getState().contextUsage).toMatchObject({ tokens: 900 });
		expect(session.getState().statsPulse).toBeGreaterThan(0);
	});
	it("refreshes visible unfocused panes and keeps their failure diagnostics independent", async () => {
		const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
		const first = seedReadyTab("t-first");
		ensureTabRuntime("t-second");
		const second = sessionRuntimeStore<SessionStore>("t-second", "session")!;
		useTabsStore.setState(state => ({
			tabs: [...state.tabs, { kind: "agent", id: "t-second", cwd: "/beta", status: "ready", unreadDone: false }],
			split: { axis: "columns", ratio: 0.5, first: { tabId: "t-first" }, second: { tabId: "t-second" } },
		}));
		await mount(<RpcEventsProbe heartbeatMs={25} />);
		emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-first");
		emitTabStatus({ status: "ready", cwd: "/beta" }, "t-second");
		await flush();
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation((tabId, command) =>
			command.type === "get_state"
				? Promise.resolve(
						settledState({ contextUsage: { tokens: tabId === "t-first" ? 100 : 800, contextWindow: 1000 } }),
					)
				: original(tabId, command),
		);
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 80);
			await promise;
		});
		expect(first.getState().contextUsage?.tokens).toBe(100);
		expect(second.getState().contextUsage?.tokens).toBe(800);
		emitTabStatus({ status: "error", cwd: "/beta", message: "Second pane failed" }, "t-second");
		await flush();
		expect(second.getState().sidecarError).toBe("Second pane failed");
		expect(first.getState().sidecarError).toBeNull();
		expect(useTabsStore.getState().activeTabId).toBe("t-first");
	});

	describe("liveness probe", () => {
		async function wait(ms: number): Promise<void> {
			await act(async () => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, ms);
				await promise;
			});
		}
		function failGetState(
			commandForTab: ReturnType<typeof installTabRoutedMockOmp>["commandForTab"],
			fail: () => boolean,
		) {
			const original = commandForTab.getMockImplementation()!;
			commandForTab.mockImplementation((tabId, command) =>
				command.type === "get_state" && fail()
					? Promise.reject(new Error("RPC timeout (8000ms): get_state"))
					: original(tabId, command),
			);
		}

		it("does not call omp unresponsive for one slow answer that the next probe gets", async () => {
			const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
			const session = seedReadyTab("t-slow");
			await mount(<RpcEventsProbe heartbeatMs={25} />);
			emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-slow");
			await flush();
			let failures = 1;
			const seen: (string | null)[] = [];
			const off = session.subscribe(state => seen.push(state.sidecarError));
			failGetState(commandForTab, () => failures-- > 0);
			await wait(120);
			off();
			expect(seen.filter(Boolean)).toEqual([]);
			expect(session.getState().sidecarError).toBeNull();
		});

		it("does not call omp unresponsive while its events keep arriving", async () => {
			const { emitTabStatus, emitTabBatch, commandForTab } = installTabRoutedMockOmp();
			const session = seedReadyTab("t-busy");
			await mount(<RpcEventsProbe heartbeatMs={25} />);
			emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-busy");
			await flush();
			failGetState(commandForTab, () => true);
			for (let i = 0; i < 6; i++) {
				await act(async () => emitTabBatch([{ type: "turn_start" } as never], "t-busy"));
				await wait(20);
			}
			expect(session.getState().sidecarError).toBeNull();
		});

		it("still calls a wedged omp unresponsive: probes keep failing and nothing arrives", async () => {
			const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
			const session = seedReadyTab("t-wedged");
			await mount(<RpcEventsProbe heartbeatMs={25} />);
			emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-wedged");
			await flush();
			failGetState(commandForTab, () => true);
			await wait(150);
			expect(session.getState().sidecarError).toBe(translate("events.sidecarNoResponse"));
		});

		it("takes the unresponsive banner down once the omp's frames arrive again, and leaves any other error", async () => {
			const { emitTabStatus, emitTabBatch, commandForTab } = installTabRoutedMockOmp();
			const session = seedReadyTab("t-back");
			await mount(<RpcEventsProbe heartbeatMs={25} />);
			emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-back");
			await flush();
			failGetState(commandForTab, () => true);
			await wait(150);
			expect(session.getState().sidecarError).toBe(translate("events.sidecarNoResponse"));
			await act(async () => emitTabBatch([{ type: "turn_start" } as never], "t-back"));
			expect(session.getState().sidecarError).toBeNull();

			session.getState().setSidecarError("omp exited with code 1");
			await act(async () => emitTabBatch([{ type: "turn_start" } as never], "t-back"));
			expect(session.getState().sidecarError).toBe("omp exited with code 1");
		});
	});
});

describe("useRpcEvents on a dropped link", () => {
	it("leaves no rejection unhandled when the subagent subscription's call is lost (a phone page during a relaunch)", async () => {
		const harness = installTabRoutedMockOmp();
		seedReadyTab("t-drop");
		await mount(<RpcEventsProbe />);
		await act(async () => {
			await attachTabSession("t-drop");
		});
		const original = harness.commandForTab.getMockImplementation()!;
		harness.commandForTab.mockImplementation((id, command) =>
			command.type === "set_subagent_subscription"
				? Promise.reject(new Error("The link to the computer dropped"))
				: original(id, command),
		);
		const unhandled: unknown[] = [];
		const listen = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listen);
		try {
			await act(async () => {
				await hydrateTabSession("t-drop");
			});
			await new Promise(resolve => setTimeout(resolve, 0));
		} finally {
			process.off("unhandledRejection", listen);
		}
		expect(harness.commandForTab.mock.calls.some(([, command]) => command.type === "set_subagent_subscription")).toBe(
			true,
		);
		expect(unhandled).toEqual([]);
	});
});

describe("useRpcEvents snapshot churn", () => {
	/** Mount on a settled tab, then park every later get_state until the test answers it. */
	async function holdNextState(tabId: string) {
		const harness = installTabRoutedMockOmp();
		const session = seedReadyTab(tabId);
		await mount(<RpcEventsProbe />);
		// Join the boot hydration so none of its reads reach the hold below.
		await act(async () => {
			await attachTabSession(tabId);
		});
		const state = Promise.withResolvers<RpcResponse>();
		const original = harness.commandForTab.getMockImplementation()!;
		harness.commandForTab.mockImplementation((id, command) =>
			command.type === "get_state" ? state.promise : original(id, command),
		);
		const model = sessionRuntimeStore<ModelStore>(tabId, "model")!;
		return { ...harness, session, model, state };
	}

	it("lands the boot snapshot when the bridge's first token_rate frame arrives mid-fetch", async () => {
		const { emitTabBatch, session, model, state } = await holdNextState("t-boot");
		let hydration = Promise.resolve();
		await act(async () => {
			hydration = hydrateTabSession("t-boot");
		});
		await act(async () => {
			emitTabBatch([{ type: "token_rate", rate: null }], "t-boot");
		});
		state.resolve(settledState({ model: { provider: "p", id: "m" }, planModeEnabled: true }));
		await act(async () => {
			await hydration;
		});

		// A rate reading changes nothing the snapshot reports. Counted as churn it
		// discarded the whole boot snapshot, so plan review stayed disabled.
		expect(model.getState().model).toMatchObject({ provider: "p", id: "m" });
		expect(session.getState().planModeEnabled).toBe(true);
	});

	it("lands the boot snapshot when the bridge's read metadata arrives mid-fetch", async () => {
		const { emitTabBatch, session, model, state } = await holdNextState("t-read-meta");
		let hydration = Promise.resolve();
		await act(async () => {
			hydration = hydrateTabSession("t-read-meta");
		});
		await act(async () => {
			emitTabBatch([{ type: "read_group_metadata", toolCallId: "r1", target: { path: "a.ts" } }], "t-read-meta");
		});
		state.resolve(settledState({ model: { provider: "p", id: "m" }, planModeEnabled: true }));
		await act(async () => {
			await hydration;
		});

		// The metadata joins its call in the tools store whichever lands first; it is no reason
		// to drop the snapshot's model and modes.
		expect(model.getState().model).toMatchObject({ provider: "p", id: "m" });
		expect(session.getState().planModeEnabled).toBe(true);
	});

	it("keeps the composer modes and model selection of a hydration that a lifecycle frame outdated", async () => {
		const { emitTabBatch, session, model, state } = await holdNextState("t-churn");
		let hydration = Promise.resolve();
		await act(async () => {
			hydration = hydrateTabSession("t-churn");
		});
		await act(async () => {
			emitTabBatch([{ type: "queue_update", steering: [], followUp: [] }], "t-churn");
		});
		state.resolve(
			settledState({
				model: { provider: "p", id: "m" },
				thinkingLevel: "high",
				thinkingConfigured: "auto",
				planModeEnabled: true,
				prewalkArmed: true,
				agentsPaused: true,
				agentsPausedAt: 42,
			}),
		);
		await act(async () => {
			await hydration;
		});

		// No event carries the modes, so the frame cannot have outdated them.
		expect(session.getState()).toMatchObject({
			planModeEnabled: true,
			prewalkArmed: true,
			agentsPaused: true,
			agentsPausedAt: 42,
		});
		// Nor the model: dropped, a relaunch into a busy session showed
		// "Choose model" and thinking off until the next model switch.
		expect(model.getState()).toMatchObject({
			model: { provider: "p", id: "m" },
			thinkingLevel: "high",
			thinkingConfigured: "auto",
		});
	});

	it("keeps a thinking change that landed while an outdated snapshot was in flight", async () => {
		const { emitTabBatch, model, state } = await holdNextState("t-thinking");
		let hydration = Promise.resolve();
		await act(async () => {
			hydration = hydrateTabSession("t-thinking");
		});
		await act(async () => {
			emitTabBatch([{ type: "thinking_level_changed", thinkingLevel: "low" }], "t-thinking");
		});
		state.resolve(
			settledState({ model: { provider: "p", id: "m" }, thinkingLevel: "high", thinkingConfigured: "high" }),
		);
		await act(async () => {
			await hydration;
		});

		// The event is newer than the snapshot, so its level stands.
		expect(model.getState()).toMatchObject({ thinkingLevel: "low", thinkingConfigured: "low" });
	});

	it("keeps plan mode from a turn-end refresh that a trailing frame outdated", async () => {
		const { emitTabBatch, session, state } = await holdNextState("t-refresh");
		await act(async () => {
			emitTabBatch([{ type: "agent_end" }, { type: "queue_update", steering: [], followUp: [] }], "t-refresh");
		});
		state.resolve(settledState({ planModeEnabled: true }));
		await flush();

		expect(session.getState().planModeEnabled).toBe(true);
	});
});

describe("useRpcEvents awaiting-model marker", () => {
	it("arms on agent/turn start and clears when the assistant message finalizes", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		expect(useSessionStore.getState().awaitingModelSince).toBeNull();

		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }]);
		});
		expect(useSessionStore.getState().isStreaming).toBe(true);
		const armedAt = useSessionStore.getState().awaitingModelSince;
		expect(typeof armedAt).toBe("number");

		// The empty-shell phase keeps the marker: message_start fires before
		// the first token, and the status row must survive it.
		await act(async () => {
			emitBatch([{ type: "message_start", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "message_end", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("re-arms per turn and clears on turn_end and agent_end", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }, { type: "turn_start" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		// Tool execution window: running tool cards carry the activity signal.
		await act(async () => {
			emitBatch([{ type: "turn_end" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
		expect(useSessionStore.getState().isStreaming).toBe(true);

		await act(async () => {
			emitBatch([{ type: "turn_start" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "agent_end", messages: [], isTerminal: false }]);
		});
		expect(useSessionStore.getState().isStreaming).toBe(false);
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("drives the retry row state and re-arms the model wait on success", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		// Retry delay window: not a model wait — the inline retry row owns the chat.
		await act(async () => {
			emitBatch([
				{ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 9000, errorMessage: "stream stalled" },
			]);
		});
		const retryInfo = useSessionStore.getState().retryInfo;
		expect(retryInfo?.attempt).toBe(2);
		expect(retryInfo?.maxAttempts).toBe(5);
		expect(retryInfo?.delayMs).toBe(9000);
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();

		// Mirror of the TUI's #ensureWorkingLoaderWhileStreaming: a succeeded
		// retry re-arms the wait for the re-dispatched turn's first content.
		await act(async () => {
			emitBatch([{ type: "auto_retry_end", success: true, attempt: 2 }]);
		});
		expect(useSessionStore.getState().retryInfo).toBeNull();
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "agent_end", messages: [], isTerminal: false }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("announces no failure for a turn main holds until the connection is back", async () => {
		const { emitBatch, omp } = installMockOmp();
		useTabsStore.setState({
			tabs: [{ id: "t1", kind: "agent", cwd: "/w", status: "running", unreadDone: false, awaitingConnection: true }],
			activeTabId: "t1",
		});
		await mount(<RpcEventsProbe />);
		const failed: AgentMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "Connection error.",
		};
		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }]);
			emitBatch([
				{ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 500, errorMessage: "Connection error." },
			]);
			emitBatch([
				{ type: "agent_end", messages: [failed] },
				{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
			]);
		});
		expect(useToastStore.getState().toasts).toEqual([]);
		expect(omp.system.notify).not.toHaveBeenCalled();
	});

	it("keeps a long quota wait visible after its notification expires", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const { emitBatch } = installMockOmp();
			await mount(
				<>
					<RpcEventsProbe />
					<TurnStatusRow />
				</>,
			);
			const delayMs = 2 * 24 * 60 * 60 * 1000;
			await act(async () => {
				emitBatch([
					{
						type: "auto_retry_start",
						attempt: 1,
						maxAttempts: 3,
						delayMs,
						errorMessage: "Weekly quota exhausted",
					},
				]);
			});
			expect(document.body.textContent).toContain(formatClock(now + delayMs));
			expect(document.body.textContent).not.toContain("172800s");
			// The toast names the reason in plain words; the raw provider text stays on the status row.
			const toasts = useToastStore.getState().toasts;
			const notification = toasts.find(item => item.message.includes("Usage limit reached"));
			expect(notification?.expiresAt).toBeLessThan(now + 60_000);
			await act(async () => {
				clock.mockReturnValue(now + 60_000);
				useToastStore.getState().pruneExpired();
				clock.mockReturnValue(now + 61_000);
				useToastStore.getState().pruneExpired();
			});
			expect(useToastStore.getState().toasts.some(item => item.id === notification?.id)).toBe(false);
			expect(useSessionStore.getState().retryInfo?.delayMs).toBe(delayMs);
			expect(document.body.textContent).toContain("Weekly quota exhausted");
		} finally {
			clock.mockRestore();
		}
	});

	it("drives the compaction row state across the maintenance window", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitBatch([{ type: "auto_compaction_start", reason: "overflow", action: "compact" }]);
		});
		expect(useSessionStore.getState().isCompacting).toBe(true);
		expect(useSessionStore.getState().compactionInfo).toEqual({ reason: "overflow", action: "compact" });

		await act(async () => {
			emitBatch([
				{ type: "auto_compaction_end", action: "compact", result: null, aborted: false, willRetry: false },
			]);
		});
		expect(useSessionStore.getState().isCompacting).toBe(false);
		expect(useSessionStore.getState().compactionInfo).toBeNull();
	});

	it("keeps the marker through the user-prompt echo, clearing only on assistant message_end", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		// Wire order per agent-loop: turn_start → user echo (message_start/end)
		// → model wait → assistant stream → assistant message_end. Neither the
		// echo nor the assistant's empty-shell message_start may clear the row.
		await act(async () => {
			emitBatch([
				{ type: "agent_start", sessionId: "s1" },
				{ type: "turn_start" },
				{ type: "message_start", message: { role: "user", content: [], timestamp: Date.now() } },
				{ type: "message_end", message: { role: "user", content: [], timestamp: Date.now() } },
			]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "message_start", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "message_end", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("arms the marker when attaching to an already-streaming session", async () => {
		const { omp } = installMockOmp();
		// Server reports a run already in flight at attach time — agent_start
		// was missed, so hydration must re-arm the status row (TUI guest-attach
		// parity).
		omp.rpc.getState.mockImplementation(async () =>
			success({
				sessionId: "s1",
				sessionName: null,
				sessionFile: null,
				cwd: "/tmp",
				isStreaming: true,
				isCompacting: false,
				contextUsage: null,
				messageCount: 3,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		await mount(<RpcEventsProbe />);
		await flush();
		expect(useSessionStore.getState().isStreaming).toBe(true);
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();
	});
});

describe("useRpcEvents todo lifecycle", () => {
	it("archives a todo tool result immediately without waiting for agent_end", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		await flush();
		const pending: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "pending" }] }];

		await act(async () => {
			emitBatch([
				{
					type: "tool_execution_end",
					toolCallId: "todo-1",
					toolName: "todo",
					result: {
						content: [{ type: "text", text: "Todo list updated" }],
						details: { op: "init", phases: pending, storage: "session" },
					},
					isError: false,
				},
			]);
		});

		const state = useTodoStore.getState();
		expect(state.phases[0]?.tasks[0]?.status).toBe("pending");
		expect(state.history).toHaveLength(1);
		expect(state.history[0]?.phases).toEqual(pending);
	});

	it("archives the wire turn timestamp instead of its later presentation-frame receipt", async () => {
		const { emitBatch } = installMockOmp();
		vi.spyOn(Date, "now").mockReturnValue(1791827442700);
		await mount(<RpcEventsProbe />);
		const message: AgentMessage = {
			role: "assistant",
			timestamp: 1791827438373,
			content: [{ type: "toolCall", id: "todo-source-clock", name: "todo", arguments: {} }],
		};
		const phases: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Read", status: "in_progress" }] }];
		await act(async () =>
			emitBatch([
				{ type: "agent_start" },
				{ type: "message_start", message },
				{ type: "message_end", message },
				{
					type: "tool_execution_end",
					toolCallId: "todo-source-clock",
					toolName: "todo",
					result: { content: [{ type: "text", text: "Todos updated" }], details: { phases } },
					isError: false,
				},
			]),
		);
		expect(useTodoStore.getState().turnSourceKnown).toBe(true);
		expect(useTodoStore.getState().history[0]?.turnStartedAt).toBe(1791827438373);
		expect(useTodoStore.getState().history[0]?.duringTurn).toBe(true);
	});

	it("recovers a missed turn boundary from the authoritative transcript on mid-run hydration", async () => {
		const { omp } = installMockOmp();
		vi.spyOn(Date, "now").mockReturnValue(1791827442700);
		omp.rpc.getState.mockResolvedValue(
			success({
				sessionId: "s1",
				sessionName: null,
				sessionFile: null,
				cwd: "/tmp",
				isStreaming: true,
				isCompacting: false,
				contextUsage: null,
				messageCount: 3,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		omp.rpc.getTranscriptPage.mockResolvedValue(
			success({
				messages: [
					{ role: "user", entryId: "earlier-user", timestamp: 1791827421351, content: "Edit notes.txt" },
					{ role: "user", entryId: "todo-user", timestamp: 1791827436493, content: "Use your todo tool" },
					{
						role: "assistant",
						entryId: "todo-call",
						timestamp: 1791827438373,
						content: [{ type: "toolCall", id: "todo-call", name: "todo", arguments: {} }],
					},
				],
				totalMessages: 3,
			}),
		);
		await mount(<RpcEventsProbe />);
		await act(async () => hydrateSession());
		expect(useTodoStore.getState().turnStartedAt).toBe(1791827438373);
		expect(useTodoStore.getState().turnSourceKnown).toBe(true);
		useTodoStore.getState().setPhases([{ name: "Work", tasks: [{ content: "Read", status: "in_progress" }] }]);
		expect(useTodoStore.getState().history[0]?.turnStartedAt).toBe(1791827438373);
		// A subsequent refresh must not backdate a source-known run into older input.
		omp.rpc.getTranscriptPage.mockResolvedValue(
			success({
				messages: [{ role: "user", entryId: "earlier-user", timestamp: 1791827421351, content: "Edit notes.txt" }],
				totalMessages: 1,
			}),
		);
		await act(async () => hydrateSession());
		expect(useTodoStore.getState().turnStartedAt).toBe(1791827438373);
	});

	it("keeps one completed snapshot when automatic cleanup clears the live todos", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useTodoStore.getState().reset();
		const pending: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "pending" }] }];
		const completed: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "completed" }] }];
		useTodoStore.getState().setPhases(pending);
		useTodoStore.getState().showReminder(completed[0]!.tasks);
		useTodoStore.getState().setPhases(completed);

		await act(async () => {
			emitBatch([{ type: "todo_auto_clear" }]);
		});

		const state = useTodoStore.getState();
		expect(state.phases).toEqual([]);
		expect(state.reminderVisible).toBe(false);
		expect(state.reminderTodos).toEqual([]);
		expect(state.history).toHaveLength(1);
		expect(state.history[0]?.phases[0]?.tasks[0]?.status).toBe("completed");
	});

	function todoResult(toolCallId: string, phases: TodoPhase[]): AgentSessionEvent {
		return {
			type: "tool_execution_end",
			toolCallId,
			toolName: "todo",
			result: { content: [{ type: "text", text: "Todo list updated" }], details: { op: "update", phases } },
			isError: false,
		};
	}

	it("keeps a finished list through its turn and hides it once the turn ends", async () => {
		const { omp, emitBatch } = installMockOmp();
		const open: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "in_progress" }] }];
		const done: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "scaffold", status: "completed" },
					{ content: "dropped", status: "abandoned" },
				],
			},
		];
		// The server keeps reporting the finished list: every agent_end re-pulls it.
		let server = { isStreaming: false, todoPhases: [] as TodoPhase[] };
		omp.rpc.getState.mockImplementation(async () => settledState(server));
		await mount(<RpcEventsProbe />);
		await flush();
		const visible = () => selectTodoCardVisible(useTodoStore.getState());

		server = { isStreaming: true, todoPhases: open };
		await act(async () => emitBatch([{ type: "agent_start" }, todoResult("todo-1", open)]));
		await flush();
		expect(visible()).toBe(true);

		server = { isStreaming: true, todoPhases: done };
		await act(async () => emitBatch([todoResult("todo-2", done)]));
		await flush();
		// The turn that finished the list is still running — the card stays.
		expect(visible()).toBe(true);

		server = { isStreaming: false, todoPhases: done };
		await act(async () => emitBatch([{ type: "agent_end" }]));
		await flush();
		expect(visible()).toBe(false);
		// Only the live card goes away; the transcript snapshot keeps the finished list.
		expect(useTodoStore.getState().history.at(-1)?.phases).toEqual(done);

		// A later turn that starts with the finished list does not bring it back…
		server = { isStreaming: true, todoPhases: done };
		await act(async () => emitBatch([{ type: "agent_start" }]));
		await flush();
		expect(visible()).toBe(false);

		// …but a todo update with open work does.
		const next: TodoPhase[] = [{ name: "Ship", tasks: [{ content: "release", status: "pending" }] }];
		server = { isStreaming: true, todoPhases: next };
		await act(async () => emitBatch([todoResult("todo-3", next)]));
		expect(visible()).toBe(true);
	});

	it("does not resurface a finished list restored from session history", async () => {
		const { omp } = installMockOmp();
		const done: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "completed" }] }];
		omp.rpc.getState.mockImplementation(async () => settledState({ todoPhases: done }));
		await mount(<RpcEventsProbe />);
		await flush();

		expect(useTodoStore.getState().phases[0]?.tasks[0]?.status).toBe("completed");
		expect(selectTodoCardVisible(useTodoStore.getState())).toBe(false);
	});

	it("restores a list with open work as a visible card", async () => {
		const { omp } = installMockOmp();
		const open: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "scaffold", status: "completed" },
					{ content: "wire", status: "blocked" },
				],
			},
		];
		omp.rpc.getState.mockImplementation(async () => settledState({ todoPhases: open }));
		await mount(<RpcEventsProbe />);
		await flush();

		expect(selectTodoCardVisible(useTodoStore.getState())).toBe(true);
	});
});

describe("useRpcEvents non-transcript frames", () => {
	it("surfaces text-mode slash-command output as a local custom message", async () => {
		const { emitCommandOutput } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitCommandOutput({ type: "command_output", text: "Enabled models: gpt-5.6" });
		});

		expect(useMessagesStore.getState().messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "command",
				content: [{ type: "text", text: "Enabled models: gpt-5.6" }],
			}),
		);
	});

	it("rehydrates when a deferred prompt result reports a local-only extension command", async () => {
		const { omp, emitPromptResult } = installMockOmp();
		await mount(<RpcEventsProbe />);
		const stateCallsBefore = omp.rpc.getState.mock.calls.length;
		const transcriptCallsBefore = omp.rpc.getTranscriptPage.mock.calls.length;

		await act(async () => {
			emitPromptResult({ type: "prompt_result", id: "extension-command", agentInvoked: false });
			await Promise.resolve();
		});
		await flush();

		expect(omp.rpc.getState.mock.calls.length).toBeGreaterThan(stateCallsBefore);
		expect(omp.rpc.getTranscriptPage.mock.calls.length).toBeGreaterThan(transcriptCallsBefore);
	});

	it("applies a model catalog completion frame without reopening the picker", async () => {
		const { emitModelCatalogUpdate } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ catalogRefreshPending: true, catalogGeneration: 1, availableModels: [] });

		await act(async () => {
			emitModelCatalogUpdate({
				type: "model_catalog_update",
				models: [{ provider: "custom", id: "new-model" }],
				providers: [],
				discoveryStates: [
					{ provider: "custom", status: "ok", optional: false, stale: false, models: ["new-model"] },
				],
				refreshPending: false,
				generation: 2,
			});
		});

		expect(useModelStore.getState()).toMatchObject({
			availableModels: [{ provider: "custom", id: "new-model" }],
			catalogRefreshPending: false,
			catalogGeneration: 2,
		});
	});

	it("keeps the outgoing tab's frames out of the selected tab while the route catches up", async () => {
		const { omp, emitCommandOutput } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		ensureTabRuntime("t0");
		const route = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(route.promise);

		const switching = useTabsStore.getState().switchTab("t1");
		await act(async () => {
			emitCommandOutput({ type: "command_output", text: "belongs to t0" }, "t0");
		});
		expect(useMessagesStore.getState().messages).toEqual([]);

		route.resolve(true);
		await act(async () => switching);
		await act(async () => {
			emitCommandOutput({ type: "command_output", text: "belongs to t1" }, "t1");
		});

		expect(useMessagesStore.getState().messages).toContainEqual(
			expect.objectContaining({ content: [{ type: "text", text: "belongs to t1" }] }),
		);
	});
});

describe("useRpcEvents mode-state sync", () => {
	it("keeps a live goal update when an older hydration reply arrives later", async () => {
		const { omp, emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		await flush();
		const goal = Promise.withResolvers<RpcResponse>();
		omp.rpc.getGoal.mockReturnValueOnce(goal.promise);
		const hydration = hydrateSession();
		await act(async () =>
			emitBatch([{ type: "goal_updated", goal: { objective: "new objective", status: "active" } }]),
		);
		goal.resolve(success({ enabled: false }));
		await act(async () => hydration);
		expect(useSessionStore.getState().goal?.objective).toBe("new objective");
	});

	it("keeps the tab's Autopilot status from autopilot_update frames", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		await flush();
		expect(useAutopilotStore.getState().status).toEqual({ active: false });
		const status = { active: true, state: "running", cycle: 2, branch: "autopilot/2026-10-17" } as const;
		await act(async () => emitBatch([{ type: "autopilot_update", status }]));
		expect(useAutopilotStore.getState().status).toEqual(status);
		expect(useAutopilotStore.getState().hydrated).toBe(true);
	});

	it("hydrates the Autopilot status from get_autopilot, and a frame that lands meanwhile wins", async () => {
		const { omp, emitBatch } = installMockOmp();
		const base = omp.rpc.command.getMockImplementation();
		const old = Promise.withResolvers<RpcResponse>();
		omp.rpc.command.mockImplementation((command: RpcCommand) =>
			command.type === "get_autopilot" ? old.promise : (base?.(command) ?? Promise.resolve(success({}))),
		);
		await mount(<RpcEventsProbe />);
		await flush();
		const hydration = hydrateSession();
		await act(async () =>
			emitBatch([{ type: "autopilot_update", status: { active: true, state: "paused", reason: "user_pause" } }]),
		);
		old.resolve(success({ active: true, state: "running", cycle: 1 }));
		await act(async () => hydration);
		expect(useAutopilotStore.getState().status.state).toBe("paused");
	});

	it("hydrates project-scoped display settings into the active tab", async () => {
		const { omp } = installMockOmp();
		omp.rpc.getSettings.mockImplementation(async () =>
			success({
				values: {
					"display.showTokenUsage": false,
					"tools.approvalMode": "always-ask",
				},
			}),
		);
		await mount(<RpcEventsProbe />);
		await flush();

		expect(useSettingsStore.getState().showTokenUsage).toBe(false);
		expect(useSettingsStore.getState().approvalMode).toBe("always-ask");
	});
});

describe("retryPending reset on tab switch", () => {
	it("clears the auto-retry gate so the restored tab's failed turns still toast", async () => {
		const { emitBatch } = installMockOmp();
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useToastStore.setState({ toasts: [] });
		await mount(<RpcEventsProbe />);

		// Arm the retry gate on the outgoing tab: while it is set, agent_end
		// error toasts are suppressed as mid-saga noise.
		await act(async () => {
			emitBatch([
				{ type: "agent_start", sessionId: "s1" },
				{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: "boom" },
			]);
		});

		// The switch parks t0 and restores t1 — restoreBundle resets the gate,
		// which is module-level and would otherwise leak across tabs.
		await act(async () => {
			await useTabsStore.getState().switchTab("t1");
		});

		await act(async () => {
			emitBatch([
				{
					type: "agent_end",
					messages: [{ role: "assistant", content: [], timestamp: 1, stopReason: "error", errorMessage: "kaput" }],
				},
			]);
		});

		// The restored tab's failure surfaces; the leaked gate would have eaten it.
		expect(useToastStore.getState().toasts.some(toast => toast.title === "Response failed")).toBe(true);

		useTabsStore.getState().reset();
		useToastStore.setState({ toasts: [] });
	});
});

describe("TurnStatusRow", () => {
	it("a normal wait shows no label, interrupt hint or recovery buttons", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 5000 });
		await mount(<TurnStatusRow />);
		expect(document.querySelector("kbd")).toBeNull();
		expect(document.body.textContent).not.toContain("5s");
		expect(document.body.textContent).not.toContain("Change model");
	});

	it("renders the retry countdown with the failure detail", async () => {
		useSessionStore.setState({
			retryInfo: {
				attempt: 2,
				maxAttempts: 5,
				delayMs: 9000,
				errorMessage: "stream stalled",
				startedAt: Date.now(),
			},
		});
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("Retrying (2/5) in 9s…");
		expect(document.body.textContent).toContain("stream stalled");
	});

	it("renders the in-flight retry once the delay elapses", async () => {
		useSessionStore.setState({
			retryInfo: {
				attempt: 2,
				maxAttempts: 5,
				delayMs: 9000,
				errorMessage: "stream stalled",
				startedAt: Date.now() - 10_000,
			},
		});
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("Retrying (2/5)…");
		expect(document.body.textContent).not.toContain("in 9s");
	});

	it("renders the compaction loader with TUI reason/action text", async () => {
		useSessionStore.setState({ compactionInfo: { reason: "overflow", action: "handoff" } });
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("Context overflow detected, Auto-handoff…");
	});
});

describe("hydrateSession streaming reconcile (F-HYDRATE)", () => {
	it("retains completed subtask history when switching back to the same session", async () => {
		installMockOmp();
		await hydrateSession();
		useSubagentsStore.getState().applyFrame({
			type: "subagent_lifecycle",
			payload: { id: "finished", index: 1, agent: "scout", agentSource: "bundled", status: "completed" },
		});
		await hydrateSession();
		expect(useSubagentsStore.getState().subagents.get("finished")?.status).toBe("completed");
	});

	it("discards an older hydration when a newer session finishes first", async () => {
		const { omp } = installMockOmp();
		const oldState = Promise.withResolvers<RpcResponse>();
		const oldTranscript = Promise.withResolvers<RpcResponse>();
		const oldGoal = Promise.withResolvers<RpcResponse>();
		const oldMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "old transcript" }],
			timestamp: 1,
		};
		const newMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "new transcript" }],
			timestamp: 2,
		};
		omp.rpc.getState.mockReturnValueOnce(oldState.promise).mockResolvedValue(
			success({
				sessionId: "new-session",
				sessionName: "New",
				sessionFile: "/new.jsonl",
				cwd: "/new",
				isStreaming: false,
				isCompacting: false,
				contextUsage: null,
				messageCount: 1,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		omp.rpc.getTranscriptPage
			.mockReturnValueOnce(oldTranscript.promise)
			.mockResolvedValue(success({ messages: [newMessage] }));
		omp.rpc.getGoal.mockReturnValueOnce(oldGoal.promise).mockResolvedValue(success({ enabled: false }));

		const olderHydration = hydrateSession();
		await hydrateSession();
		oldState.resolve(
			success({
				sessionId: "old-session",
				sessionName: "Old",
				sessionFile: "/old.jsonl",
				cwd: "/old",
				isStreaming: false,
				isCompacting: false,
				contextUsage: null,
				messageCount: 1,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		oldTranscript.resolve(success({ messages: [oldMessage] }));
		oldGoal.resolve(success({ enabled: true, objective: "old goal", status: "active" }));
		await olderHydration;

		expect(useSessionStore.getState().sessionId).toBe("new-session");
		expect(useSessionStore.getState().goal).toBeNull();
		expect(useMessagesStore.getState().messages).toEqual([newMessage]);
	});

	it("paints the core transcript before slower subagent and secondary hydration settles", async () => {
		const { omp } = installMockOmp();
		const subagents = Promise.withResolvers<RpcResponse>();
		const goal = Promise.withResolvers<RpcResponse>();
		const hydrated: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "new session transcript" }],
			timestamp: 2,
		};
		omp.rpc.getTranscriptPage.mockResolvedValue(success({ messages: [hydrated] }));
		omp.rpc.getSubagents.mockReturnValue(subagents.promise);
		omp.rpc.getGoal.mockReturnValue(goal.promise);
		const transcriptPainted = Promise.withResolvers<void>();
		const unsubscribe = useMessagesStore.subscribe(state => {
			if (state.messages.length === 1 && state.messages[0] === hydrated) transcriptPainted.resolve();
		});

		let settled = false;
		const hydration = hydrateSession().then(() => {
			settled = true;
		});
		await transcriptPainted.promise;
		unsubscribe();
		expect(useMessagesStore.getState().messages).toEqual([hydrated]);

		expect(settled).toBe(false);
		subagents.resolve(success({ subagents: [] }));
		goal.resolve(success({ enabled: false }));
		await hydration;
	});

	it("hydrates a tab transcript through paginated RPC pages", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-page");
		const hydrated: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large-session reply" }],
			timestamp: 2,
		};
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type === "get_transcript_page") return success({ messages: [hydrated], totalMessages: 1 });
			if (command.type === "get_transcript") throw new Error("unbounded transcript RPC");
			return original(tabId, command);
		});

		await hydrateTabSession("t-page");

		expect(sessionRuntimeStore<MessagesStore>("t-page", "messages")?.getState().messages).toEqual([hydrated]);
		expect(commandForTab.mock.calls.some(call => call[1]?.type === "get_transcript_page")).toBe(true);
	});

	it("retains loaded older history and its cursor when a tail-only rehydrate reconciles live ids", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-retained");
		const older: AgentMessage = { role: "user", content: "older", timestamp: 1, entryId: "older" };
		const tail: AgentMessage = { role: "user", content: "tail", timestamp: 2, entryId: "tail" };
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation(async (tabId, command) =>
			command.type === "get_transcript_page"
				? success({ messages: [tail], totalMessages: 2, prevCursor: "tail-cursor" })
				: original(tabId, command),
		);
		await hydrateTabSession("t-retained");
		const messages = sessionRuntimeStore<MessagesStore>("t-retained", "messages")!;
		messages.getState().prependPage({ messages: [older], totalMessages: 2 });
		await hydrateTabSession("t-retained");
		expect(messages.getState().messages.map(message => message.entryId)).toEqual(["older", "tail"]);
		expect(messages.getState().prevCursor).toBeUndefined();
	});

	it("refreshes a stale live-commit cursor without losing already loaded messages", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-stale");
		const older: AgentMessage = { role: "user", content: "older", timestamp: 1, entryId: "older" };
		const tail: AgentMessage = { role: "user", content: "tail", timestamp: 2, entryId: "tail" };
		const live: AgentMessage = { role: "assistant", content: "live", timestamp: 3, entryId: "live" };
		const messages = sessionRuntimeStore<MessagesStore>("t-stale", "messages")!;
		messages.setState({ messages: [tail], prevCursor: "stale" });
		messages.getState().applyEvents([{ type: "agent_end", messages: [live] }]);
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type !== "get_transcript_page") return original(tabId, command);
			if (command.cursor === "stale")
				return { type: "response", command: command.type, success: false, error: "stale", code: "stale_cursor" };
			if (command.fromEnd) return success({ messages: [tail, live], totalMessages: 3, prevCursor: "fresh" });
			return success({ messages: [older], totalMessages: 3 });
		});
		expect(await loadOlderTranscript("t-stale")).toBe(true);
		expect(messages.getState().messages.map(message => message.entryId)).toEqual(["older", "tail", "live"]);
		expect(messages.getState().prevCursor).toBeUndefined();
		expect(messages.getState().pageError).toBeNull();
	});

	it("keeps the older rows that share a refreshed page with the old leading entry", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-shift");
		const row = (id: string, timestamp: number): AgentMessage => ({
			role: "user",
			content: id,
			timestamp,
			entryId: id,
		});
		const messages = sessionRuntimeStore<MessagesStore>("t-shift", "messages")!;
		messages.setState({ messages: [row("c", 3), row("d", 4)], prevCursor: "stale" });
		messages.getState().applyEvents([{ type: "agent_end", messages: [row("e", 5)] }]);
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type !== "get_transcript_page") return original(tabId, command);
			if (command.cursor === "stale")
				return { type: "response", command: command.type, success: false, error: "stale", code: "stale_cursor" };
			// The live commit shifted the boundaries: "c" now sits mid-page, after "b".
			if (command.fromEnd)
				return success({ messages: [row("d", 4), row("e", 5)], totalMessages: 5, prevCursor: "p1" });
			if (command.cursor === "p1")
				return success({ messages: [row("b", 2), row("c", 3)], totalMessages: 5, prevCursor: "p0" });
			return success({ messages: [row("a", 1)], totalMessages: 5 });
		});
		expect(await loadOlderTranscript("t-shift")).toBe(true);
		expect(messages.getState().messages.map(message => message.entryId)).toEqual(["b", "c", "d", "e"]);
		expect(messages.getState().prevCursor).toBe("p0");
		expect(await loadOlderTranscript("t-shift")).toBe(true);
		expect(messages.getState().messages.map(message => message.entryId)).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("a failed older page says so and keeps its cursor, so Retry loads it", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-fail");
		const row = (id: string, timestamp: number): AgentMessage => ({
			role: "user",
			content: id,
			timestamp,
			entryId: id,
		});
		const messages = sessionRuntimeStore<MessagesStore>("t-fail", "messages")!;
		messages.setState({ messages: [row("b", 2)], prevCursor: "p0" });
		const original = commandForTab.getMockImplementation()!;
		let fail = true;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type !== "get_transcript_page") return original(tabId, command);
			if (fail) return { type: "response", command: command.type, success: false, error: "disk read failed" };
			return success({ messages: [row("a", 1)], totalMessages: 2 });
		});
		expect(await loadOlderTranscript("t-fail")).toBe(false);
		expect(messages.getState()).toMatchObject({
			pageError: "disk read failed",
			isLoadingPage: false,
			prevCursor: "p0",
		});
		fail = false;
		expect(await loadOlderTranscript("t-fail")).toBe(true);
		expect(messages.getState().pageError).toBeNull();
		expect(messages.getState().messages.map(message => message.entryId)).toEqual(["a", "b"]);
	});

	it("re-reads only the tail if a live commit changes the initial paging snapshot", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-tail-race");
		const message: AgentMessage = { role: "assistant", content: "settled tail", timestamp: 1, entryId: "settled" };
		const original = commandForTab.getMockImplementation()!;
		let pages = 0;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type !== "get_transcript_page") return original(tabId, command);
			expect(command.fromEnd).toBe(true);
			if (pages++ === 0)
				return { type: "response", command: command.type, success: false, error: "stale", code: "stale_cursor" };
			return success({ messages: [message], totalMessages: 1 });
		});
		await hydrateTabSession("t-tail-race");
		expect(pages).toBe(2);
		expect(sessionRuntimeStore<MessagesStore>("t-tail-race", "messages")?.getState().messages).toEqual([message]);
	});

	it("a failed first transcript read says so instead of an empty session, and hydrating again clears it", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-first-fail");
		const original = commandForTab.getMockImplementation()!;
		let fail = true;
		const message: AgentMessage = { role: "assistant", content: "on the host", timestamp: 1, entryId: "h1" };
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type !== "get_transcript_page") return original(tabId, command);
			if (fail) throw new Error("tab.command timed out after 13000 ms");
			return success({ messages: [message], totalMessages: 1 });
		});
		const messages = sessionRuntimeStore<MessagesStore>("t-first-fail", "messages")!;
		await hydrateTabSession("t-first-fail");
		expect(messages.getState()).toMatchObject({ messages: [], pageError: "tab.command timed out after 13000 ms" });
		fail = false;
		await hydrateTabSession("t-first-fail");
		expect(messages.getState()).toMatchObject({ messages: [message], pageError: null });
	});

	it("shares one in-flight tab hydration per session and refetches after a session change or reload", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		seedReadyTab("t-once");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t-once" ? { ...tab, sessionId: "s1" } : tab)),
		}));
		const hydrated: AgentMessage = { role: "assistant", content: [{ type: "text", text: "once" }], timestamp: 3 };
		const pages: Array<PromiseWithResolvers<RpcResponse>> = [];
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type !== "get_transcript_page") return original(tabId, command);
			const page = Promise.withResolvers<RpcResponse>();
			pages.push(page);
			return page.promise;
		});
		const settle = async (expected: number) => {
			await flush();
			expect(pages).toHaveLength(expected);
			for (const page of pages) page.resolve(success({ messages: [hydrated], totalMessages: 1 }));
		};

		// TAB_STATUS ready, the full status channel, and the boot fallback land together.
		const joined = [attachTabSession("t-once"), attachTabSession("t-once"), attachTabSession("t-once")];
		expect(new Set(joined).size).toBe(1);
		await settle(1);
		await Promise.all(joined);
		expect(sessionRuntimeStore<MessagesStore>("t-once", "messages")?.getState().messages).toEqual([hydrated]);

		// Settled hydrations are not cached: the next attach fetches again.
		const later = attachTabSession("t-once");
		// An explicit reload never joins a fetch that started before it...
		const reload = hydrateTabSession("t-once");
		// ...but a following attach joins the reload.
		expect(attachTabSession("t-once")).toBe(reload);
		// A new session id on the same runtime starts its own fetch.
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t-once" ? { ...tab, sessionId: "s2" } : tab)),
		}));
		const switched = attachTabSession("t-once");
		expect(switched).not.toBe(reload);
		await settle(4);
		await Promise.all([later, reload, switched]);
	});

	it("clears the stale streaming bubble when the hydrated tab has settled", async () => {
		const { omp } = installMockOmp();
		const optimistic: AgentMessage = {
			role: "user",
			content: "locally visible before RPC accepts it",
			timestamp: 1,
			optimistic: true,
		};
		const staleLive: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "stale live reply" }],
			timestamp: 1,
		};
		const finalized: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "settled reply" }],
			timestamp: 2,
		};
		// Zombie state: the tab's run settled in the background, so its
		// message_end/agent_end never forwarded — the restored bundle still
		// carries the mid-run slice while the transcript holds the final text.
		useMessagesStore.setState({
			messages: [],
			liveMessages: [optimistic, staleLive],
			streamingMessage: assistantMessage,
			streamingText: "partial reply",
			streamingThinking: "partial thinking",
		});
		omp.rpc.getTranscriptPage.mockResolvedValue(success({ messages: [finalized] }));

		await hydrateSession();

		const messages = useMessagesStore.getState();
		expect(messages.streamingMessage).toBeNull();
		expect(messages.streamingText).toBe("");
		expect(messages.streamingThinking).toBe("");
		expect(messages.liveMessages).toEqual([optimistic]);
		// The finalized content arrives via the transcript merge, not the bubble.
		expect(messages.messages).toEqual([finalized]);
		// Hydrate re-asserts the per-tab subagent subscription (switch-in path).
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledWith("progress");
	});

	it("does not clear live deliveries that arrived after an idle hydration began", async () => {
		const { omp } = installMockOmp();
		const transcript = Promise.withResolvers<RpcResponse>();
		omp.rpc.getTranscriptPage.mockReturnValue(transcript.promise);
		const hydration = hydrateSession();
		const delivered: AgentMessage = { role: "user", content: "new run", timestamp: 3 };
		useMessagesStore.getState().applyEvents([{ type: "message_end", message: delivered }]);

		transcript.resolve(success({ messages: [] }));
		await hydration;

		expect(useMessagesStore.getState().liveMessages).toEqual([delivered]);
	});

	it("keeps the live stream while the hydrated tab is still streaming", async () => {
		const { omp } = installMockOmp();
		omp.rpc.getState.mockImplementation(async () =>
			success({
				sessionId: "s1",
				sessionName: null,
				sessionFile: null,
				cwd: "/tmp",
				isStreaming: true,
				isCompacting: false,
				contextUsage: null,
				messageCount: 3,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		useMessagesStore.setState({
			streamingMessage: assistantMessage,
			streamingText: "partial reply",
			streamingThinking: "partial thinking",
		});

		await hydrateSession();

		// Mid-run attach: live deltas resume onto the restored buffers, so the
		// streaming slice must survive hydration untouched.
		const messages = useMessagesStore.getState();
		expect(messages.streamingMessage).toBe(assistantMessage);
		expect(messages.streamingText).toBe("partial reply");
		expect(messages.streamingThinking).toBe("partial thinking");
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledWith("progress");
	});
});

describe("useRpcEvents tab-scoped routing guards", () => {
	function seedTwoTabs(): void {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t-live", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t-dead", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t-live",
		});
		ensureTabRuntime("t-live");
		ensureTabRuntime("t-dead");
		setFocusedSessionRuntime("t-live");
	}

	it("refreshes automatic compaction without letting its delayed snapshot erase resumed work", async () => {
		const { emitTabBatch, commandForTab } = installTabRoutedMockOmp();
		seedTwoTabs();
		await mount(<RpcEventsProbe />);
		const transcript = Promise.withResolvers<RpcResponse>();
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation((tabId, command) =>
			command.type === "get_transcript_page" ? transcript.promise : original(tabId, command),
		);
		const shell: AgentMessage = { role: "assistant", content: [], timestamp: 100 };
		await act(async () => {
			emitTabBatch(
				[
					{ type: "auto_compaction_start", reason: "threshold", action: "compact" },
					{ type: "auto_compaction_end", action: "compact", result: {}, aborted: false, willRetry: false },
					{ type: "agent_start" },
					{ type: "message_start", message: shell },
					{
						type: "message_update",
						message: shell,
						assistantMessageEvent: {
							type: "text_delta",
							contentIndex: 0,
							delta: "Resumed reply",
							partial: shell,
						},
					},
					{
						type: "tool_execution_start",
						toolCallId: "resumed-tool",
						toolName: "read",
						args: { path: "src/current.ts" },
					},
				],
				"t-live",
			);
		});
		const compacted: AgentMessage = {
			role: "compactionSummary",
			summary: "Compacted history",
			content: "",
			entryId: "compacted",
			timestamp: 50,
		};
		transcript.resolve(success({ messages: [compacted] }));
		await flush();
		expect(useMessagesStore.getState().messages).toEqual([compacted]);
		expect(useMessagesStore.getState().streamingText).toBe("Resumed reply");
		expect(useSessionStore.getState()).toMatchObject({ isStreaming: true, isCompacting: false });
		expect(useToolsStore.getState().liveTools.get("resumed-tool")?.status).toBe("running");
	});

	it("drops in-flight event batches for a closed tab instead of polluting the focused pane", async () => {
		const { emitTabBatch, notify } = installTabRoutedMockOmp();
		seedTwoTabs();
		await mount(<RpcEventsProbe />);
		await act(async () => {
			await useTabsStore.getState().closeTab("t-dead");
		});

		await act(async () => {
			emitTabBatch(
				[
					{ type: "agent_start" } as AgentSessionEvent,
					{ type: "agent_end", messages: [], isTerminal: true } as AgentSessionEvent,
				],
				"t-dead",
			);
		});

		// No ghost runtime resurrection for the closed tab…
		expect(sessionRuntime("t-dead")).toBeNull();
		// …no completion notification for a tab the user closed…
		expect(notify).not.toHaveBeenCalled();
		// …and the live pane's stores are untouched by the dead tab's frames.
		expect(sessionRuntimeStore<MessagesStore>("t-live", "messages")?.getState().messages).toHaveLength(0);
		expect(sessionRuntimeStore<SessionStore>("t-live", "session")?.getState().isStreaming).toBe(false);
	});

	it("ignores a closed tab's late 'starting' status instead of resetting the focused pane", async () => {
		const { emitTabStatus } = installTabRoutedMockOmp();
		seedTwoTabs();
		await mount(<RpcEventsProbe />);
		await flush();
		// Append AFTER boot hydration — hydrate's transcript reconcile replaces
		// the message list, so seeding earlier would not survive mount.
		const kept = {
			role: "user",
			content: [{ type: "text", text: "keep me" }],
			timestamp: 1,
		} as AgentMessage;
		sessionRuntimeStore<MessagesStore>("t-live", "messages")?.getState().appendMessage(kept);
		await act(async () => {
			await useTabsStore.getState().closeTab("t-dead");
		});

		await act(async () => {
			emitTabStatus({ status: "starting", cwd: "/beta" } as IpcSidecarStatusPayload, "t-dead");
		});

		// Without the tombstone gate this frame falls through to the focused
		// runtime and resets its stores wholesale.
		expect(sessionRuntimeStore<MessagesStore>("t-live", "messages")?.getState().messages).toContain(kept);
	});

	it("keeps a paired host's tab on screen through a re-attach and merges what it missed; a new omp starts it over", async () => {
		const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
		seedTwoTabs();
		await mount(<RpcEventsProbe />);
		await flush();
		const kept = { role: "user", content: [{ type: "text", text: "keep me" }], timestamp: 1 } as AgentMessage;
		const missed = {
			role: "assistant",
			content: [{ type: "text", text: "finished while away" }],
			timestamp: 2,
			stopReason: "stop",
		} as AgentMessage;
		const messages = () => sessionRuntimeStore<MessagesStore>("t-live", "messages")?.getState().messages ?? [];
		sessionRuntimeStore<MessagesStore>("t-live", "messages")?.getState().appendMessage(kept);
		const base = commandForTab.getMockImplementation();
		commandForTab.mockImplementation(async (tabId, command) =>
			command.type === "get_transcript_page"
				? success({ messages: [kept, missed], totalMessages: 2 })
				: (base?.(tabId, command) ?? success({})),
		);

		await act(async () => {
			emitTabStatus({ status: "starting", cwd: "/alpha", reconnecting: true }, "t-live");
		});
		expect(messages()).toContain(kept);

		await act(async () => {
			emitTabStatus({ status: "ready", cwd: "/alpha" }, "t-live");
		});
		await flush();
		expect(messages().map(message => message.timestamp)).toEqual([1, 2]);

		await act(async () => {
			emitTabStatus({ status: "starting", cwd: "/alpha" }, "t-live");
		});
		expect(messages()).toEqual([]);
	});

	it("lands a ready status of a tab with no runtime yet in that tab, never in the focused pane", async () => {
		// A page that just loaded hears a tab's `ready` before that tab's runtime exists, while main still counts that
		// tab as the window's active one (the renderer's focus already moved on). The focused pane must keep its own
		// session; the new tab gets its own state.
		const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
		seedTwoTabs();
		commandForTab.mockImplementation(async (tabId, command) =>
			success(
				command.type === "get_state"
					? {
							sessionId: `session-of-${tabId}`,
							sessionName: null,
							sessionFile: null,
							cwd: `/cwd/${tabId}`,
							isStreaming: false,
							isCompacting: false,
							contextUsage: null,
							messageCount: 0,
							queuedMessageCount: 0,
							planModeEnabled: false,
							todoPhases: [],
						}
					: command.type === "get_transcript_page"
						? { messages: [], totalMessages: 0 }
						: {},
			),
		);
		// `rpc.command` is main's active tab: the tab that just came up.
		Object.assign(window.omp.rpc, { command: (command: RpcCommand) => commandForTab("t-new", command) });
		await mount(<RpcEventsProbe />);
		await flush();
		const live = sessionRuntimeStore<SessionStore>("t-live", "session")!;
		live.setState({ sessionId: "session-of-t-live", cwd: "/cwd/t-live" });

		await act(async () => {
			emitTabStatus({ status: "ready", cwd: "/cwd/t-new" } as IpcSidecarStatusPayload, "t-new");
		});
		await flush();

		expect(live.getState()).toMatchObject({ sessionId: "session-of-t-live", cwd: "/cwd/t-live" });
		expect(sessionRuntimeStore<SessionStore>("t-new", "session")?.getState()).toMatchObject({
			sessionId: "session-of-t-new",
			status: "ready",
		});
	});

	it("lands a ready status heard before any runtime exists in its own tab, even when another pane takes focus meanwhile", async () => {
		const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
		const stateOf = (tabId: string) => ({
			sessionId: `session-of-${tabId}`,
			sessionName: null,
			sessionFile: null,
			cwd: `/cwd/${tabId}`,
			isStreaming: false,
			isCompacting: false,
			contextUsage: null,
			messageCount: 0,
			queuedMessageCount: 0,
			planModeEnabled: false,
			todoPhases: [],
		});
		// The first get_state for t-first waits until the test answers it.
		const held = Promise.withResolvers<void>();
		let holding = true;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type === "get_state") {
				if (tabId === "t-first" && holding) {
					holding = false;
					await held.promise;
				}
				return success(stateOf(tabId));
			}
			return success(command.type === "get_transcript_page" ? { messages: [], totalMessages: 0 } : {});
		});
		// `rpc.command` is main's active tab, still t-first.
		Object.assign(window.omp.rpc, { command: (command: RpcCommand) => commandForTab("t-first", command) });
		await mount(<RpcEventsProbe />);
		await flush();

		await act(async () => {
			emitTabStatus({ status: "ready", cwd: "/cwd/t-first" } as IpcSidecarStatusPayload, "t-first");
		});
		// Another pane gets its runtime and the focus while that get_state is in flight.
		ensureTabRuntime("t-other");
		setFocusedSessionRuntime("t-other");
		const other = sessionRuntimeStore<SessionStore>("t-other", "session")!;
		other.setState({ sessionId: "session-of-t-other", cwd: "/cwd/t-other" });
		held.resolve();
		await flush();
		await flush();

		expect(other.getState()).toMatchObject({ sessionId: "session-of-t-other", cwd: "/cwd/t-other" });
		expect(sessionRuntimeStore<SessionStore>("t-first", "session")?.getState()).toMatchObject({
			sessionId: "session-of-t-first",
			status: "ready",
		});
	});

	it("drops a failed boot health check whose tab's runtime was replaced before it failed", async () => {
		const { emitTabStatus, commandForTab } = installTabRoutedMockOmp();
		seedTwoTabs();
		await mount(<RpcEventsProbe />);
		await flush();
		const failed = Promise.withResolvers<RpcResponse>();
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation((tabId, command) =>
			tabId === "t-live" && command.type === "get_state" ? failed.promise : original(tabId, command),
		);
		await act(async () => {
			emitTabStatus({ status: "ready", cwd: "/alpha" } as IpcSidecarStatusPayload, "t-live");
		});
		// The tab's session changes while the check waits: a new runtime speaks for it now.
		replaceTabRuntime("t-live");
		setFocusedSessionRuntime("t-live");
		failed.reject(new Error("link dropped"));
		await flush();
		expect(sessionRuntimeStore<SessionStore>("t-live", "session")?.getState().sidecarError).toBeNull();
	});
});

describe("useRpcEvents background tabs", () => {
	function seedTabs(): void {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t-front", cwd: "/alpha", status: "ready", unreadDone: false, title: "Front task" },
				{ kind: "agent", id: "t-back", cwd: "/beta", status: "running", unreadDone: false, title: "Back task" },
			],
			activeTabId: "t-front",
		});
		ensureTabRuntime("t-front");
		ensureTabRuntime("t-back");
		setFocusedSessionRuntime("t-front");
		sessionRuntimeStore<SessionStore>("t-front", "session")?.setState({ sessionName: "Front task" });
	}

	/** Desktop notifications only fire while the window is unfocused. */
	function blurWindow(): () => void {
		const doc = document as unknown as { hasFocus?: () => boolean };
		const previous = doc.hasFocus;
		doc.hasFocus = () => false;
		return () => {
			doc.hasFocus = previous;
		};
	}

	it("titles a run-end notification after the tab that finished, not the focused one", async () => {
		const { emitTabBatch, notify } = installTabRoutedMockOmp();
		seedTabs();
		const restoreFocus = blurWindow();
		try {
			await mount(<RpcEventsProbe />);
			const finish = () =>
				act(async () => {
					emitTabBatch(
						[
							{
								type: "agent_end",
								isTerminal: true,
								messages: [{ role: "assistant", content: [], stopReason: "stop" }],
							},
						],
						"t-back",
					);
				});
			await finish();
			await flush();
			expect(notify).toHaveBeenCalledWith(
				"Back task",
				translate("events.notificationComplete"),
				"t-back",
				"completion",
			);

			// No title of its own: the app name, never the focused tab's session.
			notify.mockClear();
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => (tab.id === "t-back" ? { ...tab, title: undefined } : tab)),
			}));
			await finish();
			await flush();
			expect(notify).toHaveBeenCalledWith(
				"OMPdesk",
				translate("events.notificationComplete"),
				"t-back",
				"completion",
			);

			// A reply with prose: the banner reads its opening, Markdown removed.
			notify.mockClear();
			await act(async () => {
				emitTabBatch(
					[
						{
							type: "agent_end",
							isTerminal: true,
							messages: [
								{
									role: "assistant",
									content: [{ type: "text", text: "## Done\n\n**Fixed** the `parser`." }],
									stopReason: "stop",
								},
							],
						},
					],
					"t-back",
				);
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("OMPdesk", "Done. Fixed the parser.", "t-back", "completion");
		} finally {
			restoreFocus();
		}
	});

	it("names the tab and localizes the body of an ask notification", async () => {
		installTabRoutedMockOmp();
		let onExtensionUi: (request: ExtensionUIRequest, tabId: string) => void = () => {};
		(window.omp.events as unknown as Record<string, unknown>).onExtensionUi = vi.fn(
			(callback: typeof onExtensionUi) => {
				onExtensionUi = callback;
				return () => {};
			},
		);
		const { notify } = window.omp.system as unknown as { notify: Mock<(title: string, body: string) => void> };
		seedTabs();
		const restoreFocus = blurWindow();
		try {
			await mount(<RpcEventsProbe />);
			await act(async () => {
				onExtensionUi({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [] }, "t-back");
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("Back task", translate("events.notificationAsk"), "t-back", "ask");
		} finally {
			restoreFocus();
		}
	});

	it("does not notify again for an ask a paired host's re-attach sends again, but does for one raised while away", async () => {
		installTabRoutedMockOmp();
		let onExtensionUi: (request: ExtensionUIRequest, tabId: string, signIn?: IpcSignIn, resent?: boolean) => void =
			() => {};
		(window.omp.events as unknown as Record<string, unknown>).onExtensionUi = vi.fn(
			(callback: typeof onExtensionUi) => {
				onExtensionUi = callback;
				return () => {};
			},
		);
		const { notify } = window.omp.system as unknown as { notify: Mock<(title: string, body: string) => void> };
		seedTabs();
		const restoreFocus = blurWindow();
		try {
			await mount(<RpcEventsProbe />);
			await act(async () => {
				onExtensionUi(
					{ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [] },
					"t-back",
					undefined,
					true,
				);
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();

			await act(async () => {
				onExtensionUi({ type: "extension_ui_request", id: "ask-2", method: "ask", questions: [] }, "t-back");
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("Back task", translate("events.notificationAsk"), "t-back", "ask");
		} finally {
			restoreFocus();
		}
	});

	it("does not notify for a provider sign-in's own requests, but still for a question", async () => {
		installTabRoutedMockOmp();
		let onExtensionUi: (request: ExtensionUIRequest, tabId: string) => void = () => {};
		(window.omp.events as unknown as Record<string, unknown>).onExtensionUi = vi.fn(
			(callback: typeof onExtensionUi) => {
				onExtensionUi = callback;
				return () => {};
			},
		);
		const { notify } = window.omp.system as unknown as { notify: Mock<(title: string, body: string) => void> };
		seedTabs();
		ensureTabRuntime("t-back");
		const extensionUi = sessionRuntimeStore<ExtensionUiStore>("t-back", "extensionUi")!;
		const restoreFocus = blurWindow();
		try {
			await mount(<RpcEventsProbe />);
			extensionUi.getState().beginInlineLogin();
			await act(async () => {
				// This listener runs before the store has recorded the request.
				onExtensionUi(
					{ type: "extension_ui_request", id: "url", method: "open_url", url: "https://claude.ai/login" },
					"t-back",
				);
				onExtensionUi(
					{ type: "extension_ui_request", id: "paste", method: "input", title: "Paste the code" },
					"t-back",
				);
			});
			await flush();
			expect(notify).not.toHaveBeenCalled();

			await act(async () => {
				onExtensionUi({ type: "extension_ui_request", id: "q", method: "ask", questions: [] }, "t-back");
			});
			await flush();
			expect(notify).toHaveBeenCalledWith("Back task", translate("events.notificationAsk"), "t-back", "ask");
		} finally {
			extensionUi.setState({ inlineLogins: 0, loginRequestIds: {} });
			restoreFocus();
		}
	});

	it("settles tool cards whose end events were missed even while live events flow during the fetch", async () => {
		const { emitTabBatch, commandForTab } = installTabRoutedMockOmp();
		seedTabs();
		await mount(<RpcEventsProbe />);
		const tools = sessionRuntimeStore<ToolsStore>("t-back", "tools")!;
		// Seen running before the tab went to the background; its end never arrived.
		tools.getState().applyEvents([{ type: "tool_execution_start", toolCallId: "stale", toolName: "read", args: {} }]);

		const transcript = Promise.withResolvers<RpcResponse>();
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation((tabId, command) =>
			command.type === "get_transcript_page" ? transcript.promise : original(tabId, command),
		);
		const hydrated = hydrateTabSession("t-back");
		// The run is live, so events keep landing while the transcript is fetched.
		await act(async () => {
			emitTabBatch([{ type: "tool_execution_start", toolCallId: "fresh", toolName: "read", args: {} }], "t-back");
		});
		const staleCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "stale", name: "read", arguments: {} }],
			timestamp: 1,
		};
		const staleResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "stale",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		};
		transcript.resolve(success({ messages: [staleCall, staleResult] }));
		await act(async () => {
			await hydrated;
		});

		expect(tools.getState().finishedTools.get("stale")?.status).toBe("done");
		expect(tools.getState().liveTools.get("fresh")?.status).toBe("running");
	});

	it("drops a stale retry row when the hydrated session is idle", async () => {
		installTabRoutedMockOmp();
		seedTabs();
		await mount(<RpcEventsProbe />);
		const session = sessionRuntimeStore<SessionStore>("t-back", "session")!;
		session.setState({
			retryInfo: { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "529", startedAt: 1 },
			compactionInfo: { reason: "threshold", action: "compacting" },
		});
		await act(async () => {
			await hydrateTabSession("t-back");
		});
		expect(session.getState()).toMatchObject({ retryInfo: null, compactionInfo: null });
	});

	it("re-shows a plan proposal made while the tab was in the background", async () => {
		const { commandForTab } = installTabRoutedMockOmp();
		const proposal = {
			planFilePath: "local://PLAN.md",
			title: "Refactor",
			suggestedFileName: "REFACTOR.md",
			planContent: "# Plan",
			options: ["execute", "refine"],
		};
		const original = commandForTab.getMockImplementation()!;
		commandForTab.mockImplementation(async (tabId, command) => {
			if (command.type === "get_state") return settledState({ planModeEnabled: true });
			if (command.type === "get_plan_mode") return success({ enabled: true, proposal });
			return original(tabId, command);
		});
		seedTabs();
		await mount(<RpcEventsProbe />);
		await act(async () => {
			await hydrateTabSession("t-back");
		});
		expect(sessionRuntimeStore<PlanApprovalStore>("t-back", "planApproval")?.getState().pending).toEqual(proposal);
	});
});
