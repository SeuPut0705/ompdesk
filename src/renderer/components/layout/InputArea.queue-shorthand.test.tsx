/**
 * InputArea interaction contracts: queue shorthand routing, prompt history,
 * the in-place expanded composer (⌃G), and the toolbar's Run settings / mode
 * popovers dispatching their choices.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentMessage, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { pasteMarkerText, storePaste } from "../../lib/paste-blobs";
import { useComposerStore } from "../../stores/composer";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import {
	SessionRuntimeProvider,
	sessionRuntime,
	setFocusedSessionRuntime,
	withSessionRuntime,
} from "../../stores/session-runtime-context";
import { useSettingsStore } from "../../stores/settings";
import { createTabRuntime, replaceTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { InputArea } from "./InputArea";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
	getAttribute(name: string): string | null;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let followUp: Mock;
let steer: Mock;
let prompt: Mock;
let setThinkingLevel: Mock;
let setSetting: Mock;
let setPlanMode: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

/** Set a controlled input's value and drive its React onChange contract. */
async function typeInto(element: TestElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else (element as unknown as { value: string }).value = value;
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	if (!props?.onChange) throw new Error("textarea onChange not found");
	await act(async () => props.onChange?.({ target: element, currentTarget: element }));
}

/** Drive the textarea's React onKeyDown with an Enter press. */
async function pressEnter(element: TestElement): Promise<void> {
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey
		? (record[propsKey] as { onKeyDown?: (event: Record<string, unknown>) => void } | undefined)
		: undefined;
	if (!props?.onKeyDown) throw new Error("textarea onKeyDown not found");
	await act(async () =>
		props.onKeyDown?.({
			key: "Enter",
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			nativeEvent: { isComposing: false },
			keyCode: 13,
			preventDefault: () => {},
		}),
	);
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

function buttonWithText(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.trim().startsWith(text));
}

