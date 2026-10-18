/**
 * The composer's text field is uncontrolled (DI-1): React 19 re-syncs a controlled textarea's `defaultValue` on every
 * keystroke, which made Cmd/Ctrl+Z undo one character at a time. The draft is the store's; the field takes it only when
 * it differs, and while the menu is open the field is a combobox (DI-8).
 */
import { parseHTML } from "linkedom";
import { act, createElement, type RefObject } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InlineCompletion } from "../../../hooks/use-inline-completion";
import { I18nProvider } from "../../../lib/i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { ComposerField } = await import("./ComposerField");

let container: HTMLElement;
let root: Root;
const textareaRef: RefObject<HTMLTextAreaElement | null> = { current: null };
const ownEdit: RefObject<boolean> = { current: false };
const setText = vi.fn();

const inline = {
	ghost: null,
	syncCaret: () => {},
	onFocus: () => {},
	onBlur: () => {},
	onCompositionStart: () => {},
	onCompositionEnd: () => {},
	accept: () => null,
	dismiss: () => false,
	drop: () => {},
} as unknown as InlineCompletion; // only the handlers the field calls

function field(text: string, activeOption?: number) {
	return createElement(
		I18nProvider,
		null,
		createElement(ComposerField, {
			textareaRef,
			ownEdit,
			text,
			setText,
			placeDraft: () => {},
			emojiAutocomplete: false,
			listboxId: "menu",
			activeOption,
			onFieldClick: () => {},
			inline,
			onKeyDown: () => {},
			onPaste: () => {},
			placeholder: "Ask",
			suggestionHint: false,
			expanded: false,
			monospace: false,
		}),
	);
}

async function render(text: string, activeOption?: number): Promise<void> {
	await act(async () => {
		root.render(field(text, activeOption));
	});
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	setText.mockClear();
});

async function mount(text: string): Promise<HTMLTextAreaElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await render(text);
	return textareaRef.current as HTMLTextAreaElement;
}

describe("ComposerField", () => {
	it("is uncontrolled: the restored draft is written into the field, React renders no value for it", async () => {
		const el = await mount("hello");
		expect(el.value).toBe("hello");
		expect(el.getAttribute("value")).toBeNull();
	});

	it("takes a draft written from outside (tab switch, restore, send) and leaves its own typing alone", async () => {
		const el = await mount("");
		let writes = 0;
		let current = "";
		Object.defineProperty(el, "value", {
			configurable: true,
			get: () => current,
			set: (next: string) => {
				writes++;
				current = next;
			},
		});
		// Typing: the field already holds the draft the store gives back.
		current = "hello";
		await render("hello");
		expect(writes).toBe(0);
		// A draft that differs (a tab switch) is written once.
		await render("another tab");
		expect(writes).toBe(1);
		expect(current).toBe("another tab");
		await render("");
		expect(current).toBe("");
		expect(writes).toBe(2);
	});

	it("is a combobox while a completion menu exists, a plain textbox otherwise", async () => {
		const el = await mount("/he");
		expect(el.getAttribute("role")).toBeNull();
		expect(el.getAttribute("aria-expanded")).toBeNull();
		await render("/he", 0);
		expect(el.getAttribute("role")).toBe("combobox");
		expect(el.getAttribute("aria-expanded")).toBe("true");
		expect(el.getAttribute("aria-haspopup")).toBe("listbox");
		expect(el.getAttribute("aria-controls")).toBe("menu");
		expect(el.getAttribute("aria-activedescendant")).toBe("menu-0");
		await render("/he");
		expect(el.getAttribute("role")).toBeNull();
	});
});
