/**
 * Settings › Agent behavior › Smart automation › Retry after temporary errors: one switch over
 * pref `scheduledRetry` (default on; only an explicit false turns it off).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { ScheduledRetryRow } from "./ScheduledRetryRow";

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
				<ScheduledRetryRow />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

const switchOf = () =>
	document.getElementById("setting-gui-scheduledRetry")?.querySelector('[role="switch"]') as HTMLElement | null;

beforeEach(() => {
	stored = {};
	prefs.set.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("ScheduledRetryRow", () => {
	it("is on by default, named and described, and writes a change through the prefs", async () => {
		await mount();
		expect(document.body.textContent).toContain(translate("settings.gui.scheduledRetry"));
		expect(document.body.textContent).toContain(translate("settings.gui.scheduledRetryDesc"));
		expect(switchOf()?.getAttribute("aria-checked")).toBe("true");
		await act(async () => switchOf()?.click());
		expect(prefs.set).toHaveBeenCalledWith("scheduledRetry", false);
		expect(switchOf()?.getAttribute("aria-checked")).toBe("false");
	});

	it("reads an explicit false as off", async () => {
		stored = { scheduledRetry: false };
		await mount();
		expect(switchOf()?.getAttribute("aria-checked")).toBe("false");
	});
});
