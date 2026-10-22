/** Ctrl+R history search: its results are listbox options the field drives, never tab stops of their own. */

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
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

const { createRoot } = await import("react-dom/client");
const { HistorySearchOverlay } = await import("./HistorySearchOverlay");
const { useInputHistoryStore } = await import("../../../stores/input-history");

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("HistorySearchOverlay", () => {
	it("lists every result as an option the field drives, none a tab stop", async () => {
		const rows = ["fix the sidebar", "run the checks", "ship it"].map((prompt, index) => ({
			prompt,
			ts: index + 1,
			cwd: "/project",
		}));
		useInputHistoryStore.setState({ search: vi.fn(async () => rows) } as never);
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as globalThis.Element);
		await act(async () => {
			root?.render(
				createElement(
					I18nProvider,
					null,
					createElement(HistorySearchOverlay, { cwd: "/project", onSelect: vi.fn(), onClose: vi.fn() }),
				),
			);
		});
		const options = Array.from(document.querySelectorAll("[role=option]"));
		expect(options).toHaveLength(3);
		expect(options.map(option => option.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1"]);
		expect(options.map(option => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
	});
});
