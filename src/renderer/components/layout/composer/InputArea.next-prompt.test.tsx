import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { NextPromptState } from "../../../../../resources/gui-bridge/modes/next-prompt-contracts";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useFirstRunStore } from "../../../stores/first-run";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
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

/** Elements `focus()` was called on, newest last (linkedom has no focus model). */
const focusLog: unknown[] = [];
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
elementPrototype.focus = function (this: unknown) {
	focusLog.push(this);
};
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
	querySelector(selector: string): TestElement | null;
}

type Handler = (event: Record<string, unknown>) => void;

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
/** `complete_inline` calls the composer made. */
let completeInline: Mock<(draft: string) => string | null>;
/** Every command the composer sent. */
let rpcCommand: Mock<(command: RpcCommand) => Promise<RpcResponse>>;
/** While set, `complete_inline` answers wait for it. */
let gate: PromiseWithResolvers<void> | undefined;

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

function chipButtons(): TestElement[] {
	return Array.from(
		document.querySelectorAll(".omp-next-chips:not([data-away]) [data-next-chip]"),
	) as unknown as TestElement[];
}

const placeholder = () => findTextarea().getAttribute("placeholder");
const ghostText = () => (document.querySelector("[data-inline-ghost]") as unknown as TestElement | null)?.textContent;

async function typeInto(value: string): Promise<void> {
	const element = findTextarea();
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else (element as unknown as { value: string }).value = value;
	await act(async () => propsOf(element).onChange?.({ target: element, currentTarget: element }));
}

/** Drive the textarea's onKeyDown; the chip buttons use {@link pressChipKey}. */
async function press(
	init: Record<string, unknown>,
	element: unknown = findTextarea(),
): Promise<{ prevented: boolean }> {
	const state = { prevented: false };
	await act(async () =>
		propsOf(element).onKeyDown?.({
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			nativeEvent: { isComposing: false },
			preventDefault: () => {
				state.prevented = true;
			},
			stopPropagation: () => {},
			...init,
		}),
	);
	return state;
}

async function fire(name: string, element: unknown = findTextarea()): Promise<void> {
	await act(async () => propsOf(element)[name]?.({}));
}