function setWindowWidth(width: number): void {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function findTextarea(): TestElement {
	const textarea = document.querySelector("textarea") as unknown as TestElement | null;
	if (!textarea) throw new Error("composer textarea not found");
	return textarea;
}

async function mount(withRuntime = false): Promise<void> {
	followUp = vi.fn(async () => ok());
	steer = vi.fn(async () => ok());
	prompt = vi.fn(async () => ok());
	setThinkingLevel = vi.fn(async (level: string) => ok({ thinkingLevel: level, thinkingConfigured: level }));
	setSetting = vi.fn(async (_path: string, value: unknown) => ok({ value, provenance: { layers: ["global"] } }));
	setPlanMode = vi.fn(async (enabled: boolean) => ok({ enabled }));
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		events: { onCommandsUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			followUp,
			steer,
			prompt,
			abort: vi.fn(async () => ok()),
			setThinkingLevel,
			setSetting,
			setPlanMode,
		},
	};
	useModelStore.setState({
		thinkingLevel: "high",
		thinkingConfigured: "high",
		availableThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
	});
	useSessionStore.setState({
		status: "ready",
		isStreaming: true,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionName: null,
	});
	useTabsStore.setState({
		tabs: [
			{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false },
			{ kind: "agent", id: "t1", cwd: "/other", status: "ready", unreadDone: false },
		],
		activeTabId: "t0",
		bundles: new Map(),
	});
	const runtime = withRuntime ? createTabRuntime("t0") : null;
	if (runtime) {
		setFocusedSessionRuntime("t0");
		withSessionRuntime("t0", () =>
			useSessionStore.setState({ status: "ready", sessionId: "before-restart", cwd: "/tmp" }),
		);
		window.omp.rpc.commandForTab = vi.fn(async (_tabId, command) => {
			if (command.type === "prompt") return prompt(command.message, command.images);
			if (command.type === "get_queue") return ok({ steering: [], followUp: [] });
			if (command.type === "get_state")
				return ok({
					sessionId: useSessionStore.getState().sessionId,
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
			return ok({});
		});
	}
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				{runtime ? (
					<SessionRuntimeProvider runtime={runtime}>
						<InputArea />
					</SessionRuntimeProvider>
				) : (
					<InputArea />
				)}
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useSettingsStore.getState().reset();
	useTabsStore.getState().reset();
	setWindowWidth(1200);
	vi.restoreAllMocks();
});

describe("InputArea queue shorthand submit", () => {
	it("restores an unacknowledged send after process recovery and blocks duplicate submission", async () => {
		await mount(true);
		const pending = Promise.withResolvers<RpcResponse>();
		prompt.mockReturnValueOnce(pending.promise);
		await typeInto(findTextarea(), "preserve in-flight input");
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
		await typeInto(findTextarea(), "next draft");
		const recovering = withSessionRuntime("t0", () => useComposerStore.getState());
		expect(recovering.sending).toBe(true);
		// The restart retains the task while the unsaved Core session receives a new id.
		await act(async () => {
			sessionRuntime("t0")!.recovering = true;
			useSessionStore.getState().reset();
			const replacement = replaceTabRuntime("t0");
			setFocusedSessionRuntime("t0");
			useSessionStore.setState({ status: "ready", sessionId: "recovered-session", cwd: "/tmp" });
			replacement.recovering = false;
			root.render(
				<I18nProvider>
					<SessionRuntimeProvider runtime={replacement}>
						<InputArea />
					</SessionRuntimeProvider>
				</I18nProvider>,
			);
		});
		pending.resolve({
			type: "response",
			command: "prompt",
			success: false,
			code: "rpc_delivery_unknown",
			error: "Process restarted before acknowledgement",
		});
		await flush();
		expect(useComposerStore.getState().draft).toBe("preserve in-flight input\nnext draft");
		expect(useComposerStore.getState().submissionUncertain).toBe(true);
		expect(useComposerStore.getState().sending).toBe(false);
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("enables the platform spellcheck and autocorrect pipeline", async () => {
		await mount();
		const textarea = findTextarea();
		const propsKey = Object.getOwnPropertyNames(textarea).find(key => key.startsWith("__reactProps$"));
		const props = propsKey
			? ((textarea as unknown as Record<string, unknown>)[propsKey] as Record<string, unknown>)
			: undefined;
		expect(props?.spellCheck).toBe(true);
		expect(props?.autoCorrect).toBe("on");
		expect(props?.autoCapitalize).toBe("sentences");
	});

	it("routes `-> text` to followUp with the prefix stripped while streaming", async () => {
		await mount();
		await typeInto(findTextarea(), "-> ord alpha");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp).toHaveBeenCalledWith("ord alpha", []);
		expect(steer).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
	});

	it("routes `=> text` the same way while streaming", async () => {
		await mount();
		await typeInto(findTextarea(), "=> ship it");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(followUp).toHaveBeenCalledWith("ship it", []);
		expect(steer).not.toHaveBeenCalled();
	});

	it("preserves only the unacknowledged queue remainder and prevents retry after transport loss", async () => {
		await mount();
		followUp.mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error("transport disconnected"));
		await typeInto(findTextarea(), "=>\n1. accepted\n2. uncertain\n3. unsent");
		await pressEnter(findTextarea());
		await flush();
		await flush();
		expect(followUp).toHaveBeenCalledTimes(2);
		expect(useComposerStore.getState().draft).toBe("=>\n1. uncertain\n2. unsent");
		expect(useComposerStore.getState().submissionUncertain).toBe(true);
		await pressEnter(findTextarea());
		await flush();
		expect(followUp).toHaveBeenCalledTimes(2);
	});

	it("splits an enumerated list into one followUp per item while streaming", async () => {
		await mount();
		await typeInto(findTextarea(), "->\n1. alpha\n2. beta");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(followUp).toHaveBeenCalledTimes(2);
		expect(followUp).toHaveBeenNthCalledWith(1, "alpha", []);
		expect(followUp).toHaveBeenNthCalledWith(2, "beta", undefined);
		expect(steer).not.toHaveBeenCalled();
	});

	it("starts immediately as a followUp-behavior prompt when idle", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await typeInto(findTextarea(), "-> ord alpha");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledWith("ord alpha", [], "followUp");
		expect(followUp).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
	});

	it("still steers a plain (non-shorthand) message while streaming", async () => {
		await mount();
		await typeInto(findTextarea(), "plain guidance");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(steer).toHaveBeenCalledWith("plain guidance", []);
		expect(followUp).not.toHaveBeenCalled();
	});

	it("renders an idle prompt before its RPC settles and replaces the local echo on delivery", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		const deferred = Promise.withResolvers<RpcResponse>();
		prompt.mockReturnValueOnce(deferred.promise);
		await typeInto(findTextarea(), "slow network prompt");

		await pressEnter(findTextarea());
		await flush();

		expect(prompt).toHaveBeenCalledWith("slow network prompt", []);
		expect(useMessagesStore.getState().liveMessages).toMatchObject([
			{
				role: "user",
				content: [{ type: "text", text: "slow network prompt" }],
				optimistic: true,
			},
		]);

		const delivered: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "slow network prompt" }],
			timestamp: 2,
			entryId: "user-entry",
		};
		await act(async () =>
			useMessagesStore.getState().applyEvents([
				{ type: "message_start", message: delivered },
				{ type: "message_end", message: delivered },
			]),
		);
		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(useMessagesStore.getState().liveMessages).toEqual([
			{ ...delivered, optimistic: true, optimisticDelivered: true, optimisticAfterEntryId: null },
		]);
		expect(useMessagesStore.getState().streamingMessage).toBeNull();
		await act(async () => useMessagesStore.getState().applyEvents([{ type: "agent_end", messages: [delivered] }]));
		expect(useMessagesStore.getState().messages).toEqual([delivered]);
		expect(useMessagesStore.getState().liveMessages).toEqual([]);

		deferred.resolve(ok());
		await flush();
	});

	it("does not dispatch a deferred prompt through a tab selected after Enter", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await typeInto(findTextarea(), "stay in t0");
		vi.useFakeTimers();
		try {
			await pressEnter(findTextarea());
			useTabsStore.setState({ activeTabId: "t1" });
			await act(async () => {
				vi.runOnlyPendingTimers();
				await Promise.resolve();
			});
		} finally {
			vi.useRealTimers();
		}

		expect(prompt).not.toHaveBeenCalled();
	});

	it("does not dispatch or restore a deferred prompt after the tab replaces its session", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await typeInto(findTextarea(), "old session message");
		vi.useFakeTimers();
		try {
			await pressEnter(findTextarea());
			await act(async () => useSessionStore.setState({ sessionId: "s2" }));
			await act(async () => {
				vi.runOnlyPendingTimers();
				await Promise.resolve();
			});
		} finally {
			vi.useRealTimers();
		}

		expect(prompt).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("");
	});

	it("stops a multi-item queue before a later item can cross into another tab", async () => {
		await mount();
		const first = Promise.withResolvers<RpcResponse>();
		followUp.mockReturnValueOnce(first.promise);
		await typeInto(findTextarea(), "->\n1. alpha\n2. beta");
		await pressEnter(findTextarea());
		expect(followUp).toHaveBeenCalledTimes(1);

		useTabsStore.setState({ activeTabId: "t1" });
		first.resolve(ok());
		await flush();
		await flush();

		expect(followUp).toHaveBeenCalledTimes(1);
	});
});

