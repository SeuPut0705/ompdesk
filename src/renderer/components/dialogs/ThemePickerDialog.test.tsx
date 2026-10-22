/** The theme picker's list is a listbox its search field drives: no theme is a tab stop of its own. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { ThemePickerDialog } from "./ThemePickerDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

let root: Root | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.setState({ themePickerOpen: false });
	vi.useRealTimers();
});

describe("ThemePickerDialog", () => {
	it("lists the themes as options of a listbox the search field points into", async () => {
		useUiStore.setState({ themePickerOpen: true });
		root = createRoot(document.body as unknown as globalThis.Element);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<ThemePickerDialog />
				</I18nProvider>,
			);
		});
		const listbox = document.body.querySelector('[role="listbox"]');
		expect(listbox).not.toBeNull();
		const options = Array.from(document.body.querySelectorAll('[role="option"]'));
		expect(options.length).toBeGreaterThan(5);
		expect(options.every(option => option.getAttribute("tabindex") === "-1")).toBe(true);
		const field = document.body.querySelector(`input[aria-label="${translate("themePicker.search")}"]`);
		expect(field?.getAttribute("aria-controls")).toBe(listbox?.id);
		expect(field?.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
		// The light and dark themes sit in named groups, as the command palette's categories do.
		const groups = Array.from(document.body.querySelectorAll('[role="listbox"] > [role="group"]'));
		expect(groups.map(group => group.getAttribute("aria-label"))).toEqual([
			translate("themePicker.group.light"),
			translate("themePicker.group.dark"),
		]);
		expect(groups.every(group => group.querySelectorAll('[role="option"]').length >= 5)).toBe(true);
	});
});
