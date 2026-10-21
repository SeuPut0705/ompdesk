/**
 * A split pane that narrows its field below the idle hint switches to the short hint inside the resize
 * observer's callback, so the frame that first lays the field out narrow is drawn with it (a plain state
 * update rendered a task later and that frame showed the long hint cut off).
 */
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const observers: Array<() => void> = [];
class FakeResizeObserver {
	#callback: () => void;
	constructor(callback: () => void) {
		this.#callback = callback;
		observers.push(() => this.#callback());
	}
	observe(): void {}
	disconnect(): void {}
}
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	ResizeObserver: FakeResizeObserver,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { useComposerField } = await import("./use-composer-field");

function Field() {
	const { textareaRef, fieldNarrow } = useComposerField({ text: "", setText: () => {}, expanded: false });
	return createElement(
		"div",
		{ className: "omp-session-pane" },
		createElement("textarea", { ref: textareaRef, placeholder: fieldNarrow ? "short" : "long" }),
	);
}

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	observers.length = 0;
	document.body.replaceChildren();
});

describe("useComposerField", () => {
	it("shows the short hint in the same callback that sees the field narrow, before any task runs", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => root?.render(createElement(Field)));
		const field = container.querySelector("textarea");
		if (!field) throw new Error("expected the field");
		let width = 400;
		Object.defineProperty(field, "clientWidth", { get: () => width });
		act(() => {
			for (const notify of observers) notify();
		});
		expect(field.getAttribute("placeholder")).toBe("long");

		// Outside act(), as in a browser's resize step: nothing flushes React's queue after the callback.
		width = 209;
		(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
		try {
			for (const notify of observers) notify();
			expect(field.getAttribute("placeholder")).toBe("short");
		} finally {
			(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
		}
	});
});