describe("InputArea prompt history", () => {
	// ↑ recall replays text into the composer, so an entry is a promise that
	// pressing Enter again sends exactly that. Anything the sidecar never
	// accepted must stay out of the list.
	it("records a prompt once the sidecar accepts it", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await typeInto(findTextarea(), "delivered prompt");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledWith("delivered prompt", []);
		expect(useInputHistoryStore.getState().entries.map(entry => entry.prompt)).toEqual(["delivered prompt"]);
	});

	it("keeps a refused prompt out of history", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		prompt.mockReturnValueOnce(
			Promise.resolve<RpcResponse>({ type: "response", command: "prompt", success: false, error: "busy" }),
		);
		await typeInto(findTextarea(), "refused prompt");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(useInputHistoryStore.getState().entries).toEqual([]);
	});

	it("keeps a session-switch blocked by a running turn out of history", async () => {
		await mount();
		await typeInto(findTextarea(), "/new");
		await pressEnter(findTextarea());
		await flush();

		expect(prompt).not.toHaveBeenCalled();
		expect(useInputHistoryStore.getState().entries).toEqual([]);
	});

	it("does not record a shorthand whose remaining items were never dispatched", async () => {
		await mount();
		followUp.mockRejectedValueOnce(new Error("transport disconnected"));
		await typeInto(findTextarea(), "=>\n1. alpha\n2. beta");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(followUp).toHaveBeenCalledTimes(1);
		expect(useInputHistoryStore.getState().entries).toEqual([]);
	});

	it("opens history search from the composer's + menu", async () => {
		await mount();
		await openAddMenuItem("History");
		expect(document.querySelector('[role="dialog"][aria-label="History"]')).not.toBeNull();
	});
});

/** Drive the textarea's React onKeyDown with any key chord. */
async function pressKey(init: Record<string, unknown>): Promise<{ defaultPrevented: boolean }> {
	const textarea = findTextarea();
	const propsKey = Object.getOwnPropertyNames(textarea).find(key => key.startsWith("__reactProps$"));
	const props = propsKey
		? ((textarea as unknown as Record<string, unknown>)[propsKey] as {
				onKeyDown?: (event: Record<string, unknown>) => void;
			})
		: undefined;
	if (!props?.onKeyDown) throw new Error("textarea onKeyDown not found");
	const state = { defaultPrevented: false };
	await act(async () =>
		props.onKeyDown?.({
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			nativeEvent: { isComposing: false },
			preventDefault: () => {
				state.defaultPrevented = true;
			},
			stopPropagation: () => {},
			...init,
		}),
	);
	return state;
}

