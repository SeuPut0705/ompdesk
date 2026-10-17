/**
 * Settings › Agent behavior › Session titles: two switches over prefs `autoTitle` / `autoTitleEvolve` (both default on),
 * the evolve one disabled under the first, each with its cost note.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { AutoTitleRow } from "./AutoTitleRow";

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

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<AutoTitleRow />
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
});

describe("AutoTitleRow", () => {
	it("shows both switches on by default and writes a change through the prefs", async () => {
		await mount();
		expect(switchOf("setting-gui-autoTitle")?.getAttribute("aria-checked")).toBe("true");
		expect(switchOf("setting-gui-autoTitleEvolve")?.getAttribute("aria-checked")).toBe("true");
		await act(async () => switchOf("setting-gui-autoTitle")?.click());
		expect(prefs.set).toHaveBeenCalledWith("autoTitle", false);
		expect(switchOf("setting-gui-autoTitle")?.getAttribute("aria-checked")).toBe("false");
	});

	it("disables the evolve switch while automatic titles are off, keeping its own value", async () => {
		stored = { autoTitle: false };
		await mount();
		expect(switchOf("setting-gui-autoTitleEvolve")?.hasAttribute("disabled")).toBe(true);
		expect(switchOf("setting-gui-autoTitleEvolve")?.getAttribute("aria-checked")).toBe("true");
		// Turned back on, the evolve switch is live again.
		await act(async () => switchOf("setting-gui-autoTitle")?.click());
		expect(prefs.set).toHaveBeenCalledWith("autoTitle", true);
		expect(switchOf("setting-gui-autoTitleEvolve")?.hasAttribute("disabled")).toBe(false);
	});

	it("writes the evolve switch under its own pref", async () => {
		await mount();
		await act(async () => switchOf("setting-gui-autoTitleEvolve")?.click());
		expect(prefs.set).toHaveBeenCalledWith("autoTitleEvolve", false);
	});

	it("says what a title costs and when the extra requests happen", async () => {
		await mount();
		expect(document.body.textContent).toContain(translate("settings.gui.autoTitleCost"));
		expect(document.body.textContent).toContain(translate("settings.gui.autoTitleEvolveCost"));
	});
});
