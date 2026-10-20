/**
 * Settings › Appearance › Thinking: one choice, hidden / collapsed / expanded, over the two stored axes
 * (`displayPreferences.hideThinkingBlock`, which ⌃T toggles and which follows omp's own setting until chosen, and
 * `thinkingExpanded`, the open state a shown block starts in). What is already stored reads as: hidden if hiding
 * was on, else expanded if expanding was on, else collapsed.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { ThinkingDisplayRow } from "./ThinkingDisplayRow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const set = vi.fn(async (_key: string, _value: unknown) => true);
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs: { get: async () => undefined, set } } });

let root: Root | null = null;

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ThinkingDisplayRow />
			</I18nProvider>,
		);
	});
}

const select = () => document.body.querySelector("#setting-gui-thinkingDisplay select") as HTMLSelectElement;
const chosen = () =>
	(Array.from(select().querySelectorAll("option")) as HTMLOptionElement[]).find(option => option.selected)?.value;

async function choose(value: string): Promise<void> {
	for (const item of Array.from(select().querySelectorAll("option")) as HTMLOptionElement[]) {
		if (item.value === value) item.setAttribute("selected", "");
		else item.removeAttribute("selected");
	}
	await act(async () => {
		select().dispatchEvent(new Event("change", { bubbles: true }));
	});
}

beforeEach(() => {
	set.mockClear();
	useUiStore.setState({ displayPreferences: {}, thinkingExpanded: false });
	useSettingsStore.setState({ hideThinkingBlock: false });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	useUiStore.setState({ displayPreferences: {}, thinkingExpanded: false });
	useSettingsStore.setState({ hideThinkingBlock: false });
});

describe("ThinkingDisplayRow", () => {
	it.each([
		{ hide: true, expanded: true, expected: "hidden" },
		{ hide: true, expanded: false, expected: "hidden" },
		{ hide: false, expanded: true, expected: "expanded" },
		{ hide: false, expanded: false, expected: "collapsed" },
		{ hide: null, expanded: true, expected: "expanded" },
	])("reads stored hide=$hide expand=$expanded as $expected", async ({ hide, expanded, expected }) => {
		useUiStore.setState({ displayPreferences: { hideThinkingBlock: hide }, thinkingExpanded: expanded });
		await mount();
		expect(chosen()).toBe(expected);
	});

	it("follows omp's own hide setting until a choice is made", async () => {
		useSettingsStore.setState({ hideThinkingBlock: true });
		await mount();
		expect(chosen()).toBe("hidden");
	});

	it("writes both axes for a shown choice and keeps the open state when hiding", async () => {
		await mount();
		await choose("expanded");
		expect(set).toHaveBeenCalledWith("displayPreferences.hideThinkingBlock", false);
		expect(set).toHaveBeenCalledWith("thinkingExpanded", true);
		expect(useUiStore.getState().thinkingExpanded).toBe(true);
		expect(chosen()).toBe("expanded");

		set.mockClear();
		await choose("hidden");
		expect(set).toHaveBeenCalledWith("displayPreferences.hideThinkingBlock", true);
		expect(set).not.toHaveBeenCalledWith("thinkingExpanded", expect.anything());
		expect(chosen()).toBe("hidden");

		set.mockClear();
		await choose("collapsed");
		expect(set).toHaveBeenCalledWith("displayPreferences.hideThinkingBlock", false);
		expect(set).toHaveBeenCalledWith("thinkingExpanded", false);
		expect(chosen()).toBe("collapsed");
	});
});