/** Open the composer's + menu and pick the item whose label starts with `label`. */
async function openAddMenuItem(label: string): Promise<void> {
	const add = document.querySelector('button[aria-label="Attach and more"]') as unknown as TestElement | null;
	if (!add) throw new Error("+ menu trigger missing");
	await click(add);
	const item = (Array.from(document.querySelectorAll("[data-menu-item]")) as unknown as TestElement[]).find(entry =>
		entry.textContent?.startsWith(label),
	);
	if (!item) throw new Error(`+ menu item ${label} missing`);
	await click(item);
	await flush();
}

function isExpanded(): boolean {
	return document.querySelector(".omp-composer-region--expanded") !== null;
}

describe("InputArea next-prompt suggestion", () => {
	// The `next-prompt` extension can't see Tab over RPC, so the composer owns
	// its widget: gray placeholder, Tab on an empty composer takes it.
	const showSuggestion = () =>
		act(async () =>
			useExtensionUiStore.getState().setWidget("next-prompt", ["\x1b[2m↹ Tab  ompdesk로 가자\x1b[22m"]),
		);

	afterEach(() => useExtensionUiStore.getState().clearAll());

	it("shows the suggestion as the placeholder and Tab fills it in", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await showSuggestion();
		expect(findTextarea().getAttribute("placeholder")).toBe("ompdesk로 가자");
		// Tab / → chips announce the accept keys; the field is described by them.
		const hintId = findTextarea().getAttribute("aria-describedby");
		expect(hintId).toBeTruthy();
		expect(document.getElementById(hintId ?? "")?.textContent).toBe("Tab→to accept");

		expect((await pressKey({ key: "Tab" })).defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("ompdesk로 가자");
		expect(useExtensionUiStore.getState().widgetPanels["next-prompt"]).toBeUndefined();
		expect(findTextarea().getAttribute("aria-describedby")).toBeNull();
	});

	it("→ on an empty composer fills the suggestion in too", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await showSuggestion();

		expect((await pressKey({ key: "ArrowRight" })).defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("ompdesk로 가자");
	});

	it("leaves Tab alone once the user has typed", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await showSuggestion();
		await typeInto(findTextarea(), "직접 입력");

		expect((await pressKey({ key: "Tab" })).defaultPrevented).toBe(false);
		expect(useComposerStore.getState().draft).toBe("직접 입력");
		expect(useExtensionUiStore.getState().widgetPanels["next-prompt"]).toBeUndefined();
	});

	it("hides the suggestion while a turn streams", async () => {
		await mount();
		await showSuggestion();
		expect(findTextarea().getAttribute("placeholder")).not.toBe("ompdesk로 가자");
	});

	it("puts Stop in the send slot while a turn streams with nothing typed", async () => {
		await mount();
		expect(document.querySelector('button[aria-label="Send"]')).toBeNull();
		expect(document.querySelector('button[aria-label="Stop"]')).not.toBeNull();
		await typeInto(findTextarea(), "steer this");
		expect(document.querySelector('button[aria-label="Send"]')).not.toBeNull();
		expect(document.querySelector('button[aria-label="Stop"]')).not.toBeNull();
	});
});

