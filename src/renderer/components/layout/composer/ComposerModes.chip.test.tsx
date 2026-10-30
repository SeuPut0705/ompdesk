/**
 * Contract tests for the Run chip's Mode section: the chip names the active session mode(s) and paints
 * itself accent through `data-active`, its popover holds Plan · Goal · Autopilot as segmented tabs (active
 * ones marked), Plan toggles inline, and the app-wide `openModes(tab)` request opens the popover on that tab.
 * State comes from the session store.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { RunChip } from "./RunChip";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	className: string;
	click: () => void;
	getAttribute: (name: string) => string | null;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

let setPlanMode: Mock<(enabled: boolean) => Promise<RpcResponse>>;

/** The mode configs subscribe to sidecar events while mounted; every subscription is a no-op here. */
function installMockOmp(): void {
	setPlanMode = vi.fn(async (enabled: boolean) => success({ enabled }));
	const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			getSettings: vi.fn(async () => success({ values: {} })),
			setPlanMode,
		},
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		events,
	};
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useUiStore.setState({ modesOpen: false, modesTab: "plan" });
});

function trigger(): TestElement {
	const button = document.querySelector("button[data-run-settings-trigger]") as unknown as TestElement | null;
	if (!button) throw new Error("Run chip missing");
	return button;
}

/** The chip's visible words (the label span), without its count badge and glyphs. */
function chipText(): string | null | undefined {
	return (trigger() as unknown as { querySelector: (s: string) => TestElement | null }).querySelector(
		".omp-composer-control-label",
	)?.textContent;
}

function tab(name: string): TestElement | undefined {
	const tabs = Array.from(document.querySelectorAll('[role="tab"]')) as unknown as TestElement[];
	return tabs.find(element => element.textContent?.startsWith(name));
}

describe("Composer mode chip", () => {
	it("names every active mode in an accent chip and marks them in the popover", async () => {
		installMockOmp();
		useSessionStore.setState({
			planModeEnabled: true,
			goal: { objective: "Ship the activity dock" },
			goalState: { status: "active" },
		});
		await mount(<RunChip />);

		const summary = (["plan", "goal"] as const).map(mode => translate(`input.modes.tab.${mode}`)).join(" · ");
		const named = (["plan", "goal"] as const).map(mode => translate(`input.modes.name.${mode}`)).join(" · ");
		expect(chipText()).toBe(summary);
		expect(trigger().getAttribute("aria-label")).toContain(named);
		// Accent is a data attribute with a CSS rule, never a utility class that has to win a tie (DR-1).
		expect(trigger().getAttribute("data-active")).toBe("");
		expect(trigger().className).not.toContain("bg-(--sc-accent-soft)");

		await act(async () => trigger().click());
		await flush();

		expect(tab("Goal")?.textContent).toBe("Goalon");
		expect(tab("Plan")).toBeUndefined();
		// Plan is the switch above the tabs, on; the open tab is a form's and says nothing about Plan.
		expect(tab("Goal")?.getAttribute("aria-selected")).toBe("true");
		expect(document.querySelector("[data-plan-mode]")?.getAttribute("aria-checked")).toBe("true");
	});

	it("counts a paused goal as the session's goal, as goalIsActive does", async () => {
		// Composer audit L9: the chip read only `active`, the auto-mode guard also `paused`, so the two disagreed.
		installMockOmp();
		useSessionStore.setState({ goal: null, goalState: { status: "paused" } });
		await mount(<RunChip />);
		expect(chipText()).toBe(translate("input.modes.tab.goal"));
	});

	it("stays a quiet 'Run settings' chip with nothing active and toggles plan mode inline", async () => {
		installMockOmp();
		await mount(<RunChip />);

		expect(chipText()).toBe(translate("input.runSettings.title"));
		expect(trigger().getAttribute("data-active")).toBeNull();

		await act(async () => trigger().click());
		await flush();
		const tabNames = (Array.from(document.querySelectorAll('[role="tab"]')) as unknown as TestElement[]).map(
			element => element.textContent,
		);
		expect(tabNames).toEqual(["Goal", "Autopilot"]);
		// Plan has no form: with no Goal or Autopilot open, no tab reads as chosen and no form is drawn.
		expect(document.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
		expect(tab("Loop")).toBeUndefined();
		expect(tab("Vibe")).toBeUndefined();
		expect(tab("Ratchet")).toBeUndefined();

		const planSwitch = document.querySelector('[role="switch"]') as unknown as TestElement | null;
		expect(planSwitch?.getAttribute("aria-checked")).toBe("false");
		await act(async () => planSwitch?.click());
		await flush();

		expect(setPlanMode).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
	});

	it("answers openModes(tab) by opening the popover on that mode, and clears the request on close", async () => {
		installMockOmp();
		await mount(<RunChip />);

		await act(async () => useUiStore.getState().openModes("goal"));
		await flush();

		expect(trigger().getAttribute("aria-expanded")).toBe("true");
		expect(tab("Goal")?.getAttribute("aria-selected")).toBe("true");

		await act(async () => trigger().click());
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		expect(useUiStore.getState().modesOpen).toBe(false);
	});
});
