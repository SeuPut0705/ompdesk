/**
 * The composer's run-state wiring: the Esc hints under the field (Esc again to stop, deciding), Stop busy while a stop is
 * in flight, the placeholder priority (blocked > editing queued > follow-up > steer > idle) and Edit queued, where the
 * field holds a queued message and Cancel / Esc restore the exact previous draft and pictures.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcCommand, RpcQueuedMessage, RpcResponse } from "../../../../shared/rpc-types";
import type * as ShellMode from "../../../hooks/use-shell-mode";
import { resetHardwareKeyboardForTests } from "../../../lib/hardware-keyboard";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useQueueStore } from "../../../stores/queue";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { InputArea } from "./InputArea";

/** The input the shell reports: touch (a phone or tablet) or none (the desktop). */
const input = vi.hoisted(() => ({ current: null as "touch" | null }));
vi.mock("../../../hooks/use-shell-mode", async importOriginal => ({
	...(await importOriginal<typeof ShellMode>()),
	useShellInput: () => input.current,
}));

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
elementPrototype.focus = () => {};
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
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	querySelector(selector: string): TestElement | null;
}

type Handler = (event: Record<string, unknown>) => void;

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });
const image = {
	content: { type: "image" as const, data: "AA==", mimeType: "image/png" },
	preview: "data:image/png;base64,AA==",
};

let container: TestElement;
let root: Root;
let queueEdit: Mock;
let prompt: Mock<(...args: unknown[]) => Promise<unknown>>;

function propsOf(element: unknown): Record<string, Handler | undefined> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("element has no React props");
	return record[key] as Record<string, Handler | undefined>;
}

function findTextarea(): TestElement {
	const textarea = document.querySelector("textarea") as unknown as TestElement | null;
	if (!textarea) throw new Error("composer textarea not found");
	return textarea;
}

function fieldValue(): string {
	return (findTextarea() as unknown as { value: string }).value;
}

async function typeInto(value: string): Promise<void> {
	const element = findTextarea();
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else (element as unknown as { value: string }).value = value;
	await act(async () => propsOf(element).onChange?.({ target: element, currentTarget: element }));
}

/** A keydown on the field; says whether the composer kept the browser's default and the app-wide Escape away. */
async function press(
	key: string,
	init: Record<string, unknown> = {},
): Promise<{ prevented: boolean; stopped: boolean }> {
	const state = { prevented: false, stopped: false };
	await act(async () =>
		propsOf(findTextarea()).onKeyDown?.({
			key,
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			repeat: false,
			nativeEvent: { isComposing: false },
			preventDefault: () => {
				state.prevented = true;
			},
			stopPropagation: () => {
				state.stopped = true;
			},
			...init,
		}),
	);
	return state;
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function button(label: string): TestElement | null {
	return document.querySelector(`button[aria-label="${label}"]`) as unknown as TestElement | null;
}

const placeholder = () => findTextarea().getAttribute("placeholder");

function queued(id: string, text: string): RpcQueuedMessage {
	return { id, text, editable: true, timestamp: 1 };
}

async function mount(opts: { streaming?: boolean; steering?: RpcQueuedMessage[]; followUp?: RpcQueuedMessage[] } = {}) {
	const steering = opts.steering ?? [];
	const followUp = opts.followUp ?? [];
	prompt = vi.fn(async () => ok());
	queueEdit = vi.fn(async () => ok({ updated: true }));
	const rpcCommand = vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
		if (command.type === "get_queue") return ok({ steering, followUp });
		return ok();
	});
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		events: { onTabCommandsUpdate: vi.fn(() => () => {}), onConfigUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			historyRecent: vi.fn(async () => ok([])),
			historySearch: vi.fn(async () => ok([])),
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			command: rpcCommand,
			queueEdit,
			prompt,
		},
	};
	useSessionStore.setState({
		status: "ready",
		isStreaming: opts.streaming ?? false,
		queuedMessageCount: steering.length + followUp.length,
		cwd: "/tmp",
		sessionId: "s1",
		sessionFile: null,
		sessionName: null,
	});
	useQueueStore.getState().setFromFrame({ steering, followUp });
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InputArea />
			</I18nProvider>,
		);
	});
	await flush();
}

beforeEach(() => {
	input.current = null;
	resetHardwareKeyboardForTests();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useExtensionUiStore.setState({ pendingRequests: [], loginRequestIds: {} });
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useNextPromptStore.getState().reset();
	useTabsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({ displayPreferences: {} });
	vi.restoreAllMocks();
});

describe("Esc and Stop in the composer", () => {
	it("shows Press Esc again to stop while the first Esc of a stop waits, and drops it with an edit", async () => {
		await mount({ streaming: true });
		await typeInto("my draft");
		expect(document.querySelector("[data-stop-hint]")).toBeNull();
		await act(async () => useComposerStore.getState().armStop());
		expect(document.querySelector("[data-stop-hint]")?.textContent).toBe(
			"Press Esc again to stop the turn. Your draft stays.",
		);
		await typeInto("my draft!");
		expect(document.querySelector("[data-stop-hint]")).toBeNull();
	});

	it("says Deciding how to run this… while the automatic mode choice runs", async () => {
		await mount();
		await act(async () => useComposerStore.getState().setDecidingMode(true));
		expect(document.querySelector("[data-deciding-hint]")?.textContent).toBe("Deciding how to run this…");
		await act(async () => useComposerStore.getState().setDecidingMode(false));
		expect(document.querySelector("[data-deciding-hint]")).toBeNull();
	});

	it("keeps Stop busy and inert, named Stopping…, until the turn ends", async () => {
		await mount({ streaming: true });
		const stop = button("Stop");
		expect(stop?.hasAttribute("disabled")).toBe(false);
		await act(async () => useComposerStore.getState().setStopping(true));
		const busy = button("Stopping…");
		expect(busy?.hasAttribute("disabled")).toBe(true);
		expect(busy?.getAttribute("aria-busy")).toBe("true");
		await act(async () => useComposerStore.getState().setStopping(false));
		expect(button("Stop")?.hasAttribute("disabled")).toBe(false);
	});
});