describe("InputArea expanded composer", () => {
	// ⌃G alone was undiscoverable, so the + menu offers it too. Both grow the
	// same field in place: no second editor, no modal over the session.
	it("expands in place from the + menu and from ⌃G, and Esc collapses without aborting", async () => {
		await mount();
		expect(isExpanded()).toBe(false);

		await openAddMenuItem("Expand composer");
		expect(isExpanded()).toBe(true);

		await pressKey({ key: "g", ctrlKey: true });
		expect(isExpanded()).toBe(false);
		await pressKey({ key: "g", ctrlKey: true });
		expect(isExpanded()).toBe(true);

		// Escape is claimed (preventDefault) so the app-wide handler never aborts the turn.
		const escapeKey = await pressKey({ key: "Escape" });
		expect(escapeKey.defaultPrevented).toBe(true);
		expect(isExpanded()).toBe(false);
	});

	it("treats Enter as a newline while expanded and sends on ⌘↵", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await pressKey({ key: "g", ctrlKey: true });
		await typeInto(findTextarea(), "long draft");

		const enter = await pressKey({ key: "Enter" });
		expect(enter.defaultPrevented).toBe(false);
		expect(prompt).not.toHaveBeenCalled();

		await pressKey({ key: "Enter", metaKey: true });
		await flush();
		expect(prompt).toHaveBeenCalledWith("long draft", []);
		expect(isExpanded()).toBe(false);
	});

	it("round-trips the expanded draft through the external editor with paste markers resolved", async () => {
		await mount();
		const openExternal = vi.fn(async () => ({ ok: true, unavailable: false, text: "edited outside" }));
		(window.omp as unknown as Record<string, unknown>).editor = { openExternal };
		const blob = storePaste("alpha\nbravo");
		await typeInto(findTextarea(), `summary ${pasteMarkerText(blob.id, blob.content)}`);
		await pressKey({ key: "g", ctrlKey: true });

		const external = buttonWithText("Open in external editor");
		if (!external) throw new Error("external editor action missing");
		await click(external);
		await flush();

		expect(openExternal).toHaveBeenCalledWith("summary alpha\nbravo");
		expect(useComposerStore.getState().draft).toBe("edited outside");
	});
});

describe("InputArea run settings and modes", () => {
	async function openRunSettings(): Promise<void> {
		const trigger = document.querySelector("button[data-run-settings-trigger]") as unknown as TestElement | null;
		if (!trigger) throw new Error("run settings trigger missing");
		await click(trigger);
	}

	/** Set a select's value and drive its React onChange contract. */
	async function choose(selector: string, value: string): Promise<void> {
		const select = document.querySelector(selector) as unknown as TestElement | null;
		if (!select) throw new Error(`${selector} missing`);
		const record = select as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
		if (!props?.onChange) throw new Error("select onChange not found");
		// linkedom's select.value is read-only; the handler reads the event target.
		await act(async () => props.onChange?.({ target: { value }, currentTarget: { value } }));
	}

	it("keeps one calm toolbar at every width: model name, mode chip, run settings", async () => {
		useModelStore.setState({ model: { provider: "acme", id: "acme-opus-5", name: "Acme Opus 5" } });
		for (const width of [1200, 600, 380]) {
			setWindowWidth(width);
			await mount();
			const model = document.querySelector("button[data-model-chip]") as unknown as TestElement | null;
			// The chip shows the display name; the id stays in its tooltip.
			expect(model?.textContent).toBe("Acme Opus 5");
			expect(document.querySelector("button[data-composer-modes-trigger]")).not.toBeNull();
			const runSettings = document.querySelector("button[data-run-settings-trigger]");
			expect(runSettings?.textContent).toContain(translate("input.thinking.name.high"));
			await act(async () => root.unmount());
			container.remove();
		}
		await mount();
	});

	it("names the composer field for assistive tech", async () => {
		await mount();
		expect(findTextarea().getAttribute("aria-label")).toBe("Message");
	});

	it("applies a thinking level picked inside the run settings popover", async () => {
		await mount();
		await openRunSettings();
		await choose("select[data-thinking-level]", "max");
		await flush();

		expect(setThinkingLevel).toHaveBeenCalledWith("max");
		expect(useModelStore.getState().thinkingConfigured).toBe("max");
	});

	it("persists a stricter tool approval picked inside the popover", async () => {
		await mount();
		await openRunSettings();
		await choose("select[data-approval-mode]", "always-ask");

		expect(setSetting).toHaveBeenCalledWith("tools.approvalMode", "always-ask");
		expect(useSettingsStore.getState().approvalMode).toBe("always-ask");
	});

	it("shows fast mode as an on switch when enabled, even if this model cannot use it", async () => {
		useModelStore.setState({ fastModeEnabled: true, fastModeActive: false });
		await mount();
		await openRunSettings();

		const fast = document.querySelector('[data-fast-mode] [role="switch"], [role="switch"][data-fast-mode]');
		expect(fast?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.textContent).toContain("Not on this model");
	});

	it("toggles plan mode from the mode chip, separate from run settings", async () => {
		await mount();
		const modes = document.querySelector("button[data-composer-modes-trigger]") as unknown as TestElement | null;
		if (!modes) throw new Error("mode chip missing");
		await click(modes);
		await flush();

		const plan = document.querySelector('[role="switch"]') as unknown as TestElement | null;
		if (!plan) throw new Error("plan switch missing");
		await click(plan);
		await flush();

		expect(setPlanMode).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
	});
});
