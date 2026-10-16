/**
 * InputArea interaction contracts: queue shorthand routing, prompt history,
 * the in-place expanded composer (⌃G), and the toolbar's Run settings / mode
 * popovers dispatching their choices.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { resetSessionSurface } from "../../hooks/use-session-switch";
import { clearHistoryImages, rememberHistoryImages } from "../../lib/history-images";
import { I18nProvider, translate } from "../../lib/i18n";
import { expandPasteMarkers, pasteMarkerText, storePaste } from "../../lib/paste-blobs";
import { METER_BARS } from "../../lib/voice";
import { useComposerStore } from "../../stores/composer";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { useFirstRunStore } from "../../stores/first-run";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useNextPromptStore } from "../../stores/next-prompt";
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
import { pushTabExtensionUiRequest, useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { type FakeMic, FakeStream, installFakeMic, uninstallFakeMic } from "../../test-support/dictation";
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
if (typeof elementPrototype.setSelectionRange !== "function")
	elementPrototype.setSelectionRange = function (this: Record<string, unknown>, start: number, end: number) {
		this.selectionStart = start;
		this.selectionEnd = end;
	};
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
	const history: Array<{ prompt: string; cwd?: string; created_at: number }> = [];
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		// RunSettings' Context row (ContextSizeField) re-reads compaction limits on config changes.
		events: { onTabCommandsUpdate: vi.fn(() => () => {}), onConfigUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			historyRecord: vi.fn(async (prompt: string, cwd?: string) => {
				history.unshift({ prompt, cwd, created_at: Date.now() / 1000 });
				return ok({ skipped: false });
			}),
			historyRecent: vi.fn(async () => ok(history)),
			historySearch: vi.fn(async () => ok(history)),
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			command: vi.fn(async (command: RpcCommand) => {
				if (command.type === "get_queue") return ok({ steering: [], followUp: [] });
				if (command.type === "set_setting") return setSetting(command.path, command.value);
				return ok();
			}),
			followUp,
			steer,
			prompt,
			abortAndRestoreQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
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
	useFirstRunStore.getState().reset();
	useToastStore.setState({ toasts: [], heldSince: null });
	useUiStore.setState({ panelTab: "diff", branchPickerOpen: false, modesOpen: false, destination: "session" });
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

	it("queues an extension command whose name has an underscore through prompt, not followUp", async () => {
		await mount();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () => deliver([{ name: "my_cmd", description: "Ext", source: "extension" }], "t0"));
		await typeInto(findTextarea(), "-> /my_cmd now");
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledWith("/my_cmd now", []);
		expect(followUp).not.toHaveBeenCalled();
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

	/** linkedom keeps no caret: the composer reads these as the textarea's selection. */
	function placeCaret(position: number): void {
		Object.assign(findTextarea(), { selectionStart: position, selectionEnd: position });
	}
	function composerValue(): string {
		const textarea: object = findTextarea();
		if (!("value" in textarea) || typeof textarea.value !== "string") throw new Error("composer value not found");
		return textarea.value;
	}
	async function seedHistory(...prompts: string[]): Promise<void> {
		await act(async () =>
			useInputHistoryStore.setState({
				// Newest first; transient so the mount's stock hydrate keeps them.
				entries: prompts.map((prompt, index) => ({ prompt, ts: 100 - index, cwd: "/tmp", transient: true })),
			}),
		);
	}

	it("recalls on ↑ only from an empty composer or the very start of the text", async () => {
		await mount();
		await seedHistory("older prompt");
		await typeInto(findTextarea(), "first line\nsecond line");

		// Inside multi-line text ↑ is the caret's: neither another line nor the first line's middle recalls.
		placeCaret(15);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(false);
		placeCaret(4);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(false);
		expect(composerValue()).toBe("first line\nsecond line");

		placeCaret(0);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(true);
		expect(composerValue()).toBe("older prompt");

		await typeInto(findTextarea(), "");
		placeCaret(0);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(true);
		expect(composerValue()).toBe("older prompt");
	});

	it("brings back the pictures sent with a recalled prompt, and the draft's own on the way back", async () => {
		await mount();
		const sent = { content: { type: "image" as const, data: "AA==", mimeType: "image/png" }, preview: "data:sent" };
		const draft = { content: { type: "image" as const, data: "AQ==", mimeType: "image/png" }, preview: "data:draft" };
		rememberHistoryImages("with a picture", [sent]);
		await seedHistory("with a picture");
		await act(async () => useComposerStore.getState().setImages([draft]));
		placeCaret(0);
		await pressKey({ key: "ArrowUp" });
		expect(composerValue()).toBe("with a picture");
		expect(useComposerStore.getState().images).toEqual([sent]);
		placeCaret(composerValue().length);
		await pressKey({ key: "ArrowDown" });
		expect(composerValue()).toBe("");
		expect(useComposerStore.getState().images).toEqual([draft]);
		clearHistoryImages();
	});

	function caret(): number | undefined {
		const textarea: object = findTextarea();
		return "selectionStart" in textarea && typeof textarea.selectionStart === "number"
			? textarea.selectionStart
			: undefined;
	}

	it("walks older on ↑ by placing the caret at position 0, and only there", async () => {
		await mount();
		await seedHistory("newest line one\nnewest line two", "middle prompt", "oldest prompt");
		await typeInto(findTextarea(), "draft");
		placeCaret(0);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(true);
		await flush();
		expect(composerValue()).toBe("newest line one\nnewest line two");
		expect(caret()).toBe(0);

		// A recalled entry gets no exception: off position 0, ↑ is the caret's even on the first line.
		placeCaret(3);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(false);
		expect(composerValue()).toBe("newest line one\nnewest line two");

		// Back at 0 (where the recall left it), plain ↑ presses keep walking without a caret step.
		placeCaret(0);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(true);
		await flush();
		expect(composerValue()).toBe("middle prompt");
		expect(caret()).toBe(0);
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(true);
		await flush();
		expect(composerValue()).toBe("oldest prompt");
		expect(caret()).toBe(0);
		// Nothing older: the key falls through to the caret.
		expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(false);
		expect(composerValue()).toBe("oldest prompt");
	});

	it("walks newer on ↓ only from the very end, placing the caret back at the end", async () => {
		await mount();
		await seedHistory("newer line one\nnewer line two", "older prompt");
		await typeInto(findTextarea(), "draft");
		placeCaret(0);
		await pressKey({ key: "ArrowUp" });
		await flush();
		await pressKey({ key: "ArrowUp" });
		await flush();
		expect(composerValue()).toBe("older prompt");

		// ↑ left the caret at 0: ↓ there (or anywhere short of the end) is the caret's.
		expect((await pressKey({ key: "ArrowDown" })).defaultPrevented).toBe(false);
		placeCaret(5);
		expect((await pressKey({ key: "ArrowDown" })).defaultPrevented).toBe(false);
		expect(composerValue()).toBe("older prompt");

		placeCaret("older prompt".length);
		expect((await pressKey({ key: "ArrowDown" })).defaultPrevented).toBe(true);
		await flush();
		expect(composerValue()).toBe("newer line one\nnewer line two");
		expect(caret()).toBe("newer line one\nnewer line two".length);
		// The caret already sits at the end, so the next ↓ returns the stashed draft directly.
		expect((await pressKey({ key: "ArrowDown" })).defaultPrevented).toBe(true);
		await flush();
		expect(composerValue()).toBe("draft");
		expect(caret()).toBe("draft".length);
	});

	it("places the recall's caret with its text, so a selection made before the next frame stays", async () => {
		await mount();
		await seedHistory("recalled prompt");
		// The next frame has not come yet when the following keys arrive (a busy renderer).
		const frames: (() => void)[] = [];
		const realFrame = globals.requestAnimationFrame;
		globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
		try {
			placeCaret(0);
			expect((await pressKey({ key: "ArrowUp" })).defaultPrevented).toBe(true);
			expect(composerValue()).toBe("recalled prompt");
			expect(caret()).toBe(0);
			// A select-all right after the recall, as Playwright's fill does before its Delete.
			Object.assign(findTextarea(), { selectionStart: 0, selectionEnd: "recalled prompt".length });
			await act(async () => {
				for (const frame of frames.splice(0)) frame();
			});
		} finally {
			globals.requestAnimationFrame = realFrame;
		}
		const textarea: object = findTextarea();
		expect("selectionEnd" in textarea ? textarea.selectionEnd : undefined).toBe("recalled prompt".length);
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
	// its widget: gray placeholder, Tab on an empty composer takes it. The GUI
	// remembers it per session until a submit or a new run makes it stale.
	const SUGGESTION = "ompdesk로 가자";
	const pushWidget = (widgetLines?: string[]) =>
		act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "widget-next-prompt",
				method: "setWidget",
				widgetKey: "next-prompt",
				widgetLines,
			}),
		);
	const showSuggestion = (text = SUGGESTION) => pushWidget([`\x1b[2m↹ Tab  ${text}\x1b[22m`]);
	/** The extension clears its widget on input, agent_start and session_start. */
	const extensionClears = () => pushWidget(undefined);
	const placeholder = () => findTextarea().getAttribute("placeholder");
	const hintText = () =>
		document.getElementById(findTextarea().getAttribute("aria-describedby") ?? "")?.textContent ?? null;
	const idle = () => act(async () => useSessionStore.setState({ isStreaming: false }));

	afterEach(async () => {
		await act(async () => {
			useExtensionUiStore.getState().clearAll();
			useNextPromptStore.getState().reset();
		});
	});

	it("shows the suggestion as the placeholder and Tab fills it in", async () => {
		await mount();
		await idle();
		await showSuggestion();
		expect(placeholder()).toBe(SUGGESTION);
		// Tab / → chips announce the accept keys; the field is described by them.
		expect(hintText()).toBe("Tab→to accept");

		expect((await pressKey({ key: "Tab" })).defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe(SUGGESTION);
		expect(findTextarea().getAttribute("aria-describedby")).toBeNull();
	});

	it("→ on an empty composer fills the suggestion in too", async () => {
		await mount();
		await idle();
		await showSuggestion();

		expect((await pressKey({ key: "ArrowRight" })).defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe(SUGGESTION);
	});

	it("brings the suggestion back when the accepted text is deleted", async () => {
		await mount();
		await idle();
		await showSuggestion();
		await pressKey({ key: "Tab" });
		await extensionClears();

		await typeInto(findTextarea(), "");
		expect(placeholder()).toBe(SUGGESTION);
		expect(hintText()).toBe("Tab→to accept");
		expect((await pressKey({ key: "Tab" })).defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe(SUGGESTION);
	});

	it("leaves Tab alone while the user has typed, and returns once the draft is empty", async () => {
		await mount();
		await idle();
		await showSuggestion();
		await typeInto(findTextarea(), "직접 입력");
		await extensionClears();

		expect((await pressKey({ key: "Tab" })).defaultPrevented).toBe(false);
		expect(useComposerStore.getState().draft).toBe("직접 입력");

		await typeInto(findTextarea(), "");
		expect(placeholder()).toBe(SUGGESTION);
		expect(hintText()).toBe("Tab→to accept");
	});

	it("restores a session's suggestion after switching away and back", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false, sessionFile: "/sessions/a.jsonl" }));
		await showSuggestion();

		await act(async () => {
			resetSessionSurface();
			useSessionStore.setState({ status: "ready", sessionId: "s2", sessionFile: "/sessions/b.jsonl" });
		});
		expect(placeholder()).not.toBe(SUGGESTION);

		await act(async () => {
			resetSessionSurface();
			useSessionStore.setState({ status: "ready", sessionId: "s1", sessionFile: "/sessions/a.jsonl" });
		});
		await extensionClears();
		expect(placeholder()).toBe(SUGGESTION);
		expect(hintText()).toBe("Tab→to accept");
	});

	it("shows a suggestion a background tab published while hidden once that tab is shown", async () => {
		await mount(true);
		const background = createTabRuntime("t1");
		withSessionRuntime("t1", () =>
			useSessionStore.setState({
				status: "ready",
				sessionId: "bg",
				sessionFile: "/sessions/bg.jsonl",
				cwd: "/other",
			}),
		);
		// Main forwards every tab's extension UI; the frame parks in t1's runtime.
		await act(async () =>
			pushTabExtensionUiRequest("t1", {
				type: "extension_ui_request",
				id: "widget-bg",
				method: "setWidget",
				widgetKey: "next-prompt",
				widgetLines: [`\x1b[2m↹ Tab  ${SUGGESTION}\x1b[22m`],
			}),
		);
		expect(placeholder()).not.toBe(SUGGESTION);

		// Switching to t1 renders its composer from its own runtime.
		await act(async () => {
			root.render(
				<I18nProvider>
					<SessionRuntimeProvider runtime={background}>
						<InputArea />
					</SessionRuntimeProvider>
				</I18nProvider>,
			);
		});
		await flush();
		expect(placeholder()).toBe(SUGGESTION);
	});

	it("drops the suggestion once the user submits in that session", async () => {
		await mount();
		await idle();
		await showSuggestion();
		await pressKey({ key: "Tab" });
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledWith(SUGGESTION, []);
		await act(async () => useComposerStore.getState().setSending(false));

		expect(useComposerStore.getState().draft).toBe("");
		expect(placeholder()).not.toBe(SUGGESTION);
		expect(findTextarea().getAttribute("aria-describedby")).toBeNull();
	});

	it("drops the suggestion when a new run starts in that session", async () => {
		await mount();
		await idle();
		await showSuggestion();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await idle();
		expect(placeholder()).not.toBe(SUGGESTION);
	});

	it("drops the suggestion when a run starts in that session's background tab", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false, sessionFile: "/sessions/a.jsonl" }));
		await showSuggestion();
		await act(async () =>
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab =>
					tab.id === "t0" ? { ...tab, status: "running", sessionPath: "/sessions/a.jsonl" } : tab,
				),
			})),
		);
		expect(placeholder()).not.toBe(SUGGESTION);
	});

	it("replaces the suggestion when a new one arrives", async () => {
		await mount();
		await idle();
		await showSuggestion();
		await showSuggestion("테스트 돌려줘");
		expect(placeholder()).toBe("테스트 돌려줘");
		await pressKey({ key: "Tab" });
		expect(useComposerStore.getState().draft).toBe("테스트 돌려줘");
	});

	it("hides the suggestion while a turn streams", async () => {
		await mount();
		await showSuggestion();
		expect(placeholder()).not.toBe(SUGGESTION);
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

	it("edits a folded paste from its chip and rewrites only that marker", async () => {
		await mount();
		const blob = storePaste("one\ntwo");
		await typeInto(findTextarea(), `see ${pasteMarkerText(blob.id, blob.content)} please`);
		const chip = document.querySelector(`[data-paste-chip="${blob.id}"]`) as unknown as TestElement | null;
		expect(chip?.textContent).toBe(`Paste #${blob.id} · 2 lines`);
		await click(chip as TestElement);
		const editor = document.querySelector('[role="dialog"] textarea') as unknown as TestElement | null;
		if (!editor) throw new Error("paste editor missing");
		expect((editor as unknown as { value: string }).value).toBe("one\ntwo");
		await typeInto(editor, "one\ntwo\nthree");
		await click(document.querySelector("[data-paste-save]") as unknown as TestElement);
		await flush();
		const draft = useComposerStore.getState().draft;
		expect(draft).toBe(`see ${pasteMarkerText(blob.id, "one\ntwo\nthree")} please`);
		expect(expandPasteMarkers(draft)).toBe("see one\ntwo\nthree please");
	});
});