describe("the field's placeholder, by priority", () => {
	it("goes idle, then steer while a turn runs", async () => {
		await mount({ streaming: true });
		expect(placeholder()).toBe("Add an instruction…");
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		expect(placeholder()).not.toBe("Add an instruction…");
	});

	it("puts a pending question above everything, a queued edit above the lane", async () => {
		await mount({ streaming: true, steering: [queued("s1", "queued text")] });
		await act(async () => useComposerStore.getState().beginEditQueued({ id: "s1", lane: "steering", text: "" }));
		expect(placeholder()).toBe("Edit the queued message…");
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "q1",
				method: "input",
				title: "Which file?",
			}),
		);
		expect(placeholder()).toBe("Answer the question above, or type to add an instruction…");
	});
});

describe("Edit queued", () => {
	async function mountEditing(): Promise<void> {
		await mount({ streaming: true, steering: [queued("s1", "queued text")] });
		await act(async () => {
			useComposerStore.getState().setDraft("my draft");
			useComposerStore.getState().setImages([image]);
			useComposerStore.getState().beginEditQueued({ id: "s1", lane: "steering", text: "queued text" });
		});
	}

	it("puts the message in the field under a banner, with Send as a check", async () => {
		await mountEditing();
		expect(fieldValue()).toBe("queued text");
		const banner = document.querySelector("[data-queue-edit-banner]");
		expect(banner?.textContent).toContain("Edit queued");
		expect(banner?.textContent).toContain("Saves as last in “After next step”");
		expect(button("Save queued message")).not.toBeNull();
		expect(button("Send")).toBeNull();
		// The pill gives way to the editor.
		expect(document.querySelector("[data-queue-pill]")).toBeNull();
	});

	it("restores the exact previous draft and pictures on Esc, claiming the key from the app-wide Stop", async () => {
		await mountEditing();
		await typeInto("changed my mind");
		const result = await press("Escape");
		expect(result).toEqual({ prevented: true, stopped: true });
		expect(useComposerStore.getState().editingQueued).toBeNull();
		expect(useComposerStore.getState().draft).toBe("my draft");
		expect(useComposerStore.getState().images).toEqual([image]);
		expect(queueEdit).not.toHaveBeenCalled();
		expect(document.querySelector("[data-queue-edit-banner]")).toBeNull();
		expect(fieldValue()).toBe("my draft");
	});

	it("restores the same on the banner's Cancel", async () => {
		await mountEditing();
		const cancel = document.querySelector("[data-queue-edit-cancel]");
		await act(async () => propsOf(cancel).onClick?.({}));
		expect(useComposerStore.getState().draft).toBe("my draft");
		expect(useComposerStore.getState().images).toEqual([image]);
	});

	it("saves on Enter: the queue's edit gets the text and the draft comes back", async () => {
		await mountEditing();
		await typeInto("better text");
		const result = await press("Enter");
		expect(result.prevented).toBe(true);
		await flush();
		expect(queueEdit).toHaveBeenCalledWith("s1", "better text");
		expect(prompt).not.toHaveBeenCalled();
		expect(useComposerStore.getState().editingQueued).toBeNull();
		expect(useComposerStore.getState().draft).toBe("my draft");
		expect(useComposerStore.getState().images).toEqual([image]);
	});

	it("saves nothing when the text is unchanged, and still restores", async () => {
		await mountEditing();
		await press("Enter");
		expect(queueEdit).not.toHaveBeenCalled();
		expect(useComposerStore.getState().draft).toBe("my draft");
	});

	it("never saves an emptied message", async () => {
		await mountEditing();
		await typeInto("   ");
		await press("Enter");
		expect(queueEdit).not.toHaveBeenCalled();
		expect(useComposerStore.getState().editingQueued).not.toBeNull();
	});

	it("keeps ↑ for the caret instead of recalling history over the edit", async () => {
		await mountEditing();
		const result = await press("ArrowUp");
		expect(result.prevented).toBe(false);
		expect(fieldValue()).toBe("queued text");
	});

	it("on a touch keyboard Enter is a newline and the check button saves", async () => {
		input.current = "touch";
		await mountEditing();
		await typeInto("better text");
		const result = await press("Enter");
		expect(result.prevented).toBe(false);
		expect(queueEdit).not.toHaveBeenCalled();
		const save = button("Save queued message");
		await act(async () => propsOf(save).onClick?.({ preventDefault: () => {} }));
		await flush();
		expect(queueEdit).toHaveBeenCalledWith("s1", "better text");
		expect(useComposerStore.getState().draft).toBe("my draft");
	});

	it("ends by itself when the message was delivered meanwhile: the edit goes ahead of the restored draft", async () => {
		await mountEditing();
		await typeInto("better text");
		await act(async () => useQueueStore.getState().setFromFrame({ steering: [], followUp: [] }));
		expect(useComposerStore.getState().editingQueued).toBeNull();
		expect(useComposerStore.getState().draft).toBe("better text\n\nmy draft");
		expect(useComposerStore.getState().images).toEqual([image]);
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toEqual([
			"“queued text” was already delivered. Your edit is in the field, ahead of your draft.",
		]);
		expect(prompt).not.toHaveBeenCalled();
	});
});
