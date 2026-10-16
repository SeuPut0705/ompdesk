/** A title eases in when it changes while mounted, never on the first paint or when it is another session's. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SwapText } from "./SwapText";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | undefined;

async function show(text: string, scope: string): Promise<void> {
	root ??= createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(<SwapText scope={scope}>{text}</SwapText>);
	});
}

const swapped = () => document.querySelector("[data-title-swap]");

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("SwapText", () => {
	it("does not animate the first paint", async () => {
		await show("Fix login bug", "s1");
		expect(swapped()).toBeNull();
		expect(document.body.textContent).toBe("Fix login bug");
	});

	it("animates a change of the same session's title, once per change", async () => {
		await show("Fix login bug", "s1");
		const before = document.querySelector("span");
		await show("Migrate build to Vite", "s1");
		expect(swapped()?.textContent).toBe("Migrate build to Vite");
		// A new element restarts the animation.
		expect(document.querySelector("span")).not.toBe(before);
		await show("Migrate build to Vite", "s1");
		expect(swapped()?.textContent).toBe("Migrate build to Vite");
	});

	it("paints another session's title without motion", async () => {
		await show("Fix login bug", "s1");
		await show("Write release notes", "s2");
		expect(swapped()).toBeNull();
		expect(document.body.textContent).toBe("Write release notes");
	});
});
