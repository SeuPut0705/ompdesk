/**
 * A risky switch (Settings › Permissions: secret hiding off, project MCP
 * servers on, …) never flips on the click alone: the row asks to accept the
 * risk first, and only Accept writes the value. The safe direction applies
 * at once.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { RISKY_SETTINGS } from "./SchemaSettingRow";
import { SettingsSwitchRow } from "./SettingsLayout";
import { schemaSettingText } from "./schema-i18n";

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

const RISK = { value: false, warning: "Secrets reach the model unmasked." };
let root: Root | undefined;

async function mount(checked: boolean, onCheckedChange: (next: boolean) => void): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SettingsSwitchRow checked={checked} label="Hide secrets" onCheckedChange={onCheckedChange} risk={RISK} />
			</I18nProvider>,
		);
	});
}

const toggle = () => document.querySelector('[role="switch"]') as HTMLElement | null;
const button = (label: string) =>
	[...document.querySelectorAll("button")].find(node => node.textContent?.trim() === label) as HTMLElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("SettingsSwitchRow risk confirm", () => {
	it("holds the switch until the risk is accepted, then writes the risky value", async () => {
		const change = vi.fn();
		await mount(true, change);
		await act(async () => toggle()?.click());
		expect(change).not.toHaveBeenCalled();
		expect(toggle()?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.textContent).toContain(RISK.warning);
		await act(async () => button(translate("settings.risk.accept"))?.click());
		expect(change).toHaveBeenCalledWith(false);
		expect(document.body.textContent).not.toContain(RISK.warning);
	});

	it("drops the request on Cancel without writing", async () => {
		const change = vi.fn();
		await mount(true, change);
		await act(async () => toggle()?.click());
		await act(async () => button(translate("common.cancel"))?.click());
		expect(change).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain(RISK.warning);
	});

	it("applies the safe direction at once", async () => {
		const change = vi.fn();
		await mount(false, change);
		await act(async () => toggle()?.click());
		expect(change).toHaveBeenCalledWith(true);
		expect(document.body.textContent).not.toContain(RISK.warning);
	});
});

describe("RISKY_SETTINGS", () => {
	it("names stock settings the Korean schema text knows, each with a translated warning", () => {
		for (const [path, { warning }] of Object.entries(RISKY_SETTINGS)) {
			expect(schemaSettingText("ko", path), path).toBeDefined();
			expect(translate(warning), path).not.toBe(warning);
		}
	});
});