describe("InputArea file intake", () => {
	function reactProps<T>(element: unknown): T {
		const record = element as Record<string, unknown>;
		const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
		if (!key) throw new Error("react props not found");
		return record[key] as T;
	}

	async function mountWithPaths(paths: Record<string, string>): Promise<void> {
		await mount();
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = (file: File) => paths[file.name] ?? "";
	}

	it("turns files and folders dropped from the OS into @path mentions, relative inside the project", async () => {
		await mountWithPaths({
			"spec.pdf": "/tmp/docs/spec.pdf",
			"deck.pptx": "/Users/me/My Deck.pptx",
			src: "/tmp/src",
		});
		const box = document.querySelector(".omp-composer-box");
		const { onDrop } = reactProps<{ onDrop: (event: object) => void }>(box);
		const files = [
			new File([new Uint8Array([37, 80, 68, 70, 0])], "spec.pdf", { type: "application/pdf" }),
			new File([new Uint8Array([80, 75, 3, 4])], "deck.pptx"),
			new File([], "src"),
		];
		await act(async () => onDrop({ dataTransfer: { types: ["Files"], files }, preventDefault: () => {} }));
		await flush();
		expect(useComposerStore.getState().draft).toBe('@docs/spec.pdf @"/Users/me/My Deck.pptx" @src ');
	});

	it("pastes a clipboard file without a path as its text and refuses a pathless binary", async () => {
		await mountWithPaths({});
		const { onPaste } = reactProps<{ onPaste: (event: object) => void }>(findTextarea());
		const files = [
			new File(["line one\nline two"], "notes.txt", { type: "text/plain" }),
			new File([new Uint8Array([0, 1])], "blob.bin"),
		];
		let prevented = false;
		await act(async () =>
			onPaste({
				clipboardData: { files, getData: () => "" },
				preventDefault: () => {
					prevented = true;
				},
			}),
		);
		await flush();
		expect(prevented).toBe(true);
		const draft = useComposerStore.getState().draft;
		expect(draft).toMatch(/^\[Paste #\d+, \d+ chars\] $/);
		expect(expandPasteMarkers(draft)).toBe(`<attachment name="notes.txt">\nline one\nline two\n</attachment> `);
		expect(useToastStore.getState().toasts.map(item => item.message)).toEqual([
			translate("input.files.noPath", { name: "blob.bin" }),
		]);
	});

	it("offers every file type in the + menu picker", async () => {
		await mount();
		const input = document.querySelector('input[type="file"]');
		expect(input?.getAttribute("accept")).toBeNull();
	});
});

describe("InputArea composer keys", () => {
	function setCaret(start: number, end = start): void {
		const textarea = findTextarea() as unknown as { selectionStart: number; selectionEnd: number };
		textarea.selectionStart = start;
		textarea.selectionEnd = end;
	}

	async function mountIdle(doubleEscapeAction?: string): Promise<void> {
		await mount();
		(window.omp.rpc as unknown as Record<string, unknown>).getSettings = vi.fn(async () =>
			ok({ values: doubleEscapeAction === undefined ? {} : { doubleEscapeAction } }),
		);
		await act(async () => useSessionStore.setState({ isStreaming: false }));
	}

	it("inserts a newline with ⌃J and deletes back to the line start with ⌃U", async () => {
		await mountIdle();
		await typeInto(findTextarea(), "first\nsecond line");
		setCaret(12);
		await pressKey({ key: "j", ctrlKey: true });
		expect(useComposerStore.getState().draft).toBe("first\nsecond\n line");
		await typeInto(findTextarea(), "first\nsecond line");
		setCaret(12);
		await pressKey({ key: "u", ctrlKey: true });
		expect(useComposerStore.getState().draft).toBe("first\n line");
		setCaret(0, 5);
		await pressKey({ key: "u", ctrlKey: true });
		expect(useComposerStore.getState().draft).toBe("\n line");
	});

	it("⌃U at the very start of a draft that begins with a newline deletes nothing", async () => {
		await mountIdle();
		await typeInto(findTextarea(), "\nsecond");
		setCaret(0);
		await pressKey({ key: "u", ctrlKey: true });
		expect(useComposerStore.getState().draft).toBe("\nsecond");
	});

	it("keeps the slash menu open for names with a colon, a digit or an underscore", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () =>
			deliver(
				[
					{ name: "skill:release-notes", description: "Write notes", source: "skill" },
					{ name: "gpt5_mode", description: "Switch", source: "extension" },
				],
				"t0",
			),
		);
		const labels = () => Array.from(document.querySelectorAll('[role="option"]')).map(option => option.textContent);
		setCaret(10);
		await typeInto(findTextarea(), "/skill:rel");
		await flush();
		expect(labels()).toHaveLength(1);
		expect(labels()[0]).toContain("/skill:release-notes");
		setCaret(6);
		await typeInto(findTextarea(), "/gpt5_");
		await flush();
		expect(labels()[0]).toContain("/gpt5_mode");
	});

	it("sends once while Enter is held down", async () => {
		await mountIdle();
		await typeInto(findTextarea(), "hello");
		const held = await pressKey({ key: "Enter", repeat: true });
		expect(held.defaultPrevented).toBe(true);
		await flush();
		expect(prompt).not.toHaveBeenCalled();
		await pressKey({ key: "Enter" });
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("collapses a selection on Esc, then clears the draft on a second Esc into ↑ history", async () => {
		await mountIdle();
		await typeInto(findTextarea(), "keep this draft");
		setCaret(0, 4);
		await pressKey({ key: "Escape" });
		expect(useComposerStore.getState().draft).toBe("keep this draft");
		expect(document.querySelector("[data-esc-hint]")).toBeNull();

		setCaret(15);
		const first = await pressKey({ key: "Escape" });
		expect(first.defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("keep this draft");
		expect(document.querySelector("[data-esc-hint]")?.textContent).toBe(translate("input.escAgainToClear"));

		await pressKey({ key: "Escape" });
		expect(useComposerStore.getState().draft).toBe("");
		expect(useInputHistoryStore.getState().entries[0]?.prompt).toBe("keep this draft");
		expect(document.querySelector("[data-esc-hint]")).toBeNull();
	});

	it("leaves Esc to the app-wide stop while a turn runs", async () => {
		await mount();
		await typeInto(findTextarea(), "steer later");
		const stop = await pressKey({ key: "Escape" });
		expect(stop.defaultPrevented).toBe(false);
		expect(useComposerStore.getState().draft).toBe("steer later");
	});

	it("runs stock's double-Esc action from an empty composer", async () => {
		await mountIdle();
		await pressKey({ key: "Escape" });
		await pressKey({ key: "Escape" });
		await flush();
		expect(useUiStore.getState().branchPickerOpen).toBe(true);
		await act(async () => useUiStore.getState().closeBranchPicker());
		await act(async () => root.unmount());
		container.remove();

		await mountIdle("tree");
		await pressKey({ key: "Escape" });
		await pressKey({ key: "Escape" });
		await flush();
		expect(useUiStore.getState().panelTab).toBe("tree");
	});

	it("moves through the completion menu with Home, End, PageUp and PageDown", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		const commands = Array.from({ length: 8 }, (_, index) => ({
			name: `cmd${index}`,
			description: `Command ${index}`,
		}));
		await act(async () => deliver(commands, "t0"));
		setCaret(1);
		await typeInto(findTextarea(), "/");
		await flush();
		const options = () => Array.from(document.querySelectorAll('[role="option"]'));
		const selected = () => options().findIndex(option => option.getAttribute("aria-selected") === "true");
		expect(options().length).toBeGreaterThan(6);
		await pressKey({ key: "End" });
		expect(selected()).toBe(options().length - 1);
		await pressKey({ key: "Home" });
		expect(selected()).toBe(0);
		await pressKey({ key: "PageDown" });
		expect(selected()).toBe(5);
		await pressKey({ key: "PageUp" });
		expect(selected()).toBe(0);
	});

	it("keeps the highlighted completion row when the same commands are delivered again", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		const commands = [{ name: "cmd0" }, { name: "cmd1" }, { name: "cmd2" }];
		await act(async () => deliver(commands, "t0"));
		setCaret(1);
		await typeInto(findTextarea(), "/");
		await flush();
		await pressKey({ key: "ArrowDown" });
		await pressKey({ key: "ArrowDown" });
		const selected = () =>
			Array.from(document.querySelectorAll('[role="option"]')).findIndex(
				option => option.getAttribute("aria-selected") === "true",
			);
		expect(selected()).toBe(2);
		await act(async () => deliver(commands, "t0"));
		await flush();
		expect(selected()).toBe(2);
	});

	it("points the field at the highlighted completion row for assistive tech", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () => deliver([{ name: "cmd0" }, { name: "cmd1" }], "t0"));
		const field = findTextarea();
		expect(field.getAttribute("aria-controls")).toBeNull();
		setCaret(1);
		await typeInto(field, "/");
		await flush();
		const listbox = document.querySelector('[role="listbox"]');
		const rows = Array.from(document.querySelectorAll('[role="option"]'));
		expect(field.getAttribute("aria-controls")).toBe(listbox?.getAttribute("id"));
		expect(field.getAttribute("aria-activedescendant")).toBe(rows[0]?.getAttribute("id"));
		await pressKey({ key: "ArrowDown" });
		expect(field.getAttribute("aria-activedescendant")).toBe(rows[1]?.getAttribute("id"));
		expect(rows[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("offers skills after $ anywhere and inserts stock's /skill: token; warns for a skill that is off", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () =>
			deliver(
				[
					{ name: "compact", description: "Compact" },
					{ name: "skill:release-notes", description: "Write notes", source: "skill" },
					{ name: "skill:review", description: "Review a change", source: "skill" },
				],
				"t0",
			),
		);
		setCaret(15);
		await typeInto(findTextarea(), "check this $rev");
		await flush();
		const options = Array.from(document.querySelectorAll('[role="option"]')).map(option => option.textContent);
		expect(options).toHaveLength(1);
		expect(options[0]).toContain("$review");
		await pressKey({ key: "Enter" });
		expect(useComposerStore.getState().draft).toBe("check this /skill:review ");

		await typeInto(findTextarea(), "use /skill:gone here");
		await flush();
		await pressKey({ key: "Enter" });
		await flush();
		expect(prompt).toHaveBeenCalledWith("use /skill:gone here", []);
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain(
			translate("input.skills.off", { name: "gone" }),
		);
	});

	it("says no skill is on when $ finds none", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () => deliver([{ name: "compact", description: "Compact" }], "t0"));
		setCaret(1);
		await typeInto(findTextarea(), "$");
		await flush();
		expect(document.querySelector('[role="option"]')).toBeNull();
		expect(container.textContent).toContain(translate("input.skills.none"));
	});

	it("lists Set a goal, the skills that are on and Manage in the + menu", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () =>
			deliver(
				[
					{ name: "compact", description: "Compact" },
					{ name: "skill:review", description: "Review a change", source: "skill" },
				],
				"t0",
			),
		);
		await typeInto(findTextarea(), "fix this");
		setCaret(8);
		await openAddMenuItem("review");
		expect(useComposerStore.getState().draft).toBe("fix this /skill:review ");

		// The goal tab of the modes popover listens to session events.
		Object.assign(window.omp.events, { onBatch: vi.fn(() => () => {}) });
		await openAddMenuItem("Set a goal");
		expect(useUiStore.getState()).toMatchObject({ modesOpen: true, modesTab: "goal" });
		await act(async () => useUiStore.setState({ modesOpen: false }));
		await openAddMenuItem("Manage skills, plugins and MCP");
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "tools:skills" });
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

	it("names the effort auto picked for the latest turn on the run settings chip", async () => {
		await mount();
		const chip = () => document.querySelector("button[data-run-settings-trigger]")?.textContent;
		await act(async () => useModelStore.setState({ thinkingConfigured: "auto" }));
		expect(chip()).toContain(translate("input.thinking.name.auto"));
		expect(chip()).not.toContain("·");
		await act(async () => useModelStore.setState({ thinkingAutoResolved: "xhigh" }));
		expect(chip()).toContain(
			translate("input.thinking.autoResolved", { level: translate("input.thinking.name.xhigh") }),
		);
	});

	it("names the composer field for assistive tech", async () => {
		await mount();
		expect(findTextarea().getAttribute("aria-label")).toBe("Message");
	});

	it("takes the caret back when first-run setup hands over to the empty session", async () => {
		await act(async () => useFirstRunStore.getState().setPhase("model", "audit"));
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		const focus = vi.spyOn(findTextarea() as unknown as HTMLElement, "focus");
		// "Start with this model" unmounts the setup button that held focus.
		await act(async () => useFirstRunStore.getState().setPhase("idle", null));
		expect(focus).toHaveBeenCalled();
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

	it("gives a chat tab the same mode chip and approval mode as an agent tab", async () => {
		await mount();
		await act(async () => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => (tab.id === "t0" ? { ...tab, kind: "chat" } : tab)),
			}));
			useSessionStore.setState({ isStreaming: false });
		});
		await flush();

		expect(findTextarea().getAttribute("placeholder")).toBe(translate("input.placeholder.chat"));
		expect(document.querySelector("button[data-composer-modes-trigger]")).not.toBeNull();
		await openRunSettings();
		await choose("select[data-approval-mode]", "always-ask");
		expect(setSetting).toHaveBeenCalledWith("tools.approvalMode", "always-ask");
	});

	it("shows fast mode as an on switch when enabled, even if this model cannot use it", async () => {
		useModelStore.setState({ fastModeEnabled: true, fastModeActive: false });
		await mount();
		await openRunSettings();

		const fast = document.querySelector('[data-fast-mode] [role="switch"], [role="switch"][data-fast-mode]');
		expect(fast?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.textContent).toContain("Not on this model");
	});

	it("offers Ultrafast only on a model that has it, and runs stock /fast ultra", async () => {
		await mount();
		await openRunSettings();
		expect(document.querySelector("[data-ultrafast-mode]")).toBeNull();
		await act(async () => useModelStore.setState({ ultrafastSupported: true }));
		const commandMock = window.omp.rpc.command as unknown as Mock;
		commandMock.mockImplementation(async (command: RpcCommand) =>
			command.type === "set_ultrafast_mode" ? ok({ enabled: true, active: true, ultrafast: true }) : ok(),
		);
		const ultra = document.querySelector(
			'[data-ultrafast-mode] [role="switch"], [role="switch"][data-ultrafast-mode]',
		) as unknown as TestElement | null;
		if (!ultra) throw new Error("ultrafast switch missing");
		await click(ultra);
		await flush();
		expect(commandMock.mock.calls.map(call => call[0])).toContainEqual({ type: "set_ultrafast_mode", enabled: true });
		expect(useModelStore.getState()).toMatchObject({ fastModeEnabled: true, ultrafastEnabled: true });
		expect(document.querySelector("[data-run-settings-trigger]")?.getAttribute("aria-label")).toContain(
			"Ultrafast on",
		);
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

describe("InputArea dictation", () => {
	let transcribeAudio: Mock;
	let mic: FakeMic;

	async function mountWithMic(): Promise<void> {
		mic = installFakeMic();
		await mount();
		transcribeAudio = vi.fn(async () => ok({ text: "hello there" }));
		Object.assign(window.omp.rpc, { transcribeAudio, getSettings: vi.fn(async () => ok({ values: {} })) });
		await act(async () => {
			useSessionStore.setState({ isStreaming: false });
			useSettingsStore.setState({ sttEnabled: true });
		});
	}

	/** A key on the window, where the dictation handler listens in the capture phase. */
	async function windowKey(key: string): Promise<void> {
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key, shiftKey: false, keyCode: key === "Enter" ? 13 : 27, isComposing: false });
		await act(async () => {
			window.dispatchEvent(event);
		});
		await flush();
	}

	function phase(): string | null {
		return document.querySelector("[data-dictation]")?.getAttribute("data-dictation") ?? null;
	}

	/** Click the mic; "Starting the microphone…" holds until the device opens. */
	async function startTake(): Promise<void> {
		const opened = Promise.withResolvers<FakeStream>();
		mic.getUserMedia.mockImplementationOnce(() => opened.promise);
		const button = document.querySelector(
			`button[aria-label="${translate("voice.mic.start")}"]`,
		) as unknown as TestElement | null;
		if (!button) throw new Error("mic button missing");
		await click(button);
		expect(phase()).toBe("starting");
		expect(document.querySelector("button[data-dictation-send]")).toBeNull();
		opened.resolve(new FakeStream());
		await flush();
		expect(phase()).toBe("recording");
	}

	afterEach(() => uninstallFakeMic());

	it("shows the meter while recording, and Enter ends the take into the draft at the caret", async () => {
		await mountWithMic();
		await typeInto(findTextarea(), "note:");
		await startTake();
		expect(document.querySelector('[data-dictation="recording"]')?.textContent).toContain(
			translate("voice.dictation.listening"),
		);
		expect(document.querySelectorAll("[data-dictation] span[style]")).toHaveLength(METER_BARS);
		// The send button becomes "Stop and send" while the mic is open.
		expect(document.querySelector("button[data-dictation-send]")).not.toBeNull();

		await windowKey("Enter");
		expect(transcribeAudio).toHaveBeenCalledTimes(1);
		expect(phase()).toBeNull();
		expect(useComposerStore.getState().draft).toBe("note: hello there ");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("discards the take on Esc and keeps the draft", async () => {
		await mountWithMic();
		await typeInto(findTextarea(), "keep me");
		await startTake();
		await windowKey("Escape");
		expect(phase()).toBeNull();
		expect(transcribeAudio).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("keep me");
	});

	it("discards the take on Esc without closing or driving the open completion menu", async () => {
		await mountWithMic();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () => deliver([{ name: "cmd0" }, { name: "cmd1" }], "t0"));
		Object.assign(findTextarea(), { selectionStart: 1, selectionEnd: 1 });
		await typeInto(findTextarea(), "/");
		await flush();
		const rows = document.querySelectorAll('[role="option"]').length;
		expect(rows).toBeGreaterThan(1);
		await startTake();
		await windowKey("Escape");
		expect(phase()).toBeNull();
		expect(transcribeAudio).not.toHaveBeenCalled();
		// The same Esc did not also dismiss the menu, and the draft is untouched.
		expect(document.querySelectorAll('[role="option"]').length).toBe(rows);
		expect(useComposerStore.getState().draft).toBe("/");
		// The next Esc is the menu's own.
		await pressKey({ key: "Escape" });
		expect(document.querySelector('[role="option"]')).toBeNull();
	});

	it("names the mic by what a click does, without also claiming a pressed state", async () => {
		await mountWithMic();
		await startTake();
		const stop = document.querySelector(`button[aria-label="${translate("voice.mic.stop")}"]`);
		expect(stop).not.toBeNull();
		expect(stop?.getAttribute("aria-pressed")).toBeNull();
	});

	it("sends the draft with the transcript from Stop and send", async () => {
		await mountWithMic();
		await startTake();
		const stopAndSend = document.querySelector("button[data-dictation-send]") as unknown as TestElement | null;
		if (!stopAndSend) throw new Error("Stop and send missing");
		expect(stopAndSend.getAttribute("aria-label")).toBe(translate("voice.dictation.stopAndSend"));
		await click(stopAndSend);
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("hello there");
	});
});

describe("InputArea caret placement", () => {
	// Every writer of the draft places its caret with the text. A caret placed on the
	// next frame moved whatever the keys before that frame did: composer-keys' double
	// Esc flaked when a late frame collapsed Playwright fill's select-all.
	function field(): { value: unknown; start: unknown; end: unknown } {
		const textarea: object = findTextarea();
		return {
			value: "value" in textarea ? textarea.value : undefined,
			start: "selectionStart" in textarea ? textarea.selectionStart : undefined,
			end: "selectionEnd" in textarea ? textarea.selectionEnd : undefined,
		};
	}

	function setCaret(start: number, end = start): void {
		Object.assign(findTextarea(), { selectionStart: start, selectionEnd: end });
	}

	/**
	 * Runs `write` while no frame comes (a busy renderer) and checks the text and caret it
	 * returns are in the field already; then selects all, as the next key may, and lets the
	 * held frames run: the selection must stay.
	 */
	async function expectCaretWithText(write: () => Promise<{ text: string; caret: number }>): Promise<void> {
		const frames: (() => void)[] = [];
		const realFrame = globals.requestAnimationFrame;
		globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
		let text = "";
		try {
			const placed = await write();
			text = placed.text;
			expect(field()).toEqual({ value: text, start: placed.caret, end: placed.caret });
			expect(useComposerStore.getState().draft).toBe(text);
			setCaret(0, text.length);
			await act(async () => {
				for (const frame of frames.splice(0)) frame();
			});
		} finally {
			globals.requestAnimationFrame = realFrame;
		}
		expect(field()).toEqual({ value: text, start: 0, end: text.length });
	}

	function reactProps<T>(element: unknown): T {
		const record = element as Record<string, unknown>;
		const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
		if (!key) throw new Error("react props not found");
		return record[key] as T;
	}

	it("inserts a completion with its caret", async () => {
		await mount();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () =>
			deliver([{ name: "skill:release-notes", description: "Write notes", source: "skill" }], "t0"),
		);
		setCaret(10);
		await typeInto(findTextarea(), "/skill:rel");
		await flush();
		expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
		await expectCaretWithText(async () => {
			expect((await pressKey({ key: "Tab" })).defaultPrevented).toBe(true);
			const text = useComposerStore.getState().draft;
			expect(text.startsWith("/skill:release-notes")).toBe(true);
			return { text, caret: text.length };
		});
	});

	it("folds a large paste into a marker at the caret, the caret after it", async () => {
		await mount();
		await typeInto(findTextarea(), "ab");
		setCaret(1);
		const { onPaste } = reactProps<{ onPaste: (event: object) => void }>(findTextarea());
		const content = "x".repeat(1200);
		await expectCaretWithText(async () => {
			await act(async () =>
				onPaste({ clipboardData: { files: [], getData: () => content }, preventDefault: () => {} }),
			);
			const text = useComposerStore.getState().draft;
			const marker = text.slice(1, -1);
			expect(text).toBe(`a${marker}b`);
			expect(expandPasteMarkers(marker)).toBe(content);
			return { text, caret: 1 + marker.length };
		});
	});

	it("puts a prompt picked in history search into the composer with its caret at the end", async () => {
		await mount();
		await act(async () =>
			useInputHistoryStore.setState({
				entries: [{ prompt: "picked prompt", ts: 100, cwd: "/tmp", transient: true }],
			}),
		);
		await typeInto(findTextarea(), "draft");
		expect((await pressKey({ key: "r", ctrlKey: true })).defaultPrevented).toBe(true);
		await flush();
		const option = document.querySelector('[role="option"]') as unknown as TestElement | null;
		if (!option) throw new Error("history search row missing");
		await expectCaretWithText(async () => {
			await click(option);
			return { text: "picked prompt", caret: "picked prompt".length };
		});
	});

	it("fills the composer with its caret after the text, ahead of the draft when prepending", async () => {
		await mount();
		await expectCaretWithText(async () => {
			await act(async () => {
				window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text: "starter prompt" } }));
			});
			return { text: "starter prompt", caret: "starter prompt".length };
		});
		await typeInto(findTextarea(), "my draft");
		await expectCaretWithText(async () => {
			await act(async () => {
				window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text: "queued", prepend: true } }));
			});
			return { text: "queued\n\nmy draft", caret: "queued".length };
		});
	});
});

