/** Settings › Agent: the advisor row's "Set up automatically" opens the model setup assistant. */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingEntry } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { AgentModes } from "./AgentModes";
import { type SettingsData, SettingsDataProvider } from "./settings-data";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	useUiStore.getState().closeModelSetup();
});

const advisor: SettingEntry = { path: "advisor.enabled", type: "boolean", value: false, default: false };

describe("AgentModes", () => {
	it("opens the model setup assistant from the advisor row", async () => {
		const data: SettingsData = {
			schema: { tabs: [{ id: "interaction", label: "Interaction", groups: [] }], entries: [advisor] },
			values: { "advisor.enabled": false },
			loadState: "ready",
			loadError: null,
			sidecarReady: true,
			sidecarBusy: false,
			advisorActive: false,
			onCommitted: () => {},
			retry: () => {},
		};
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<SettingsDataProvider value={data}>
						<AgentModes />
					</SettingsDataProvider>
				</I18nProvider>,
			),
		);
		const open = Array.from(document.querySelectorAll("button")).find(
			button => button.textContent?.trim() === translate("modelSetup.open"),
		);
		expect(open).toBeDefined();
		expect(open?.closest('[id="setting-advisor.enabled"]')).not.toBeNull();
		await act(async () => (open as unknown as HTMLButtonElement).click());
		expect(useUiStore.getState().modelSetupOpen).toBe(true);
	});

	it("has no action rows for goal mode, autopilot or the agents page", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<SettingsDataProvider
						value={{
							schema: { tabs: [], entries: [advisor] },
							values: { "advisor.enabled": false },
							loadState: "ready",
							loadError: null,
							sidecarReady: true,
							sidecarBusy: false,
							advisorActive: false,
							onCommitted: () => {},
							retry: () => {},
						}}
					>
						<AgentModes />
					</SettingsDataProvider>
				</I18nProvider>,
			),
		);
		const text = container.textContent ?? "";
		for (const label of ["Start a goal", "Goal mode", "Autopilot", "Subagents", "Open Agents"]) {
			expect(Array.from(container.querySelectorAll("button")).map(b => b.textContent?.trim())).not.toContain(label);
			expect(text).not.toContain(`${label}Open`);
		}
		expect(container.querySelector("#setting-advisor\\.enabled")).not.toBeNull();
	});
});
