/**
 * Contract tests for the composer mode chip: the chip names the active
 * session mode(s) in the accent, its popover holds Plan · Goal
 * as segmented tabs (active ones marked), Plan toggles inline, and the
 * app-wide `openModes(tab)` request opens the popover on that tab.
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
import { ComposerModes } from "./ComposerModes";

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
	const button = document.querySelector("button[data-composer-modes-trigger]") as unknown as TestElement | null;
	if (!button) throw new Error("mode chip missing");
	return button;
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
		await mount(<ComposerModes />);

		const modes = (["plan", "goal"] as const).map(mode => translate(`input.modes.name.${mode}`)).join(" · ");
		expect(trigger().textContent).toBe(modes);
		expect(trigger().getAttribute("aria-label")).toBe(translate("input.modes.activeTitle", { modes }));
		expect(trigger().className).toContain("bg-(--sc-accent-soft)");

		await act(async () => trigger().click());
		await flush();

		for (const name of ["Plan", "Goal"]) {
			expect(tab(name)?.textContent).toBe(`${name}on`);
		}
		// Opens on the first active mode: Plan, whose switch is on.
		expect(tab("Plan")?.getAttribute("aria-selected")).toBe("true");
		expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
	});

	it("stays a quiet 'Mode' chip with nothing active and toggles plan mode inline", async () => {
		installMockOmp();
		await mount(<ComposerModes />);

		expect(trigger().textContent).toBe("Mode");
		expect(trigger().className).not.toContain("bg-(--sc-accent-soft)");

		await act(async () => trigger().click());
		await flush();
		for (const name of ["Plan", "Goal"]) expect(tab(name)?.textContent).toBe(name);
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
		await mount(<ComposerModes />);

		await act(async () => useUiStore.getState().openModes("goal"));
		await flush();

		expect(trigger().getAttribute("aria-expanded")).toBe("true");
		expect(tab("Goal")?.getAttribute("aria-selected")).toBe("true");

		await act(async () => trigger().click());
		expect(trigger().getAttribute("aria-expanded")).toBe("false");
		expect(useUiStore.getState().modesOpen).toBe(false);
	});
});