async function click(element: unknown): Promise<void> {
	await act(async () => propsOf(element).onClick?.({}));
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

/** Advance fake time and let the requests it starts settle. */
async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function setBuiltin(state: Partial<NextPromptState> | null = {}): Promise<void> {
	await act(async () => useSessionStore.setState({ nextPrompt: state === null ? null : { ...BUILTIN, ...state } }));
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
	rpcCommand = vi.fn(async (command: RpcCommand) => {
		if (command.type === "get_queue") return ok({ steering: [], followUp: [] });
		if (command.type === "complete_inline") {
			await gate?.promise;
			return ok({ requestId: command.requestId, text: completeInline(command.draft) });
		}
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
			prompt: vi.fn(async () => ok()),
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
}

beforeEach(() => {
	focusLog.length = 0;
});

afterEach(async () => {
	vi.useRealTimers();
	await act(async () => root.unmount());
	container.remove();
	useSessionStore.getState().reset();
	useFirstRunStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useComposerStore.getState().reset();
	useInputHistoryStore.setState({ entries: [], navIndex: -1, navDraft: "", navContext: undefined });
	useExtensionUiStore.getState().clearAll();
	useNextPromptStore.getState().reset();
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
});

describe("InputArea built-in suggestion placeholder", () => {
	it("shows the built-in best as the placeholder and Tab / → accept it", async () => {
		await mount();
		await setBuiltin();
		await suggest("run the tests", "show the diff");
		expect(placeholder()).toBe("run the tests");

		expect((await press({ key: "Tab" })).prevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("run the tests");

		await typeInto("");
		expect(placeholder()).toBe("run the tests");
		expect((await press({ key: "ArrowRight" })).prevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("run the tests");
	});

	it("falls back to the idle hint when the built-in has no candidate", async () => {
		await mount();
		await setBuiltin();
		await flush();
		expect(placeholder()).toBe(translate("input.placeholder.idle"));
	});
});

describe("InputArea legacy next-prompt widget", () => {
	const pushWidget = (text: string) =>
		act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: `widget-${text}`,
				method: "setWidget",
				widgetKey: "next-prompt",
				widgetLines: [`\x1b[2m↹ Tab  ${text}\x1b[22m`],
			}),
		);

	it("is ignored while the built-in is on", async () => {
		await mount();
		await setBuiltin();
		await suggest("built-in best");
		await pushWidget("legacy widget");
		expect(placeholder()).toBe("built-in best");
		expect(useNextPromptStore.getState().suggestions.s1?.candidates).toEqual(["built-in best"]);
	});

	it("records nothing from the widget while the built-in is on and has no candidate", async () => {
		await mount();
		await setBuiltin();
		await pushWidget("legacy widget");
		expect(placeholder()).toBe(translate("input.placeholder.idle"));
		expect(useNextPromptStore.getState().suggestions.s1).toBeUndefined();
	});

	it("still feeds the placeholder while the built-in is off or unsupported", async () => {
		await mount();
		await setBuiltin(null);
		await pushWidget("legacy widget");
		expect(placeholder()).toBe("legacy widget");
		await act(async () =>
			useSessionStore.setState({ nextPrompt: { ...BUILTIN, suggestions: false, inline: false } }),
		);
		expect(placeholder()).toBe("legacy widget");
	});

	it("is picked up again (and Tab fills it) once the built-in is switched off after the widget arrived", async () => {
		await mount();
		await setBuiltin();
		await pushWidget("legacy widget");
		expect(placeholder()).toBe(translate("input.placeholder.idle"));
		await act(async () => useSessionStore.setState({ nextPrompt: { ...BUILTIN, suggestions: false } }));
		expect(placeholder()).toBe("legacy widget");
		expect((await press({ key: "Tab" })).prevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("legacy widget");
	});
});

describe("InputArea suggestion chips", () => {
	it("renders the runner-ups as labelled buttons above the composer box", async () => {
		await mount();
		await setBuiltin();
		await suggest("best one", "second option", "third option");
		const group = document.querySelector('[role="group"]') as unknown as TestElement;
		expect(group.getAttribute("aria-label")).toBe(translate("input.chips.label"));
		const buttons = chipButtons();
		expect(buttons).toHaveLength(2);
		expect(buttons[0]?.getAttribute("aria-label")).toBe(
			translate("input.chips.chip", { index: 1, text: "second option" }),
		);
		expect(buttons[1]?.getAttribute("aria-label")).toBe(
			translate("input.chips.chip", { index: 2, text: "third option" }),
		);
		expect(buttons[0]?.getAttribute("title")).toBe("second option");
		expect(buttons[0]?.getAttribute("type")).toBe("button");
		expect(buttons[0]?.querySelector("kbd")?.textContent).toMatch(/1$/);
		// Between the menus and the box: the group precedes the composer box inside the anchor.
		const anchor = document.querySelector(".omp-composer-anchor") as unknown as { children: TestElement[] };
		const order = Array.from(anchor.children).map(child => child.getAttribute("class") ?? "");
		expect(order.findIndex(name => name.includes("omp-next-chips"))).toBeLessThan(
			order.findIndex(name => name.includes("omp-composer-box")),
		);
	});

	it("click fills the composer, focuses it and the chips vanish", async () => {
		await mount();
		await setBuiltin();
		await suggest("best one", "second option");
		await click(chipButtons()[0]);
		expect(useComposerStore.getState().draft).toBe("second option");
		expect(focusLog.at(-1)).toBe(findTextarea());
		expect(chipButtons()).toHaveLength(0);
	});

	it("↓ moves focus into the chips; ←/→ rove; Esc returns without filling", async () => {
		await mount();
		await setBuiltin();
		await suggest("best one", "second option", "third option");
		expect((await press({ key: "ArrowDown" })).prevented).toBe(true);
		const [first, second] = chipButtons();
		expect(focusLog.at(-1)).toBe(first);
		expect(first?.getAttribute("tabindex")).toBe("0");
		expect(second?.getAttribute("tabindex")).toBe("-1");

		await press({ key: "ArrowRight" }, first);
		expect(focusLog.at(-1)).toBe(second);
		expect(second?.getAttribute("tabindex")).toBe("0");
		await press({ key: "ArrowLeft" }, second);
		expect(focusLog.at(-1)).toBe(first);

		expect((await press({ key: "Escape" }, first)).prevented).toBe(true);
		expect(focusLog.at(-1)).toBe(findTextarea());
		expect(useComposerStore.getState().draft).toBe("");
		expect(chipButtons()).toHaveLength(2);

		await press({ key: "ArrowDown" });
		await press({ key: "ArrowUp" }, chipButtons()[0]);
		expect(focusLog.at(-1)).toBe(findTextarea());
	});

	it("Alt+1..2 fill chip text by physical key, also from a focused chip", async () => {
		await mount();
		await setBuiltin();
		await suggest("best one", "second option", "third option");
		// macOS ⌥2 types "™": only `code` identifies the chip.
		expect((await press({ key: "™", code: "Digit2", altKey: true })).prevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("third option");

		await typeInto("");
		await press({ key: "¡", code: "Digit1", altKey: true }, chipButtons()[1]);
		expect(useComposerStore.getState().draft).toBe("second option");

		// No third chip: Alt+3 leaves the key alone.
		await typeInto("");
		expect((await press({ key: "£", code: "Digit3", altKey: true })).prevented).toBe(false);
	});

	it("shows at most three chips; Alt+3 fills the fourth candidate and nothing claims Alt+4", async () => {
		await mount();
		await setBuiltin();
		await suggest("Best", "Second idea", "Third idea", "Fourth idea", "Fifth idea");
		expect(chipButtons()).toHaveLength(3);
		expect((await press({ key: "£", code: "Digit3", altKey: true })).prevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe("Fourth idea");
		await typeInto("");
		expect((await press({ key: "¢", code: "Digit4", altKey: true })).prevented).toBe(false);
	});

	it("vanish when typing, while streaming and when the tab is not ready", async () => {
		await mount();
		await setBuiltin();
		await suggest("best one", "second option");
		expect(chipButtons()).toHaveLength(1);

		await typeInto("a");
		expect(chipButtons()).toHaveLength(0);
		await typeInto("");
		expect(chipButtons()).toHaveLength(1);

		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(chipButtons()).toHaveLength(0);
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		// A run start clears the memory: the next turn's suggestions come back with the next update.
		await suggest("best one", "second option");
		expect(chipButtons()).toHaveLength(1);

		await act(async () => useSessionStore.setState({ status: "starting" }));
		expect(chipButtons()).toHaveLength(0);
	});

	it("↓ without chips keeps its history meaning", async () => {
		await mount();
		await setBuiltin();
		await suggest("only best");
		focusLog.length = 0;
		await press({ key: "ArrowDown" });
		expect(focusLog).toHaveLength(0);
		expect(chipButtons()).toHaveLength(0);
	});
});

describe("InputArea inline ghost text", () => {
	const DRAFT = "please refactor the parser";

	/** Type the draft, focus the field and let the debounce elapse. */
	async function typeAndWait(draft = DRAFT): Promise<void> {
		await fire("onFocus");
		await typeInto(draft);
		await advance(700);
	}

	/** Hold the next `complete_inline` answers until the test resolves {@link gate}. */
	async function mountInline(holdAnswers = false): Promise<void> {
		await mount();
		gate = holdAnswers ? Promise.withResolvers<void>() : undefined;
		await setBuiltin();
		await flush();
		vi.useFakeTimers();
	}

	it("shows the continuation after the debounce for an eligible draft", async () => {
		await mountInline();
		await fire("onFocus");
		await typeInto(DRAFT);
		await advance(599);
		expect(completeInline).not.toHaveBeenCalled();
		expect(ghostText()).toBeUndefined();
		await advance(1);
		expect(completeInline).toHaveBeenCalledTimes(1);
		expect(completeInline).toHaveBeenCalledWith(DRAFT);
		const ghost = document.querySelector("[data-inline-ghost]") as unknown as TestElement;
		expect(ghost.getAttribute("aria-hidden")).toBe("true");
		expect(ghost.textContent).toContain(`${DRAFT} into smaller functions`);
	});

	it("Tab accepts it with the caret at the end", async () => {
		await mountInline();
		await typeAndWait();
		const tab = await press({ key: "Tab" });
		expect(tab.prevented).toBe(true);
		expect(useComposerStore.getState().draft).toBe(`${DRAFT} into smaller functions`);
		const textarea = findTextarea() as unknown as { selectionStart: number; selectionEnd: number; value: string };
		expect(textarea.selectionStart).toBe(textarea.value.length);
		expect(ghostText()).toBeUndefined();
	});

	it("Esc dismisses it and claims the key only then", async () => {
		await mountInline();
		await typeAndWait();
		expect((await press({ key: "Escape" })).prevented).toBe(true);
		expect(ghostText()).toBeUndefined();
		expect(useComposerStore.getState().draft).toBe(DRAFT);
		// Nothing re-requests for the same draft.
		await advance(5000);
		expect(completeInline).toHaveBeenCalledTimes(1);
		expect(ghostText()).toBeUndefined();
	});

	it("typing drops it, aborts the request in flight and tells the bridge to cancel", async () => {
		await mountInline(true);
		await fire("onFocus");
		await typeInto(DRAFT);
		await advance(600);
		expect(rpcCommand.mock.calls.filter(([command]) => command.type === "complete_inline")).toHaveLength(1);
		expect(ghostText()).toBeUndefined();
		// The answer is still on its way when the next key arrives.
		await press({ key: "x" });
		expect(rpcCommand).toHaveBeenCalledWith({ type: "cancel_next_prompt", scope: "inline" });
		await typeInto(`${DRAFT}x`);
		await act(async () => {
			gate?.resolve();
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(ghostText()).toBeUndefined();
	});

	it("drops a shown ghost on any other key", async () => {
		await mountInline();
		await typeAndWait();
		expect(ghostText()).toContain("into smaller functions");
		await press({ key: "x" });
		expect(ghostText()).toBeUndefined();
		await typeInto(`${DRAFT}x`);
		expect(ghostText()).toBeUndefined();
	});

	it("never completes while an IME composition is open", async () => {
		await mountInline();
		await fire("onFocus");
		await fire("onCompositionStart");
		await typeInto("한글을 입력하는 중입니다");
		await advance(5000);
		expect(completeInline).not.toHaveBeenCalled();
		await fire("onCompositionEnd");
		await advance(700);
		expect(completeInline).toHaveBeenCalledTimes(1);
	});

	it("never completes a slash, bash, python or queue draft, a short or a multi-line one", async () => {
		await mountInline();
		for (const draft of [
			"/model something long",
			"!git status --short",
			"$print(1 + 1) + more",
			"-> queue the next job",
			"short",
			"first line\nsecond line is long",
		]) {
			await fire("onFocus");
			await typeInto(draft);
			await advance(5000);
			expect(completeInline).not.toHaveBeenCalled();
			expect(ghostText()).toBeUndefined();
		}
	});

	it("never completes while the large-paste choice is open, and resumes once it closes", async () => {
		await mountInline();
		await fire("onFocus");
		await typeInto(DRAFT);
		const content = Array.from({ length: 300 }, (_, index) => `pasted line ${index}`).join("\n");
		await act(async () =>
			propsOf(findTextarea()).onPaste?.({
				clipboardData: { files: [], getData: () => content },
				preventDefault: () => {},
			}),
		);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		await advance(5000);
		expect(completeInline).not.toHaveBeenCalled();
		expect(ghostText()).toBeUndefined();
	});

	it("does nothing without focus, while streaming, or when inline is off", async () => {
		await mountInline();
		await typeInto(DRAFT);
		await advance(5000);
		expect(completeInline).not.toHaveBeenCalled();

		await fire("onFocus");
		await advance(700);
		expect(completeInline).toHaveBeenCalledTimes(1);

		completeInline.mockClear();
		await act(async () => useSessionStore.setState({ nextPrompt: { ...BUILTIN, inline: false } }));
		await typeInto(`${DRAFT} again`);
		await advance(5000);
		expect(completeInline).not.toHaveBeenCalled();
		expect(ghostText()).toBeUndefined();
	});

	it("hides the ghost when the caret leaves the end of the draft", async () => {
		await mountInline();
		await typeAndWait();
		expect(ghostText()).toBeDefined();
		const textarea = findTextarea() as unknown as { selectionStart: number; selectionEnd: number };
		textarea.selectionStart = 3;
		textarea.selectionEnd = 3;
		await fire("onSelect");
		expect(ghostText()).toBeUndefined();
	});

	it("makes no request in an unsupported tab", async () => {
		await mount();
		await setBuiltin(null);
		await flush();
		vi.useFakeTimers();
		await fire("onFocus");
		await typeInto(DRAFT);
		await advance(5000);
		expect(completeInline).not.toHaveBeenCalled();
	});
});

describe("InputArea suggestion footer hint", () => {
	it("names why suggestions are unavailable, with the provider detail as the title", async () => {
		await mount();
		await setBuiltin();
		await act(async () =>
			useSessionStore.setState({ nextPromptUnavailable: { reason: "no_model", detail: "smol role is unset" } }),
		);
		const hint = document.querySelector("[data-next-prompt-unavailable]") as unknown as TestElement;
		expect(hint.getAttribute("role")).toBe("status");
		expect(hint.textContent).toBe(translate("input.suggestion.unavailable.no_model"));
		expect(hint.getAttribute("title")).toBe("smol role is unset");
	});

	it("an unavailable built-in is one quiet status line: no alert, no chips, no candidate placeholder", async () => {
		await mount();
		await setBuiltin();
		await act(async () => useSessionStore.setState({ nextPromptUnavailable: { reason: "no_model" } }));
		expect(document.querySelectorAll("[role='status'][data-next-prompt-unavailable]")).toHaveLength(1);
		expect(document.querySelector("[role='alert']")).toBeNull();
		expect(chipButtons()).toHaveLength(0);
		expect(placeholder()).toBe(translate("input.placeholder.idle"));
	});

	it("is absent while the built-in is off and yields to the double-Esc hint", async () => {
		await mount();
		await act(async () =>
			useSessionStore.setState({ nextPromptUnavailable: { reason: "offline" }, nextPrompt: null }),
		);
		expect(document.querySelector("[data-next-prompt-unavailable]")).toBeNull();

		await setBuiltin();
		await flush();
		expect(document.querySelector("[data-next-prompt-unavailable]")).not.toBeNull();
		await typeInto("draft");
		await press({ key: "Escape" });
		expect(document.querySelector("[data-esc-hint]")).not.toBeNull();
		expect(document.querySelector("[data-next-prompt-unavailable]")).toBeNull();
	});

	it("stays off while the first-run setup is open, then shows once it ends", async () => {
		await mount();
		await setBuiltin();
		await act(async () => useSessionStore.setState({ nextPromptUnavailable: { reason: "no_model" } }));
		await act(async () => useFirstRunStore.getState().setPhase("connect", null));
		expect(document.querySelector("[data-next-prompt-unavailable]")).toBeNull();

		await act(async () => useFirstRunStore.getState().setPhase("idle", null));
		expect(document.querySelector("[data-next-prompt-unavailable]")).not.toBeNull();
	});
});