describe("InputArea markdown list continuation", () => {
	function setCaret(start: number, end = start): void {
		const textarea = findTextarea() as unknown as { selectionStart: number; selectionEnd: number };
		textarea.selectionStart = start;
		textarea.selectionEnd = end;
	}

	function caret(): number {
		return (findTextarea() as unknown as { selectionStart: number }).selectionStart;
	}

	async function mountDraft(draft: string, at = draft.length): Promise<void> {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await typeInto(findTextarea(), draft);
		setCaret(at);
	}

	const shiftEnter = { key: "Enter", shiftKey: true };

	it("continues a bullet on Shift+Enter, caret after the new bullet", async () => {
		await mountDraft("- one");
		const result = await pressKey(shiftEnter);
		expect(result.defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("- one\n- ");
		expect(caret()).toBe("- one\n- ".length);
	});

	it("numbers ordered items and resets task boxes", async () => {
		await mountDraft("  1. a");
		await pressKey(shiftEnter);
		expect(useComposerStore.getState().draft).toBe("  1. a\n  2. ");
		await typeInto(findTextarea(), "- [x] done");
		setCaret("- [x] done".length);
		await pressKey(shiftEnter);
		expect(useComposerStore.getState().draft).toBe("- [x] done\n- [ ] ");
	});

	it("ends the list on an empty item", async () => {
		await mountDraft("- a\n- ");
		const result = await pressKey(shiftEnter);
		expect(result.defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("- a\n");
		expect(caret()).toBe(4);
	});

	it("splits a line at the caret and gives the remainder the bullet", async () => {
		await mountDraft("- abcd", 4);
		await pressKey(shiftEnter);
		expect(useComposerStore.getState().draft).toBe("- ab\n- cd");
		expect(caret()).toBe("- ab\n- ".length);
	});

	it("leaves plain lines, fenced code and a caret in the bullet to the native newline", async () => {
		await mountDraft("plain");
		expect((await pressKey(shiftEnter)).defaultPrevented).toBe(false);
		await typeInto(findTextarea(), "```\n- a");
		setCaret("```\n- a".length);
		expect((await pressKey(shiftEnter)).defaultPrevented).toBe(false);
		await typeInto(findTextarea(), "- a");
		setCaret(1);
		expect((await pressKey(shiftEnter)).defaultPrevented).toBe(false);
		expect(useComposerStore.getState().draft).toBe("- a");
	});

	it("does nothing during IME composition", async () => {
		await mountDraft("- 한");
		const result = await pressKey({ ...shiftEnter, nativeEvent: { isComposing: true } });
		expect(result.defaultPrevented).toBe(false);
		expect(useComposerStore.getState().draft).toBe("- 한");
	});

	it("does not touch a plain Enter (it sends) or ⌘/⌃ chords", async () => {
		await mountDraft("- one");
		expect(useComposerStore.getState().draft).toBe("- one");
		await pressKey({ key: "Enter", shiftKey: true, metaKey: true });
		expect(useComposerStore.getState().draft).toBe("- one");
	});

	it("inserts through execCommand so native undo restores the plain newline", async () => {
		await mountDraft("- one");
		const doc = document as unknown as { execCommand?: unknown };
		const calls: unknown[][] = [];
		doc.execCommand = (...args: unknown[]) => {
			calls.push(args);
			const el = findTextarea() as unknown as { value: string; selectionStart: number; selectionEnd: number };
			el.value = el.value.slice(0, el.selectionStart) + String(args[2]) + el.value.slice(el.selectionEnd);
			return true;
		};
		try {
			await pressKey(shiftEnter);
		} finally {
			delete doc.execCommand;
		}
		expect(calls).toEqual([["insertText", false, "\n- "]]);
	});

	it("continues the list for plain Enter while the composer is expanded", async () => {
		await mountDraft("1) a");
		await pressKey({ key: "g", ctrlKey: true });
		setCaret("1) a".length);
		await pressKey({ key: "Enter" });
		expect(useComposerStore.getState().draft).toBe("1) a\n2) ");
	});
});
