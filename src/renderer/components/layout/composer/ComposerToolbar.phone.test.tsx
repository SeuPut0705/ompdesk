/**
 * The toolbar on a phone: `[+] [field] [Send | mic]` and nothing else of its own. No ⋯ toggle, no model chip, context
 * ring, Run chip trigger copies in the visible row; the empty Send slot is the mic while dictation is on (1 tap); while
 * the status chip row has no room (soft keyboard up) the `+` sheet carries Model / Mode / Tool approval / Delegation;
 * every touch control keeps focus in the field (a cancelled `mousedown`). The layout itself (grid, 44 px reach) is
 * measured in e2e/mobile-composer.e2e.ts.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ShellMode from "../../../hooks/use-shell-mode";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useSettingsStore } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import type { ComposerToolbarProps } from "./ComposerToolbar";

vi.mock("../../../hooks/use-shell-mode", async importOriginal => ({
	...(await importOriginal<typeof ShellMode>()),
	useShellMode: () => "phone",
	useShellInput: () => "touch",
}));

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
Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
const ok = (data: unknown) => ({ type: "response", command: "x", success: true, data });
Reflect.set(window, "omp", {
	rpc: {
		getJobs: vi.fn(async () => ok({ jobs: [] })),
		getSettings: vi.fn(async () => ok({ values: {} })),
		getDelegation: vi.fn(async () => ok({ mode: "default" })),
	},
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
	events,
});

const { createRoot } = await import("react-dom/client");
const { ComposerToolbar } = await import("./ComposerToolbar");

let container: HTMLElement;
let root: Root;

const baseProps: ComposerToolbarProps = {
	routeReady: true,
	touchInput: true,
	expanded: false,
	onToggleExpanded: () => {},
	onOpenFilePicker: () => {},
	fileInputRef: { current: null },
	onFilesPicked: () => {},
	onOpenHistory: () => {},
	onOpenSkills: () => {},
	composerMode: undefined,
	queued: false,
	queueSplitCount: 0,
	dictationPhase: "idle",
	onMic: () => {},
	onStopAndSend: () => {},
	followUp: false,
	onToggleSendMode: () => {},
	stoppable: false,
	showSend: true,
	sendDisabled: true,
	onStop: () => {},
	onSend: () => {},
	onOpenRunSheet: () => {},
};

async function render(props: Partial<ComposerToolbarProps> = {}): Promise<void> {
	if (!container) {
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
	}
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComposerToolbar {...baseProps} {...props} />
			</I18nProvider>,
		);
	});
	await act(async () => {});
}

const q = (selector: string) => container.querySelector(selector) as unknown as HTMLElement | null;
const slot = (name: string) => q(`[data-slot="${name}"]`) as unknown as HTMLElement;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	container = undefined as never;
	document.body.innerHTML = "";
	document.documentElement.removeAttribute("data-kb");
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useSettingsStore.setState({ sttEnabled: false, approvalMode: "yolo" });
	useUiStore.setState({ modelPickerOpen: false, modesOpen: false });
});

async function cancelsMouseDown(element: Element | null): Promise<boolean> {
	const down = new Event("mousedown", { bubbles: true, cancelable: true });
	await act(async () => element?.dispatchEvent(down));
	return (down as unknown as { defaultPrevented: boolean }).defaultPrevented;
}

describe("phone toolbar", () => {
	it("has no ⋯ toggle and none of the controls the status chip row owns", async () => {
		await render();
		expect(q(".omp-composer-more")).toBeNull();
		expect(q("[data-more-open]")).toBeNull();
		expect(q("[data-model-chip]")).toBeNull();
		expect(q(".omp-context-usage-trigger")).toBeNull();
		expect(q("[data-auto-mode-chip]")).toBeNull();
		expect(container.querySelector('[aria-label="Mode, model and more"]')).toBeNull();
	});

	it("shows a mic in the empty Send slot while dictation is on, and Send once there is a draft", async () => {
		useSettingsStore.setState({ sttEnabled: true });
		const onMic = vi.fn();
		await render({ onMic });
		const mic = slot("send").querySelector(".omp-composer-mic") as unknown as HTMLElement;
		expect(mic).not.toBeNull();
		expect(mic.getAttribute("aria-label")).toBe(translate("voice.mic.start"));
		expect(slot("send").querySelector("[data-send-lane], .omp-composer-action:not(.omp-composer-mic)")).toBeNull();
		await act(async () => mic.click());
		expect(onMic).toHaveBeenCalledTimes(1);

		await render({ sendDisabled: false, onMic });
		expect(slot("send").querySelector(".omp-composer-mic")).toBeNull();
		expect(slot("send").querySelector(`[aria-label="${translate("input.send")}"]`)).not.toBeNull();
	});

	it("keeps the empty Send slot a disabled Send when dictation is off", async () => {
		await render();
		expect(slot("send").querySelector(".omp-composer-mic")).toBeNull();
		expect(slot("send").querySelector("button")?.hasAttribute("disabled")).toBe(true);
	});

	it("keeps focus in the field: +, Send, Stop, the lane chip and the mic cancel their mousedown", async () => {
		useSettingsStore.setState({ sttEnabled: true });
		useSessionStore.setState({ isStreaming: true });
		await render({ stoppable: true, sendDisabled: false });
		expect(await cancelsMouseDown(q(".omp-composer-toolbar > :first-child, [aria-haspopup='menu']"))).toBe(true);
		expect(await cancelsMouseDown(slot("send").querySelector("button"))).toBe(true);
		expect(await cancelsMouseDown(slot("stop").querySelector("button"))).toBe(true);
		expect(await cancelsMouseDown(q("[data-send-mode]"))).toBe(true);
		await render({ stoppable: true, sendDisabled: true });
		expect(await cancelsMouseDown(slot("send").querySelector(".omp-composer-mic"))).toBe(true);
		// Never on pointerdown: WebKit would drop the click that follows.
		const pointer = new Event("pointerdown", { bubbles: true, cancelable: true });
		await act(async () => slot("send").querySelector("button")?.dispatchEvent(pointer));
		expect((pointer as unknown as { defaultPrevented: boolean }).defaultPrevented).toBe(false);
	});

	const plus = () => q("[aria-haspopup='menu']") as unknown as HTMLElement;
	const menuItems = () =>
		Array.from(document.querySelectorAll("[role='menu'] [data-menu-item]")).map(item => item.textContent ?? "");

	it("leaves the run settings out of the + sheet while the chip row has room", async () => {
		await render();
		await act(async () => plus().click());
		expect(menuItems().some(label => label.includes(translate("input.runSettings.approval")))).toBe(false);
		expect(menuItems().some(label => label.includes(translate("input.delegation.title")))).toBe(false);
	});

	it("offers Model / Mode / Tool approval / Delegation in the + sheet while the chip row is hidden", async () => {
		document.documentElement.setAttribute("data-kb", "open");
		useSettingsStore.setState({ approvalMode: "write" });
		const onOpenRunSheet = vi.fn();
		await render({ onOpenRunSheet });
		await act(async () => plus().click());
		const labels = menuItems();
		for (const key of [
			"input.model",
			"input.modes.label",
			"input.runSettings.approval",
			"input.delegation.title",
		] as const) {
			expect(
				labels.some(label => label.includes(translate(key))),
				key,
			).toBe(true);
		}
		// The live values ride on the rows.
		expect(labels.find(label => label.includes(translate("input.runSettings.approval")))).toContain(
			translate("input.approval.write"),
		);
		const rows = Array.from(document.querySelectorAll("[role='menu'] [data-menu-item]")) as unknown as HTMLElement[];
		const find = (key: Parameters<typeof translate>[0]) =>
			rows.find(row => row.textContent?.includes(translate(key)));
		await act(async () => find("input.delegation.title")?.click());
		expect(onOpenRunSheet).toHaveBeenCalledTimes(1);
	});

	it("opens the model picker and the Mode popover from the + sheet's rows", async () => {
		document.documentElement.setAttribute("data-kb", "open");
		await render();
		await act(async () => plus().click());
		const rows = Array.from(document.querySelectorAll("[role='menu'] [data-menu-item]")) as unknown as HTMLElement[];
		await act(async () => rows.find(row => row.textContent?.includes(translate("input.model")))?.click());
		expect(useUiStore.getState().modelPickerOpen).toBe(true);
		await act(async () => plus().click());
		const again = Array.from(document.querySelectorAll("[role='menu'] [data-menu-item]")) as unknown as HTMLElement[];
		await act(async () => again.find(row => row.textContent?.includes(translate("input.modes.label")))?.click());
		expect(useUiStore.getState().modesOpen).toBe(true);
	});

	it("keeps the + sheet from taking focus (its overlay cancels mousedown too)", async () => {
		await render();
		await act(async () => plus().click());
		expect(await cancelsMouseDown(document.querySelector("[data-action-sheet]"))).toBe(true);
	});
});
