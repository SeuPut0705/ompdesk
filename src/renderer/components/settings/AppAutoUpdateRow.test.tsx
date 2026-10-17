/**
 * Settings › Updates & about › OMPdesk › Install updates automatically: off by default, writes the
 * `appAutoUpdate` pref when turned on, shows the stored choice, and in the manual install mode
 * (read-only location, App Translocation) is disabled and says why.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateInstallMode } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { AppAutoUpdateRow } from "./AppAutoUpdateRow";

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

const stored: { value: unknown; mode: UpdateInstallMode } = { value: undefined, mode: "relaunch" };
const prefsSet = vi.fn(async (_key: string, _value: unknown) => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: { get: async () => stored.value, set: prefsSet },
		updater: { installMode: async () => stored.mode },
	},
});

let root: Root | null = null;
async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<AppAutoUpdateRow />
			</I18nProvider>,
		),
	);
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}
const toggle = () => document.body.querySelector("#setting-gui-appAutoUpdate [role='switch']") as HTMLElement;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	prefsSet.mockClear();
	stored.value = undefined;
	stored.mode = "relaunch";
});

describe("AppAutoUpdateRow", () => {
	it("is off by default and writes the pref when turned on", async () => {
		await mount();
		expect(document.body.textContent).toContain(translate("updates.appAuto"));
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		await act(async () => toggle().click());
		expect(prefsSet).toHaveBeenCalledWith("appAutoUpdate", true);
		expect(toggle().getAttribute("aria-checked")).toBe("true");
	});

	it("shows a stored choice that is on", async () => {
		stored.value = true;
		await mount();
		expect(toggle().getAttribute("aria-checked")).toBe("true");
		await act(async () => toggle().click());
		expect(prefsSet).toHaveBeenCalledWith("appAutoUpdate", false);
	});

	it("is unavailable in the manual install mode and says why", async () => {
		stored.value = true;
		stored.mode = "manual";
		await mount();
		expect(toggle().getAttribute("aria-checked")).toBe("false");
		expect(toggle().hasAttribute("disabled") || toggle().getAttribute("aria-disabled") === "true").toBe(true);
		expect(document.body.textContent).toContain(translate("updates.appAutoManual"));
		await act(async () => toggle().click());
		expect(prefsSet).not.toHaveBeenCalled();
	});
});
