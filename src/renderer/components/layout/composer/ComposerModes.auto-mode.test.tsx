/**
 * The automatic mode choice in the composer: the Run popover's "Auto mode" switch (pref `autoMode`, default on,
 * with its one muted line saying it covers Plan and Goal only), the "This request: Plan" chip with its one-click undo,
 * and the Mode picker, which never shows a mode used for one request.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { ComposerModeExtras } from "./ComposerModes";
import { RunChip } from "./RunChip";

/** The Run chip with its conditional extras (the "This request" chip), as the toolbar renders them. */
function ComposerModes() {
	return (
		<>
			<RunChip />
			<ComposerModeExtras />
		</>
	);
}

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
	click: () => void;
	getAttribute: (name: string) => string | null;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

let autoModeUndo: Mock<(mode: "plan" | "goal") => Promise<RpcResponse>>;
let prefsSet: Mock<(key: string, value: unknown) => Promise<void>>;

function installMockOmp(
	stored: unknown = undefined,
	setPlanMode: Mock<(enabled: boolean) => Promise<RpcResponse>> = vi.fn(async () => success({})),
): void {
	autoModeUndo = vi.fn(async () => success({ suppressed: true }));
	prefsSet = vi.fn(async () => {});
	const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
	(window as unknown as { omp: unknown }).omp = {
		rpc: { getSettings: vi.fn(async () => success({ values: {} })), setPlanMode, autoModeUndo },
		prefs: { get: vi.fn(async () => stored), set: prefsSet },
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

const chip = () => document.querySelector("[data-auto-mode-chip]") as unknown as TestElement | null;
const trigger = () => document.querySelector("button[data-run-settings-trigger]") as unknown as TestElement;
const chipLabel = () =>
	(trigger() as unknown as { querySelector: (selector: string) => TestElement | null }).querySelector(
		".omp-composer-control-label",
	)?.textContent;
const autoSwitch = () => document.querySelector("[data-auto-mode-switch]") as unknown as TestElement | null;

async function openPopover(): Promise<void> {
	await act(async () => trigger().click());
	await flush();
}

describe("Auto mode switch in the Mode popover", () => {
	it("is on by default, says it covers Plan and Goal only, and writes the pref when turned off", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openPopover();

		expect(autoSwitch()?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.textContent).toContain(translate("input.autoMode.label"));
		expect(document.body.textContent).toContain(translate("input.autoMode.desc"));

		await act(async () => autoSwitch()?.click());
		await flush();
		expect(prefsSet).toHaveBeenCalledWith("autoMode", false);
		expect(autoSwitch()?.getAttribute("aria-checked")).toBe("false");
	});

	it("shows a stored off value", async () => {
		installMockOmp(false);
		await mount(<ComposerModes />);
		await openPopover();
		expect(autoSwitch()?.getAttribute("aria-checked")).toBe("false");
	});
});

describe("Auto chip", () => {
	it("is absent until the app picked a mode", async () => {
		installMockOmp();
		useSessionStore.setState({ planModeEnabled: true });
		await mount(<ComposerModes />);
		expect(chip()).toBeNull();
	});

	it("reads 'This request: Plan' and one click leaves plan mode through the undo command", async () => {
		installMockOmp();
		useSessionStore.setState({ planModeEnabled: true, autoMode: "plan" });
		await mount(<ComposerModes />);
		expect(chip()?.textContent).toBe(translate("input.autoMode.chip.plan"));
		expect(chip()?.textContent).toBe("This request: Plan");

		await act(async () => chip()?.click());
		await flush();
		expect(autoModeUndo).toHaveBeenCalledWith("plan");
		expect(useSessionStore.getState()).toMatchObject({ planModeEnabled: false, autoMode: null });
		expect(chip()).toBeNull();
	});

	it("reads 'This request: Goal' and undoes the goal", async () => {
		installMockOmp();
		useSessionStore.setState({ goal: { objective: "ship it" }, goalState: { status: "active" }, autoMode: "goal" });
		await mount(<ComposerModes />);
		expect(chip()?.textContent).toBe("This request: Goal");
		await act(async () => chip()?.click());
		await flush();
		expect(autoModeUndo).toHaveBeenCalledWith("goal");
		expect(useSessionStore.getState()).toMatchObject({ goal: null, goalState: null, autoMode: null });
	});
});

describe("the Mode picker and a mode used for one request", () => {
	const planSwitch = () => document.querySelector("[data-plan-mode]") as unknown as TestElement | null;

	it("keeps the picker on the user's own modes: an automatic plan or goal never shows in it", async () => {
		installMockOmp();
		useSessionStore.setState({ planModeEnabled: true, autoMode: "plan" });
		await mount(<ComposerModes />);
		expect(trigger().getAttribute("data-active")).toBeNull();
		expect(chipLabel()).toBe(translate("input.runSettings.title"));
		await openPopover();
		expect(planSwitch()?.getAttribute("aria-checked")).toBe("false");
		await act(async () => root.unmount());

		useSessionStore.getState().reset();
		useSessionStore.setState({ goal: { objective: "ship it" }, goalState: { status: "active" }, autoMode: "goal" });
		await mount(<ComposerModes />);
		expect(trigger().getAttribute("data-active")).toBeNull();
	});

	it("shows the user's own plan mode as before", async () => {
		installMockOmp();
		useSessionStore.setState({ planModeEnabled: true, autoMode: null });
		await mount(<ComposerModes />);
		expect(trigger().getAttribute("data-active")).toBe("");
		expect(chipLabel()).toBe(translate("input.modes.tab.plan"));
		expect(chip()).toBeNull();
	});

	it("turning Plan on over an automatic plan makes it the user's own (a manual mode wins)", async () => {
		const setPlanMode = vi.fn(async (_enabled: boolean) => success({ enabled: true }));
		installMockOmp(undefined, setPlanMode);
		useSessionStore.setState({ planModeEnabled: true, autoMode: "plan" });
		await mount(<ComposerModes />);
		await openPopover();
		await act(async () => planSwitch()?.click());
		await flush();
		expect(setPlanMode).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState()).toMatchObject({ planModeEnabled: true, autoMode: null });
		expect(chip()).toBeNull();
		expect(trigger().getAttribute("data-active")).toBe("");
	});

	it("goes away by itself when the mode ends another way", async () => {
		installMockOmp();
		useSessionStore.setState({ planModeEnabled: true, autoMode: "plan" });
		await mount(<ComposerModes />);
		expect(chip()).not.toBeNull();
		await act(async () => useSessionStore.setState({ planModeEnabled: false }));
		await flush();
		expect(chip()).toBeNull();
		expect(useSessionStore.getState().autoMode).toBeNull();
	});
});
