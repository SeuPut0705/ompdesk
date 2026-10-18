import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { NextPromptState } from "../../../../../resources/gui-bridge/modes/next-prompt-contracts";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import type * as ShellMode from "../../../hooks/use-shell-mode";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { InputArea } from "./InputArea";

/** The input and the shell mode the shell reports; the other next-prompt tests run with no web shell (mouse). */
const input = vi.hoisted(() => ({ current: "touch" as "touch" | null, mode: null as "phone" | null }));
vi.mock("../../../hooks/use-shell-mode", async importOriginal => ({
	...(await importOriginal<typeof ShellMode>()),
	useShellInput: () => input.current,
	useShellMode: () => input.mode,
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
	querySelector(selector: string): TestElement | null;
}

type Handler = (event: Record<string, unknown>) => void;

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let completeInline: Mock<(draft: string) => string | null>;
let rpcCommand: Mock<(command: RpcCommand) => Promise<RpcResponse>>;
let prompt: Mock<(...args: unknown[]) => Promise<unknown>>;

const BUILTIN: NextPromptState = {
	suggestions: true,
	inline: true,
	legacyExtension: false,
	requests: { suggest: 0, inline: 0 },
};

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

/** The chips a person can see: the row keeps its place while typing (`data-away`), its chips hidden. */
const chipButtons = () =>
	Array.from(
		document.querySelectorAll(".omp-next-chips:not([data-away]) [data-next-chip]"),
	) as unknown as TestElement[];
const sendNowButton = () => document.querySelector("[data-next-chip-send]") as unknown as TestElement | null;
const placeholder = () => findTextarea().getAttribute("placeholder");

async function typeInto(value: string): Promise<void> {
	const element = findTextarea();
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else (element as unknown as { value: string }).value = value;
	await act(async () => propsOf(element).onChange?.({ target: element, currentTarget: element }));
}

async function fire(name: string, element: unknown, event: Record<string, unknown> = {}): Promise<void> {
	await act(async () => propsOf(element)[name]?.({ preventDefault: () => {}, ...event }));
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function suggest(...candidates: string[]): Promise<void> {
	await act(async () =>
		useNextPromptStore.getState().recordUpdate("s1", {
			type: "next_prompt_update",
			status: "ready",
			sessionId: "s1",
			candidates,
		}),
	);
}

async function mount(): Promise<void> {
	prompt = vi.fn(async () => ok());
	rpcCommand = vi.fn(async (command: RpcCommand) => {
		if (command.type === "get_queue") return ok({ steering: [], followUp: [] });
		if (command.type === "complete_inline")
			return ok({ requestId: command.requestId, text: completeInline(command.draft) });
		return ok();
	});
	completeInline = vi.fn<(draft: string) => string | null>(() => " into smaller functions");
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })) },
		events: { onTabCommandsUpdate: vi.fn(() => () => {}), onConfigUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: vi.fn(async () => []) },
		rpc: {
			historyRecent: vi.fn(async () => ok([])),
			historySearch: vi.fn(async () => ok([])),
			getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
			command: rpcCommand,
			prompt,
		},
	};
	useSessionStore.setState({
		status: "ready",
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionFile: null,
		sessionName: null,
	});
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
	await act(async () => useSessionStore.setState({ nextPrompt: BUILTIN }));
}

beforeEach(() => {
	input.current = "touch";
	input.mode = null;
});

afterEach(async () => {
	vi.useRealTimers();
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useExtensionUiStore.getState().clearAll();
	useNextPromptStore.getState().reset();
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
});

