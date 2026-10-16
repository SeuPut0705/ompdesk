/**
 * Settings › Agent behavior › Suggestions: two switches over prefs
 * `nextPromptSuggestions` / `nextPromptInline` (both default on), the inline one
 * disabled under the first; the cost note names the model once the active tab's
 * bridge reports it, and warns about a loaded legacy extension.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextPromptState } from "../../../../resources/gui-bridge/modes/next-prompt-contracts";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { NextPromptRow } from "./NextPromptRow";

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

let stored: Record<string, unknown> = {};
const prefs = {
	get: vi.fn(async (key?: string): Promise<unknown> => (key ? stored[key] : undefined)),
	set: vi.fn(async (key: string, value: unknown): Promise<void> => {
		stored[key] = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { prefs } });

let root: Root | undefined;

const state = (patch: Partial<NextPromptState> = {}): NextPromptState => ({
	suggestions: true,
	inline: true,
	legacyExtension: false,
	requests: { suggest: 0, inline: 0 },
	...patch,
});

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<NextPromptRow />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

const row = (id: string) => document.getElementById(id) as HTMLElement | null;
const switchOf = (id: string) => row(id)?.querySelector('[role="switch"]') as HTMLElement | null;

beforeEach(() => {
	stored = {};
	prefs.get.mockClear();
	prefs.set.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useSessionStore.setState({ nextPrompt: null });
});

describe("NextPromptRow", () => {
	it("shows both switches on by default and writes a change through the prefs", async () => {
		await mount();
		expect(switchOf("setting-gui-nextPromptSuggestions")?.getAttribute("aria-checked")).toBe("true");
		expect(switchOf("setting-gui-nextPromptInline")?.getAttribute("aria-checked")).toBe("true");
		await act(async () => switchOf("setting-gui-nextPromptSuggestions")?.click());
		expect(prefs.set).toHaveBeenCalledWith("nextPromptSuggestions", false);
		expect(switchOf("setting-gui-nextPromptSuggestions")?.getAttribute("aria-checked")).toBe("false");
	});

	it("disables the inline switch while suggestions are off", async () => {
		stored = { nextPromptSuggestions: false };
		await mount();
		expect(switchOf("setting-gui-nextPromptInline")?.hasAttribute("disabled")).toBe(true);
		expect(switchOf("setting-gui-nextPromptInline")?.getAttribute("aria-checked")).toBe("true");
	});

	it("writes the inline switch under its own pref", async () => {
		await mount();
		await act(async () => switchOf("setting-gui-nextPromptInline")?.click());
		expect(prefs.set).toHaveBeenCalledWith("nextPromptInline", false);
	});

	it("names the small model once the active tab reports it, and omits it before", async () => {
		await mount();
		expect(document.body.textContent).toContain(translate("settings.gui.nextPromptCost"));
		expect(document.body.textContent).not.toContain("acme/small-1");
		await act(async () => {
			useSessionStore.setState({ nextPrompt: state({ model: { model: "acme/small-1", role: "smol" } }) });
		});
		expect(document.body.textContent).toContain(translate("settings.gui.nextPromptModel", { model: "acme/small-1" }));
	});

	it("shows the legacy-extension line only when the tab reports it", async () => {
		await mount();
		expect(document.querySelector("[data-next-prompt-legacy]")).toBeNull();
		await act(async () => {
			useSessionStore.setState({ nextPrompt: state({ legacyExtension: true }) });
		});
		expect(document.querySelector("[data-next-prompt-legacy]")?.textContent).toBe(
			translate("settings.gui.nextPromptLegacy"),
		);
	});
});
