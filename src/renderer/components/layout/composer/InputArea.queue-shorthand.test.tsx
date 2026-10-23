/**
 * InputArea interaction contracts: queue shorthand routing, prompt history,
 * the in-place expanded composer (⌃G), and the toolbar's Run settings / mode
 * popovers dispatching their choices.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import { resetSessionSurface } from "../../../hooks/use-session-switch";
import { filePickInProgress } from "../../../lib/file-pick";
import { clearHistoryImages, rememberHistoryImages } from "../../../lib/history-images";
import { I18nProvider, translate } from "../../../lib/i18n";
import { expandPasteMarkers, pasteMarkerText, storePaste } from "../../../lib/paste-blobs";
import { METER_BARS, recordAndTranscribe, stopVoiceRecording } from "../../../lib/voice";
import { useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useFirstRunStore } from "../../../stores/first-run";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useQueueStore } from "../../../stores/queue";
import { useSessionStore } from "../../../stores/session";
import {
	SessionRuntimeProvider,
	sessionRuntime,
	setFocusedSessionRuntime,
	withSessionRuntime,
} from "../../../stores/session-runtime-context";
import { useSettingsStore } from "../../../stores/settings";
import { createTabRuntime, replaceTabRuntime } from "../../../stores/tab-runtime";
import { pushTabExtensionUiRequest, useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { type FakeMic, FakeStream, installFakeMic, uninstallFakeMic } from "../../../test-support/dictation";
import { InputArea } from "./InputArea";
import { clearMentionFiles } from "./input-area-utils";

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
	it("sends an Enter pressed while the previous send is still answering as soon as it is, never dropping it", async () => {
		await mount(true);
		const pending = Promise.withResolvers<RpcResponse>();
		prompt.mockReturnValueOnce(pending.promise);
		await typeInto(findTextarea(), "first");
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
		await typeInto(findTextarea(), "second");
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(useComposerStore.getState().draft).toBe("second");
		pending.resolve({ type: "response", command: "prompt", success: true });
		await flush();
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(prompt.mock.calls[1]?.[0]).toBe("second");
		expect(useComposerStore.getState().draft).toBe("");
	});

	it("drops a pressed Enter when the previous send failed and put its text back, or when the draft changed", async () => {
		await mount(true);
		const failing = Promise.withResolvers<RpcResponse>();
		prompt.mockReturnValueOnce(failing.promise);
		await typeInto(findTextarea(), "first");
		await pressEnter(findTextarea());
		await flush();
		await typeInto(findTextarea(), "second");
		await pressEnter(findTextarea());
		await flush();
		failing.resolve({ type: "response", command: "prompt", success: false, error: "offline" });
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(useComposerStore.getState().draft).toBe("first\n\nsecond");

		const slow = Promise.withResolvers<RpcResponse>();
		prompt.mockReturnValueOnce(slow.promise);
		await act(async () => useComposerStore.getState().setDraft("third"));
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledTimes(2);
		await typeInto(findTextarea(), "fourth");
		await pressEnter(findTextarea());
		await typeInto(findTextarea(), "fifth");
		slow.resolve({ type: "response", command: "prompt", success: true });
		await flush();
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(useComposerStore.getState().draft).toBe("fifth");
	});

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
		// Joined like every restore (prependToDraft): a blank line between.
		expect(useComposerStore.getState().draft).toBe("preserve in-flight input\n\nnext draft");
		expect(useComposerStore.getState().submissionUncertain).toBe(true);
		expect(useComposerStore.getState().sending).toBe(false);
		await pressEnter(findTextarea());
		await flush();
		expect(prompt).toHaveBeenCalledTimes(1);
		// The warning says why, Send is held, and only the user's "allow sending" releases it.
		expect(document.body.textContent).toContain(translate("input.deliveryUnknown"));
		const send = () =>
			document.querySelector(`button[aria-label="${translate("input.send")}"]`) as unknown as TestElement | null;
		expect(send()?.getAttribute("disabled")).not.toBeNull();
		const allow = buttonWithText(translate("input.allowResend"));
		if (!allow) throw new Error("no allow-resend button");
		await click(allow);
		expect(useComposerStore.getState().submissionUncertain).toBe(false);
		expect(document.body.textContent).not.toContain(translate("input.deliveryUnknown"));
		expect(send()?.getAttribute("disabled")).toBeNull();
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

	it("starts every run as Steer: a Follow-up picked on the chip lasts for that run only", async () => {
		await mount();
		const chip = () => document.querySelector("[data-send-mode]") as unknown as TestElement | null;
		expect(chip()?.getAttribute("data-send-mode")).toBe("steer");
		await click(chip() as TestElement);
		expect(chip()?.getAttribute("data-send-mode")).toBe("followUp");
		await typeInto(findTextarea(), "after this run");
		await pressEnter(findTextarea());
		await flush();
		expect(followUp).toHaveBeenCalledWith("after this run", []);

		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(chip()?.getAttribute("data-send-mode")).toBe("steer");
		await typeInto(findTextarea(), "next run steer");
		await pressEnter(findTextarea());
		await flush();
		expect(steer).toHaveBeenCalledWith("next run steer", []);
	});

	it("offers Stop while the automatic mode choice holds a prompt back, and Stop withdraws it into the draft", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		const decision = Promise.withResolvers<RpcResponse>();
		const autoModeDecide = vi.fn(() => decision.promise);
		const autoModeEnd = vi.fn(async () => ok({}));
		Reflect.set(window.omp.rpc, "autoModeDecide", autoModeDecide);
		Reflect.set(window.omp.rpc, "autoModeEnd", autoModeEnd);
		// The action button turns Stop while a prompt is held back with nothing typed.
		const stop = () =>
			document.querySelector(
				`[data-slot="send"] button[aria-label="${translate("input.abort")}"]`,
			) as unknown as TestElement | null;
		const request = "refactor the whole settings module across all files";
		await typeInto(findTextarea(), request);
		await pressEnter(findTextarea());
		await flush();
		await flush();
		expect(autoModeDecide).toHaveBeenCalledOnce();
		expect(useComposerStore.getState().draft).toBe("");
		expect(stop()).not.toBeNull();
		// Esc is the app-wide stop now, not the draft's double Esc.
		expect((await pressKey({ key: "Escape" })).defaultPrevented).toBe(false);

		await click(stop() as TestElement);
		decision.resolve(ok({ mode: "plan", latencyMs: 900 }));
		await flush();
		await flush();
		expect(prompt).not.toHaveBeenCalled();
		expect(autoModeEnd).toHaveBeenCalledWith("plan");
		expect(useComposerStore.getState().draft).toBe(request);
		expect(useComposerStore.getState().sending).toBe(false);
		expect(stop()).toBeNull();
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("does not dispatch a deferred prompt through a tab selected after Enter", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await typeInto(findTextarea(), "stay in t0");
		vi.useFakeTimers();
		try {
			await pressEnter(findTextarea());
			await act(async () => useTabsStore.setState({ activeTabId: "t1" }));
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

		await act(async () => useTabsStore.setState({ activeTabId: "t1" }));
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

	it("records a folded paste as its text, so ↑ sends the paste again and never the bare marker", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		const blob = storePaste(Array.from({ length: 12 }, (_, line) => `row ${line}`).join("\n"));
		await typeInto(findTextarea(), `look: ${pasteMarkerText(blob.id, blob.content)}`);
		await pressEnter(findTextarea());
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledWith(`look: ${blob.content}`, []);
		expect(useInputHistoryStore.getState().entries.map(entry => entry.prompt)).toEqual([`look: ${blob.content}`]);
	});

	it("reads `!`, `$` and `->` only from the draft as shown: a folded paste that starts with one is a prompt", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		const bash = vi.fn(async () => ok({ output: "", exitCode: 0 }));
		const evaluate = vi.fn(async () => ok({}));
		Reflect.set(window.omp.rpc, "bash", bash);
		Reflect.set(window.omp.rpc, "eval", evaluate);
		for (const head of ["!rm -rf build", "$ import os", "-> later"]) {
			const blob = storePaste([head, ...Array.from({ length: 11 }, (_, line) => `row ${line}`)].join("\n"));
			const marker = pasteMarkerText(blob.id, blob.content);
			await typeInto(findTextarea(), marker);
			expect(document.querySelector("[data-composer-mode]")?.getAttribute("data-composer-mode") ?? null).toBeNull();
			await pressEnter(findTextarea());
			await flush();
			await flush();
			expect(prompt).toHaveBeenLastCalledWith(blob.content, []);
		}
		expect(bash).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("runs a typed `!` command with a folded paste in its body expanded", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		const bash = vi.fn(async () => ok({ output: "", exitCode: 0 }));
		Reflect.set(window.omp.rpc, "bash", bash);
		const blob = storePaste(Array.from({ length: 12 }, (_, line) => `line ${line}`).join("\n"));
		await typeInto(findTextarea(), `!cat <<'EOF'\n${pasteMarkerText(blob.id, blob.content)}\nEOF`);
		await pressEnter(findTextarea());
		await flush();

		expect(bash).toHaveBeenCalledWith(`cat <<'EOF'\n${blob.content}\nEOF`, false);
		expect(prompt).not.toHaveBeenCalled();
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

	it("turns the one action button into Stop while a turn streams with nothing typed, and back into Send on typing", async () => {
		await mount();
		const button = () => document.querySelector('[data-slot="send"] button') as unknown as HTMLButtonElement | null;
		const node = button();
		expect(node?.getAttribute("aria-label")).toBe("Stop");
		expect(node?.disabled).toBe(false);
		expect(document.querySelectorAll('[data-slot="send"] button').length).toBe(1);
		await typeInto(findTextarea(), "steer this");
		// Same node: nothing came or went, so nothing moved.
		expect(button()).toBe(node);
		expect(node?.getAttribute("aria-label")).toBe("Send");
		expect(node?.disabled).toBe(false);
		expect(node?.querySelector("[data-send-stop-hint]")).not.toBeNull();
		expect(document.querySelector('button[aria-label="Stop"]')).toBeNull();
	});
});

describe("InputArea expanded composer", () => {
	// ⌃G grows the same field in place: no second editor, no modal over the session. The + menu no longer offers it.
	it("expands in place from ⌃G, and Esc collapses without aborting", async () => {
		await mount();
		expect(isExpanded()).toBe(false);

		await pressKey({ key: "g", ctrlKey: true });
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
		expect(chip?.textContent).toBe(`Paste #${blob.id} · 7 chars`);
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

	/** A drop on the composer box: the session pane (here the composer's region) listens for it natively. */
	function dropFiles(files: File[], items?: unknown[]): void {
		const box = document.querySelector(".omp-composer-box");
		const event = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(event, { dataTransfer: { types: ["Files"], files, items } });
		box?.dispatchEvent(event);
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
		const files = [
			new File([new Uint8Array([37, 80, 68, 70, 0])], "spec.pdf", { type: "application/pdf" }),
			new File([new Uint8Array([80, 75, 3, 4])], "deck.pptx"),
			new File([], "src"),
		];
		// A folder reaches the page as a zero-byte file; the drop's own entries say it is one.
		const entries = files.map((_, index) => ({ webkitGetAsEntry: () => ({ isDirectory: index === 2 }) }));
		await act(async () => dropFiles(files, entries));
		await flush();
		expect(useComposerStore.getState().draft).toBe('@docs/spec.pdf @"/Users/me/My Deck.pptx" @src ');
	});

	it("attaches a dropped picture stock cannot convert for the model as a file, with no warning", async () => {
		await mountWithPaths({ "IMG_0001.HEIC": "/Users/me/Pictures/IMG_0001.HEIC" });
		(window.omp.fs as unknown as Record<string, unknown>).imageToModel = async () => {
			throw new Error("This picture could not be read");
		};
		const heic = new File([new Uint8Array([0, 0, 0, 24, 102, 116])], "IMG_0001.HEIC", { type: "image/heic" });
		await act(async () => dropFiles([heic], [{ webkitGetAsEntry: () => ({ isDirectory: false }) }]));
		await flush();
		expect(useComposerStore.getState().draft).toBe("@/Users/me/Pictures/IMG_0001.HEIC ");
		expect(useComposerStore.getState().images).toEqual([]);
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("pastes a clipboard file without a path as its text and saves a pathless binary on this computer", async () => {
		await mountWithPaths({});
		const saved: string[] = [];
		(window.omp.fs as unknown as Record<string, unknown>).uploadToHost = async (_tabId: string, file: File) => {
			saved.push(file.name);
			return { ok: true, path: `/up/this-computer/1/${file.name}` };
		};
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
		expect(saved).toEqual(["blob.bin"]);
		expect(draft).toMatch(/^@\/up\/this-computer\/1\/blob\.bin \[Paste #\d+, \d+ chars\] $/);
		expect(expandPasteMarkers(draft)).toBe(
			`@/up/this-computer/1/blob.bin <attachment name="notes.txt">\nline one\nline two\n</attachment> `,
		);
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("offers every file type in the + menu picker", async () => {
		await mount();
		const input = document.querySelector('input[type="file"]');
		expect(input?.getAttribute("accept")).toBeNull();
	});

	it("shows a chip while a file goes to the computer (a web page's upload), then mentions it where it landed", async () => {
		await mount();
		const upload = Promise.withResolvers<string>();
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = () => upload.promise;
		const pdf = new File([new Uint8Array([37, 80, 68, 70])], "report.pdf", { type: "application/pdf" });
		await act(async () => dropFiles([pdf]));
		await flush();
		const chips = () => Array.from(document.querySelectorAll("[data-upload-chip]")).map(chip => chip.textContent);
		expect(chips()).toEqual([translate("input.files.sending", { name: "report.pdf" })]);
		await act(async () => upload.resolve("/up/dev/1/report.pdf"));
		await flush();
		expect(chips()).toEqual([]);
		expect(useComposerStore.getState().draft).toBe("@/up/dev/1/report.pdf ");
	});

	it("says why a file was not sent, once, and inserts nothing for it", async () => {
		await mount();
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = () =>
			Promise.reject(new Error("Couldn't send report.pdf to your computer."));
		const pdf = new File([new Uint8Array([37, 80, 68, 70])], "report.pdf", { type: "application/pdf" });
		await act(async () => dropFiles([pdf]));
		await flush();
		expect(useToastStore.getState().toasts.map(item => [item.variant, item.message])).toEqual([
			["error", "Couldn't send report.pdf to your computer."],
		]);
		expect(document.querySelectorAll("[data-upload-chip]")).toHaveLength(0);
		expect(useComposerStore.getState().draft).toBe("");
	});

	it("holds a pick from the + menu until its files have landed in the composer", async () => {
		await mount();
		const upload = Promise.withResolvers<string>();
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = () => upload.promise;
		const input = document.querySelector('input[type="file"]') as unknown as TestElement & { click(): void };
		input.click = () => {};
		await openAddMenuItem(translate("input.attach"));
		expect(filePickInProgress()).toBe(true);
		const { onChange } = reactProps<{ onChange: (event: object) => void }>(input);
		const pdf = new File([new Uint8Array([37, 80, 68, 70])], "report.pdf", { type: "application/pdf" });
		await act(async () => onChange({ target: Object.assign(input, { files: [pdf], value: "" }) }));
		await flush();
		// The page came back from the picker and the file is still on its way: a reload now would drop it.
		expect(filePickInProgress()).toBe(true);
		await act(async () => upload.resolve("/up/dev/1/report.pdf"));
		await flush();
		expect(filePickInProgress()).toBe(false);
		expect(useComposerStore.getState().draft).toBe("@/up/dev/1/report.pdf ");
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
		expect(useUiStore.getState().viewSheet?.view).toBe("tree");
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

	it("keeps the + menu to compact actions and opens skills in a picker", async () => {
		await mountIdle();
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		const longDescription = `Review a change.\n\n${"Use it when the user asks for a careful review. ".repeat(12)}`;
		await act(async () =>
			deliver(
				[
					{ name: "compact", description: "Compact" },
					{ name: "skill:review", description: longDescription, source: "skill" },
				],
				"t0",
			),
		);
		await typeInto(findTextarea(), "fix this");
		setCaret(8);
		const add = document.querySelector('button[aria-label="Attach and more"]') as unknown as TestElement | null;
		if (!add) throw new Error("+ menu trigger missing");
		await click(add);
		const labels = Array.from(document.querySelectorAll("[data-menu-item]")).map(item => item.textContent ?? "");
		expect(labels).toHaveLength(4);
		expect(labels.some(label => label.includes("Expand composer") || label.includes("Set a goal"))).toBe(false);
		// Dictation is off here: the menu still lists it, and says where to turn it on.
		expect(labels.some(label => label.includes(translate("voice.menu.off")))).toBe(true);
		expect(labels.some(label => label.includes("Review a change"))).toBe(false);
		expect(labels.at(-1)).toBe(translate("input.addMenu.skills"));
		const skillsItem = Array.from(document.querySelectorAll("[data-menu-item]")).at(-1) as unknown as TestElement;
		await click(skillsItem);
		await flush();
		const row = document.querySelector("[data-skill-row]") as unknown as TestElement | null;
		if (!row) throw new Error("skill row missing");
		expect(row.textContent?.startsWith("review")).toBe(true);
		await click(row);
		expect(useComposerStore.getState().draft).toBe("fix this /skill:review ");
		expect(document.querySelector("[data-skill-picker]")).toBeNull();

		await openAddMenuItem("Use a skill");
		const manage = document.querySelector("[data-skill-manage]") as unknown as TestElement | null;
		if (!manage) throw new Error("manage button missing");
		await click(manage);
		expect(useUiStore.getState()).toMatchObject({ destination: "settings", settingsTab: "tools:skills" });
	});
});

describe("InputArea run settings and modes", () => {
	async function openRunSettings(): Promise<void> {
		const trigger = document.querySelector("button[data-run-settings-trigger]") as unknown as TestElement | null;
		if (!trigger) throw new Error("run settings trigger missing");
		await click(trigger);
	}

	/** Tap one segment of a Run sheet row (`data-<row>-option`). */
	async function choose(row: "thinking" | "approval", value: string): Promise<void> {
		const option = document.querySelector(`[data-${row}-option="${value}"]`) as unknown as TestElement | null;
		if (!option) throw new Error(`${row} option ${value} missing`);
		await click(option);
	}

	/** The chip's words: the provider mark's fallback letter is decoration. */
	function modelChipText(chip: TestElement | null): string | undefined {
		const element = chip as unknown as Element | null;
		const mark = element?.querySelector("[data-provider-mark]")?.textContent ?? "";
		return element?.textContent?.replace(mark, "");
	}

	it("keeps one calm toolbar at every width: the model and its effort, the Run chip", async () => {
		useModelStore.setState({ model: { provider: "acme", id: "acme-opus-5", name: "Acme Opus 5" } });
		for (const width of [1200, 600, 380]) {
			setWindowWidth(width);
			await mount();
			const model = document.querySelector("button[data-model-chip]") as unknown as TestElement | null;
			// The chip shows the display name and the effort (`Model · Thinking`); the id stays in its tooltip.
			expect(modelChipText(model)).toBe(`Acme Opus 5· ${translate("input.thinking.name.high")}`);
			expect(model?.getAttribute("aria-label" as never)).toContain(translate("input.thinking.name.high"));
			expect(document.querySelectorAll("button[data-composer-modes-trigger]").length).toBe(0);
			const runSettings = document.querySelector("button[data-run-settings-trigger]");
			expect(runSettings?.textContent).toContain(translate("input.runSettings.title"));
			expect(runSettings?.getAttribute("aria-label" as never)).toContain(translate("input.thinking.name.high"));
			await act(async () => root.unmount());
			container.remove();
		}
		await mount();
	});

	it("shows Auto alone on the model chip; the effort Auto picked stays in its name, a fixed level shows itself", async () => {
		useModelStore.setState({ model: { provider: "acme", id: "acme-opus-5", name: "Acme Opus 5" } });
		await mount();
		const chip = () => document.querySelector("button[data-model-chip]") as unknown as TestElement | null;
		const effort = () => document.querySelector("button[data-model-chip] .omp-composer-effort")?.textContent;
		await act(async () => useModelStore.setState({ thinkingConfigured: "auto" }));
		expect(effort()).toBe(`· ${translate("input.thinking.name.auto")}`);
		await act(async () => useModelStore.setState({ thinkingAutoResolved: "xhigh" }));
		expect(effort()).toBe(`· ${translate("input.thinking.name.auto")}`);
		const resolved = translate("input.thinking.autoResolved", { level: translate("input.thinking.name.xhigh") });
		expect(chip()?.getAttribute("aria-label" as never)).toContain(resolved);
		await act(async () => useModelStore.setState({ thinkingConfigured: "high" }));
		expect(effort()).toBe(`· ${translate("input.thinking.name.high")}`);
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
		await choose("thinking", "max");
		await flush();

		expect(setThinkingLevel).toHaveBeenCalledWith("max");
		expect(useModelStore.getState().thinkingConfigured).toBe("max");
	});

	it("persists a stricter tool approval picked inside the popover", async () => {
		await mount();
		await openRunSettings();
		await choose("approval", "always-ask");

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
		expect(document.querySelector("button[data-run-settings-trigger]")).not.toBeNull();
		await openRunSettings();
		await choose("approval", "always-ask");
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

	it("toggles plan mode from the Run chip's Mode section", async () => {
		await mount();
		const modes = document.querySelector("button[data-run-settings-trigger]") as unknown as TestElement | null;
		if (!modes) throw new Error("Run chip missing");
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

	it("shows the bar between the field and the toolbar, never over the draft", async () => {
		await mountWithMic();
		await typeInto(findTextarea(), "my draft");
		await startTake();
		const bar = document.querySelector("[data-dictation]") as unknown as TestElement;
		expect(bar.getAttribute("class") ?? "").not.toContain("absolute");
		const field = findTextarea();
		const toolbar = document.querySelector(".omp-composer-toolbar") as unknown as TestElement;
		const order = Array.from(document.querySelectorAll("*")) as unknown[];
		expect(order.indexOf(field)).toBeLessThan(order.indexOf(bar));
		expect(order.indexOf(bar)).toBeLessThan(order.indexOf(toolbar));
		expect((field as unknown as { value: string }).value).toBe("my draft");
		expect(bar.textContent).toContain("Enter");
	});

	it("Esc discards the take and stops there: the app-wide Esc that aborts a running turn never sees it", async () => {
		await mountWithMic();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await startTake();
		const appWide = vi.fn();
		window.addEventListener("keydown", appWide);
		try {
			await windowKey("Escape");
		} finally {
			window.removeEventListener("keydown", appWide);
		}
		expect(phase()).toBeNull();
		expect(appWide).not.toHaveBeenCalled();
		expect(document.querySelector("[data-dictation-failure]")).toBeNull();
	});

	function failure(): TestElement | null {
		return document.querySelector("[data-dictation-failure]") as unknown as TestElement | null;
	}

	async function failOpening(name: string, message: string): Promise<void> {
		mic.getUserMedia.mockImplementationOnce(async () => {
			throw Object.assign(new Error(message), { name });
		});
		const button = document.querySelector(
			`button[aria-label="${translate("voice.mic.start")}"]`,
		) as unknown as TestElement | null;
		if (!button) throw new Error("mic button missing");
		await click(button);
		await flush();
	}

	it("says what to do about a blocked microphone and keeps the browser's wording behind Details", async () => {
		await mountWithMic();
		await failOpening("NotAllowedError", "Permission denied by system");
		expect(failure()?.getAttribute("data-dictation-failure")).toBe("denied");
		expect(failure()?.textContent).toContain(translate("voice.fail.denied"));
		// Text only: the OS privacy page is not openable from here.
		expect(failure()?.textContent).not.toContain(translate("voice.fail.openSettings"));
		expect(document.querySelector("[data-error-detail]")).toBeNull();
		const details = [...document.querySelectorAll("[data-dictation-failure] button")].find(
			button => button.textContent === translate("voice.fail.details"),
		) as unknown as TestElement;
		await click(details);
		expect(document.querySelector("[data-error-detail]")?.textContent).toBe("Permission denied by system");
	});

	it("tells a missing microphone from a busy one", async () => {
		await mountWithMic();
		await failOpening("NotFoundError", "Requested device not found");
		expect(failure()?.textContent).toContain(translate("voice.fail.noDevice"));
		await failOpening("NotReadableError", "Could not start audio source");
		expect(failure()?.getAttribute("data-dictation-failure")).toBe("in-use");
		expect(failure()?.textContent).toContain(translate("voice.fail.inUse"));
	});

	it("sends an unset dictation model to Settings > Models, with the raw error only behind Details", async () => {
		await mountWithMic();
		transcribeAudio.mockImplementation(async () => ({ success: false, error: "No dictation model configured" }));
		await startTake();
		await windowKey("Enter");
		expect(failure()?.getAttribute("data-dictation-failure")).toBe("no-model");
		expect(failure()?.textContent).toContain(translate("voice.fail.noModel"));
		expect(failure()?.textContent).not.toContain("No dictation model configured");
		const open = [...document.querySelectorAll("[data-dictation-failure] button")].find(
			button => button.textContent === translate("voice.fail.openSettings"),
		) as unknown as TestElement;
		await click(open);
		expect(useUiStore.getState().destination).toBe("settings");
		expect(useUiStore.getState().settingsTab).toBe("models:roles");
		expect(failure()).toBeNull();
	});

	it("a failed transcription is a plain sentence plus Details, and the next take clears it", async () => {
		await mountWithMic();
		transcribeAudio.mockImplementationOnce(async () => ({ success: false, error: "stt unavailable" }));
		await startTake();
		await windowKey("Enter");
		expect(failure()?.textContent).toContain(translate("voice.fail.failed"));
		expect(failure()?.textContent).not.toContain("stt unavailable");
		await startTake();
		expect(failure()).toBeNull();
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
		expect(calls).toEqual([
			["insertText", false, "\n"],
			["insertText", false, "- "],
		]);
	});

	it("continues the list for plain Enter while the composer is expanded", async () => {
		await mountDraft("1) a");
		await pressKey({ key: "g", ctrlKey: true });
		setCaret("1) a".length);
		await pressKey({ key: "Enter" });
		expect(useComposerStore.getState().draft).toBe("1) a\n2) ");
	});
});

/** Composer audit, Oct 2026 (local composer-audit.md): M2–M8 and the Low items the component owns. */
describe("InputArea composer audit", () => {
	afterEach(() => clearMentionFiles());

	function setCaret(start: number, end = start): void {
		Object.assign(findTextarea(), { selectionStart: start, selectionEnd: end });
	}
	function draft(): string {
		return useComposerStore.getState().draft;
	}
	function options(): string[] {
		return Array.from(document.querySelectorAll('[role="option"]')).map(option => option.textContent ?? "");
	}
	async function deliverCommands(commands: unknown[]): Promise<void> {
		const subscribe = window.omp.events.onTabCommandsUpdate as unknown as Mock;
		const deliver = subscribe.mock.calls.at(-1)?.[0] as (commands: unknown[], tabId: string) => void;
		await act(async () => deliver(commands, "t0"));
	}
	/** Type `value` with the caret at its end, then let the menu derive. */
	async function typeDraft(value: string): Promise<void> {
		setCaret(value.length);
		await typeInto(findTextarea(), value);
		await flush();
	}
	function reactProps<T>(element: unknown): T {
		const record = element as Record<string, unknown>;
		const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
		if (!key) throw new Error("react props not found");
		return record[key] as T;
	}
	const image = (data: string) => ({
		content: { type: "image" as const, data, mimeType: "image/png" },
		preview: data,
	});

	it("M2: a slash after prompt text offers skills only, as stock's mid-prompt lookup does", async () => {
		await mount();
		await deliverCommands([{ name: "retry" }, { name: "skill:review", source: "skill" }]);
		await typeDraft("hello /ret");
		expect(options()).toEqual([]);
		await typeDraft("hello /re");
		expect(options()).toEqual(["/skill:review"]);
		await typeDraft("/re");
		expect(options()).toContain("/retry");
	});

	it("M2: Shift+Enter and ⌘↵ keep their meaning while the menu is open", async () => {
		await mount();
		await deliverCommands([{ name: "skill:review", source: "skill" }]);
		await typeDraft("check /rev");
		expect(options()).toHaveLength(1);
		// Shift+Enter: the field's own newline, never the completion.
		expect((await pressKey({ key: "Enter", shiftKey: true })).defaultPrevented).toBe(false);
		expect(draft()).toBe("check /rev");
		// ⌘↵ sends what is typed (a steer while the turn runs).
		await pressKey({ key: "Enter", metaKey: true });
		await flush();
		expect(steer).toHaveBeenCalledWith("check /rev", []);
	});

	it("L1: a menu closed with Esc or ← stays closed while the caret moves in its token, until an edit", async () => {
		await mount();
		await deliverCommands([{ name: "retry" }, { name: "review" }]);
		await typeDraft("/re");
		expect(options().length).toBeGreaterThan(0);
		const caretMoved = async (at: number) => {
			setCaret(at);
			await act(async () => {
				findTextarea().dispatchEvent(new Event("keyup"));
			});
			await flush();
		};
		await pressKey({ key: "Escape" });
		expect(options()).toEqual([]);
		await caretMoved(2);
		await caretMoved(3);
		expect(options()).toEqual([]);
		await pressKey({ key: "ArrowLeft" });
		await caretMoved(3);
		expect(options()).toEqual([]);
		// Typing opens it again.
		await typeDraft("/ret");
		expect(options()).toContain("/retry");
		// ← that stays inside the token keeps the menu open (DI-20): only an arrow that steps out closes it.
		await pressKey({ key: "ArrowLeft" });
		await caretMoved(3);
		expect(options()).toContain("/retry");
	});

	it("M3: Backspace from `->` + newline leaves `->`; only typing adds the newline", async () => {
		await mount();
		await typeDraft("-");
		await typeDraft("->");
		expect(draft()).toBe("->\n");
		await typeDraft("->");
		expect(draft()).toBe("->");
		await typeDraft("-");
		expect(draft()).toBe("-");
	});

	it("M4: the @ menu reads Hangul, and a picked path with a space goes in quoted", async () => {
		await mount();
		const list = vi.fn(async () => ({
			ok: true,
			entries: ["문서.md", "My Report.md", "src/a.ts"].map(path => ({ kind: "file", path, name: path })),
		}));
		Reflect.set(window.omp.fs, "list", list);
		await typeDraft("see @문");
		// The listing waits out the mention debounce.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 200);
			await promise;
		});
		await flush();
		expect(options()[0]).toBe("문서.md");
		await typeDraft('see @"My Re');
		expect(options()[0]).toBe("My Report.md");
		await pressKey({ key: "Enter" });
		expect(draft()).toBe('see @"My Report.md" ');
	});

	it("M5: removing a picture puts typing back in the field", async () => {
		await mount();
		await act(async () => useComposerStore.getState().setImages([image("AA==")]));
		const focus = vi.fn();
		Reflect.set(findTextarea(), "focus", focus);
		const remove = document.querySelector(
			`button[aria-label="${translate("input.removeAttachment", { index: 1 })}"]`,
		) as unknown as TestElement | null;
		if (!remove) throw new Error("remove button missing");
		await click(remove);
		expect(useComposerStore.getState().images).toEqual([]);
		expect(focus).toHaveBeenCalled();
	});

	it("M6: a clipboard holding a file and text keeps the text", async () => {
		await mount();
		const { onPaste } = reactProps<{ onPaste: (event: object) => void }>(findTextarea());
		// A file with a path becomes a mention (a picture would attach; both skip the text the same way).
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = () => "/tmp/report.pdf";
		const file = new File([new Uint8Array([37, 80, 68, 70])], "report.pdf", { type: "application/pdf" });
		await act(async () =>
			onPaste({
				clipboardData: { files: [file], getData: (type: string) => (type === "text/plain" ? "caption text" : "") },
				preventDefault: () => {},
			}),
		);
		await flush();
		expect(draft()).toBe("caption text @report.pdf ");
		// A file manager's copy names the files as text: that is the file, not a caption.
		await typeInto(findTextarea(), "");
		setCaret(0);
		await act(async () =>
			onPaste({
				clipboardData: {
					files: [file],
					getData: (type: string) => (type === "text/plain" ? "/tmp/report.pdf" : ""),
				},
				preventDefault: () => {},
			}),
		);
		await flush();
		expect(draft()).toBe("@report.pdf ");
	});

	it("M7: a ⌃R pick stashes the draft and its pictures like ↑, so ↓ brings them back", async () => {
		await mount();
		await act(async () =>
			useInputHistoryStore.setState({
				entries: [{ prompt: "older prompt", ts: 100, cwd: "/tmp", transient: true }],
			}),
		);
		await typeDraft("precious draft");
		await act(async () => useComposerStore.getState().setImages([image("AQ==")]));
		await pressKey({ key: "r", code: "KeyR", ctrlKey: true });
		await flush();
		const row = Array.from(document.querySelectorAll('[role="option"]')).find(option =>
			option.textContent?.includes("older prompt"),
		) as unknown as TestElement | undefined;
		if (!row) throw new Error("history row missing");
		await click(row);
		expect(draft()).toBe("older prompt");
		expect(useComposerStore.getState().images).toEqual([]);
		setCaret("older prompt".length);
		expect((await pressKey({ key: "ArrowDown" })).defaultPrevented).toBe(true);
		expect(draft()).toBe("precious draft");
		expect(useComposerStore.getState().images.map(item => item.content.data)).toEqual(["AQ=="]);
	});

	it("M8: a completion goes in as one native edit of the changed span, so undo restores the typed text", async () => {
		await mount();
		await deliverCommands([{ name: "retry" }]);
		await typeDraft("/re");
		const field = findTextarea() as unknown as { value: string; selectionStart: number; selectionEnd: number };
		const doc = document as unknown as { execCommand?: unknown };
		const calls: unknown[][] = [];
		doc.execCommand = (...args: unknown[]) => {
			calls.push([...args, field.selectionStart, field.selectionEnd]);
			field.value =
				field.value.slice(0, field.selectionStart) + String(args[2]) + field.value.slice(field.selectionEnd);
			return true;
		};
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => findTextarea() });
		try {
			await pressKey({ key: "Tab" });
		} finally {
			delete doc.execCommand;
			Reflect.deleteProperty(document, "activeElement");
		}
		expect(calls).toEqual([["insertText", false, "try ", 3, 3]]);
		expect(draft()).toBe("/retry ");
	});

	it("L2: ⌘↵ on an empty expanded composer leaves it expanded", async () => {
		await mount();
		await pressKey({ key: "g", code: "KeyG", ctrlKey: true });
		expect(isExpanded()).toBe(true);
		await pressKey({ key: "Enter", metaKey: true });
		expect(isExpanded()).toBe(true);
		await typeDraft("go");
		await pressKey({ key: "Enter", metaKey: true });
		await flush();
		expect(isExpanded()).toBe(false);
	});

	it("L5: ⌃R and ⌃U read the physical key (Caps Lock, other layouts)", async () => {
		await mount();
		await typeDraft("one two");
		await pressKey({ key: "U", code: "KeyU", ctrlKey: true });
		expect(draft()).toBe("");
		await pressKey({ key: "ㄱ", code: "KeyR", ctrlKey: true });
		expect(document.querySelector('[role="dialog"][aria-label="History"]')).not.toBeNull();
	});

	it("L6: with the paste choice open, Enter pastes inline and typing leaves the field alone", async () => {
		await mount();
		const { onPaste } = reactProps<{ onPaste: (event: object) => void }>(findTextarea());
		// Past the default paste-menu threshold (100 lines).
		const block = Array.from({ length: 120 }, (_, line) => `row ${line}`).join("\n");
		await act(async () =>
			onPaste({
				clipboardData: { files: [], getData: (type: string) => (type === "text/plain" ? block : "") },
				preventDefault: () => {},
			}),
		);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect((await pressKey({ key: "x" })).defaultPrevented).toBe(true);
		expect((await pressKey({ key: "Enter" })).defaultPrevented).toBe(true);
		expect(expandPasteMarkers(draft())).toBe(block);
	});

	it("L4: Stop and send sends a picture added while recording", async () => {
		installFakeMic();
		try {
			await mount();
			const transcribeAudio = vi.fn(async () => ok({ text: "hello there" }));
			Object.assign(window.omp.rpc, { transcribeAudio, getSettings: vi.fn(async () => ok({ values: {} })) });
			await act(async () => useSettingsStore.setState({ sttEnabled: true }));
			const mic = document.querySelector(
				`button[aria-label="${translate("voice.mic.start")}"]`,
			) as unknown as TestElement | null;
			if (!mic) throw new Error("mic button missing");
			await click(mic);
			await flush();
			await act(async () => useComposerStore.getState().setImages([image("AQ==")]));
			const stopAndSend = document.querySelector("button[data-dictation-send]") as unknown as TestElement | null;
			if (!stopAndSend) throw new Error("Stop and send missing");
			await click(stopAndSend);
			await flush();
			await flush();
			expect(steer).toHaveBeenCalledWith("hello there", [image("AQ==").content]);
		} finally {
			uninstallFakeMic();
		}
	});

	it("L8: closing a composer leaves another pane's dictation running", async () => {
		installFakeMic();
		try {
			await mount();
			const transcribeAudio = vi.fn(async () => ok({ text: "other pane" }));
			Object.assign(window.omp.rpc, { transcribeAudio });
			const take = recordAndTranscribe();
			await flush();
			await act(async () => root.render(<div />));
			stopVoiceRecording();
			await expect(take).resolves.toEqual({ text: "other pane" });
		} finally {
			uninstallFakeMic();
		}
	});
});

describe("InputArea paste markers are one unit (DI-3)", () => {
	const content = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join("\n");
	const chips = () => document.querySelectorAll("[data-paste-chip]");
	function caretAt(position: number): void {
		(findTextarea() as unknown as { setSelectionRange(a: number, b: number): void }).setSelectionRange(
			position,
			position,
		);
	}

	it("Backspace right after a marker deletes the whole marker and its chip", async () => {
		await mount();
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		await typeInto(findTextarea(), `see ${marker} now`);
		expect(chips()).toHaveLength(1);
		caretAt(4 + marker.length);
		const key = await pressKey({ key: "Backspace" });
		expect(key.defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("see  now");
		expect(chips()).toHaveLength(0);
	});

	it("Delete at a marker's start, and a word delete that reaches into it, take it whole", async () => {
		await mount();
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		await typeInto(findTextarea(), `see ${marker} now`);
		caretAt(4);
		expect((await pressKey({ key: "Delete" })).defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("see  now");

		const again = storePaste(content);
		const second = pasteMarkerText(again.id, content);
		await typeInto(findTextarea(), `see ${second}`);
		caretAt(4 + second.length);
		// ⌥⌫ (⌃⌫ elsewhere) removes a word: the last word of a marker is the marker.
		const word = await pressKey({ key: "Backspace", altKey: true, ctrlKey: true });
		expect(word.defaultPrevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("see ");
	});

	it("leaves a delete that touches no marker to the browser", async () => {
		await mount();
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		await typeInto(findTextarea(), `see ${marker} now`);
		caretAt(4);
		expect((await pressKey({ key: "Backspace" })).defaultPrevented).toBe(false);
		caretAt(4 + marker.length);
		expect((await pressKey({ key: "Delete" })).defaultPrevented).toBe(false);
		expect(useComposerStore.getState().draft).toBe(`see ${marker} now`);
	});

	it("refuses to send what an edit left of a marker, and says so", async () => {
		await mount();
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		const fragment = marker.slice(0, -1);
		await typeInto(findTextarea(), `look at ${fragment}`);
		await pressKey({ key: "Enter" });
		await flush();
		expect(steer).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe(`look at ${fragment}`);
		expect(useToastStore.getState().toasts.map(item => item.message)).toEqual([
			translate("input.paste.dangling", { fragment }),
		]);
	});

	it("the chip's × removes the marker and its paste; 'as text' unfolds it", async () => {
		await mount();
		const first = storePaste(content);
		const second = storePaste(`${content}\nmore`);
		const markers = `${pasteMarkerText(first.id, first.content)} and ${pasteMarkerText(second.id, second.content)}`;
		await typeInto(findTextarea(), markers);
		expect(chips()).toHaveLength(2);
		const asText = document.querySelector(
			`button[aria-label="${translate("input.paste.asText", { id: second.id })}"]`,
		) as unknown as TestElement;
		await click(asText);
		expect(useComposerStore.getState().draft).toBe(
			`${pasteMarkerText(first.id, first.content)} and ${second.content}`,
		);
		const remove = document.querySelector(
			`button[aria-label="${translate("input.paste.remove", { id: first.id })}"]`,
		) as unknown as TestElement;
		await click(remove);
		expect(useComposerStore.getState().draft).toBe(`and ${second.content}`);
		expect(chips()).toHaveLength(0);
	});
});

describe("InputArea attachments (DI-9, DI-14, DI-15, DI-18)", () => {
	const png = (data: string) => ({
		content: { type: "image" as const, data, mimeType: "image/png" },
		preview: `data:image/png;base64,${data}`,
	});

	it("counts the pictures against the limit and warns past it without blocking", async () => {
		await mount();
		await act(async () => useComposerStore.getState().setImages([png("AA=="), png("AQ==")]));
		const count = () => document.querySelector("[data-attachment-count]");
		expect(count()?.getAttribute("data-attachment-count")).toBe("ok");
		expect(count()?.textContent).toBe(translate("input.attachments.count", { count: 2, max: 20 }));
		await act(async () =>
			useComposerStore.getState().setImages(Array.from({ length: 21 }, (_, index) => png(`AA${index}`))),
		);
		expect(count()?.getAttribute("data-attachment-count")).toBe("over");
		expect(count()?.getAttribute("role")).toBe("status");
	});

	it("Remove all empties the picture strip", async () => {
		await mount();
		await act(async () => useComposerStore.getState().setImages([png("AA=="), png("AQ==")]));
		const all = Array.from(document.querySelectorAll("ul[aria-label] button")).find(
			button => button.textContent === translate("input.attachments.removeAll"),
		) as unknown as TestElement;
		await click(all);
		expect(useComposerStore.getState().images).toEqual([]);
	});

	it("a drop anywhere on the pane attaches, and a non-file drag over it is refused outright", async () => {
		await mount();
		// Remount inside a session pane that also holds a transcript: the composer listens on the pane.
		await act(async () => root.unmount());
		const pane = container as unknown as Element;
		pane.className = "omp-session-pane";
		root = createRoot(pane);
		await act(async () =>
			root.render(
				<I18nProvider>
					<InputArea />
				</I18nProvider>,
			),
		);
		// A sibling of the composer, as the transcript is (React renders into the pane and leaves it alone).
		const transcript = document.createElement("div") as unknown as Element;
		pane.prepend(transcript);
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = () => "/tmp/notes.md";
		const file = new File(["alpha"], "notes.md");
		const fire = (type: string, target: Element, dataTransfer: object) => {
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { dataTransfer });
			target.dispatchEvent(event);
			return event;
		};
		const refused: Record<string, unknown> = { types: ["text/plain"], dropEffect: "copy" };
		expect(fire("dragover", transcript, refused).defaultPrevented).toBe(true);
		expect(refused.dropEffect).toBe("none");
		await act(async () => void fire("drop", transcript, { types: ["Files"], files: [file] }));
		await flush();
		expect(useComposerStore.getState().draft).toBe("@notes.md ");
	});

	it("refuses an empty file that has a path, and does not mention the same file twice", async () => {
		await mount();
		const pathFor: Record<string, string> = { "notes.md": "/tmp/notes.md", "empty.txt": "/tmp/empty.txt" };
		(window.omp.fs as unknown as Record<string, unknown>).pathForFile = (file: File) => pathFor[file.name] ?? "";
		const box = document.querySelector(".omp-composer-box");
		const drop = (files: File[]) => {
			const event = new Event("drop", { bubbles: true, cancelable: true });
			Object.assign(event, { dataTransfer: { types: ["Files"], files } });
			box?.dispatchEvent(event);
		};
		const notes = () => new File(["alpha"], "notes.md");
		await act(async () => drop([notes(), notes(), new File([], "empty.txt")]));
		await flush();
		expect(useComposerStore.getState().draft).toBe("@notes.md ");
		expect(useToastStore.getState().toasts.map(item => item.message)).toContain(
			translate("input.files.empty", { name: "empty.txt" }),
		);
		await act(async () => drop([notes()]));
		await flush();
		expect(useComposerStore.getState().draft).toBe("@notes.md ");
		expect(useToastStore.getState().toasts.map(item => item.message)).toContain(
			translate("input.files.duplicates", { count: 1 }),
		);
	});
});