describe("InputArea prompt suggestions on touch", () => {
	it("shows the best candidate as the first chip, never as the placeholder, and no key hints", async () => {
		await mount();
		await suggest("best one", "second option", "third option");
		expect(placeholder()).toBe(translate("input.placeholder.idle"));
		const buttons = chipButtons();
		expect(buttons.map(button => button.textContent)).toEqual(["best one", "second option", "third option"]);
		for (const button of buttons) {
			expect(button.querySelector("kbd")).toBeNull();
			expect(button.getAttribute("aria-keyshortcuts")).toBeNull();
		}
		// The Tab / → hint over the field and a Kbd anywhere in the suggestion row are desktop-only.
		expect(document.querySelector(".omp-next-chips kbd")).toBeNull();
		expect(document.body.textContent).not.toContain(translate("input.suggestion.accept"));
		expect(document.querySelector(".omp-next-chips")?.getAttribute("data-touch")).toBe("true");
	});

	it("a tap fills the composer with the text and sends nothing", async () => {
		await mount();
		await suggest("best one", "second option");
		await fire("onClick", chipButtons()[1]);
		expect(useComposerStore.getState().draft).toBe("second option");
		expect(prompt).not.toHaveBeenCalled();
		expect(rpcCommand.mock.calls.some(([command]) => command.type === "prompt")).toBe(false);
		expect(chipButtons()).toHaveLength(0);
	});

	it("a long press offers Send now, which sends the chip's text as it is", async () => {
		await mount();
		await suggest("best one", "second option");
		expect(sendNowButton()).toBeNull();
		await fire("onContextMenu", chipButtons()[0]);
		const sendNow = sendNowButton();
		expect(sendNow?.textContent).toBe(translate("input.chips.sendNow"));
		expect(useComposerStore.getState().draft).toBe("");
		await fire("onClick", sendNow);
		expect(sendNowButton()).toBeNull();
		const sent = [...prompt.mock.calls, ...rpcCommand.mock.calls.map(([command]) => [command])];
		expect(JSON.stringify(sent)).toContain("best one");
	});

	it("hides the row while typing and with no suggestions", async () => {
		await mount();
		expect(document.querySelector(".omp-next-chips:not([data-away])")).toBeNull();
		await suggest("only best");
		expect(chipButtons()).toHaveLength(1);
		await typeInto("a");
		expect(chipButtons()).toHaveLength(0);
	});

	it("on a phone the chips join the status chip row after its divider, and typing hides them but keeps the divider", async () => {
		input.mode = "phone";
		await mount();
		await suggest("best one", "second option");
		const statusRow = document.querySelector("[data-status-row]") as unknown as TestElement | null;
		expect(statusRow).not.toBeNull();
		expect(statusRow?.querySelector(".omp-next-chips[data-bare]")).not.toBeNull();
		expect(chipButtons().map(button => button.textContent)).toEqual(["best one", "second option"]);
		const divider = statusRow?.querySelector("[data-status-divider]");
		expect(divider?.getAttribute("data-away")).toBeNull();
		await typeInto("a");
		expect(chipButtons()).toHaveLength(0);
		expect(statusRow?.querySelector("[data-status-divider]")?.getAttribute("data-away")).toBe("true");
		// Tapping a chip still fills the field and sends nothing.
		await typeInto("");
		await fire("onClick", chipButtons()[1]);
		expect(useComposerStore.getState().draft).toBe("second option");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("has no status chip row off the phone shell", async () => {
		await mount();
		await suggest("best one", "second option");
		expect(document.querySelector("[data-status-row]")).toBeNull();
		expect(document.querySelector(".omp-next-chips")?.getAttribute("data-bare")).toBeNull();
	});

	it("makes no inline completion request: the keyboard's own suggestions and the IME own the draft", async () => {
		await mount();
		vi.useFakeTimers();
		await fire("onFocus", findTextarea());
		await typeInto("please refactor the parser");
		await advance(5000);
		expect(completeInline).not.toHaveBeenCalled();
		expect(rpcCommand.mock.calls.filter(([command]) => command.type === "complete_inline")).toHaveLength(0);
		expect(document.querySelector("[data-inline-ghost]")).toBeNull();
	});

	it("keeps the mouse layout: placeholder text, a Tab hint, ⌥N chips and inline requests", async () => {
		input.current = null;
		await mount();
		await suggest("best one", "second option");
		expect(placeholder()).toBe("best one");
		expect(chipButtons().map(button => button.textContent?.replace(/⌥\d$/, ""))).toEqual(["second option"]);
		expect(chipButtons()[0]?.getAttribute("aria-keyshortcuts")).toBe("Alt+1");
		expect(document.body.textContent).toContain(translate("input.suggestion.accept"));
		expect(document.querySelector(".omp-next-chips")?.getAttribute("data-touch")).toBeNull();
		await fire("onContextMenu", chipButtons()[0]);
		expect(sendNowButton()).toBeNull();
	});
});
