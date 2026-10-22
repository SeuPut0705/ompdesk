/** The composer's completion rows are options the field drives: none a tab stop, a row taken on mouse down. */

import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { CompletionList } = await import("./CompletionList");

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("CompletionList", () => {
	it("lists every row as an option the field drives, none a tab stop, and takes a row on mouse down", async () => {
		const onPick = vi.fn();
		const items = ["plan", "model", "jobs"].map(label => ({ label, description: `${label} command` }));
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as globalThis.Element);
		await act(async () => {
			root?.render(
				createElement(
					I18nProvider,
					null,
					createElement(CompletionList, {
						menu: { source: "command", rangeStart: 0, rangeEnd: 1, items, index: 1 } as never,
						menuId: "menu",
						onPick,
						onHover: vi.fn(),
					}),
				),
			);
		});
		const options = Array.from(document.querySelectorAll("[role=option]"));
		expect(options.map(option => option.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1"]);
		expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
		expect(options.map(option => option.id)).toEqual(["menu-0", "menu-1", "menu-2"]);
		// The pointer moves the highlight itself: no row draws a hover tint beside it.
		expect(options.some(option => option.className.includes("hover:"))).toBe(false);
		await act(async () => {
			options[2]?.dispatchEvent(new Event("mousedown", { bubbles: true, cancelable: true }));
		});
		expect(onPick).toHaveBeenCalledWith(items[2]);
	});
});
