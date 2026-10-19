/**
 * The toolbar on a phone: one row under the full-width field, every control inside the box (+, the Run chip, the model
 * chip, the context ring, Stop/Send) and no ⋯ fold toggle; Thinking and Delegation live in the Run sheet, never as
 * icons of their own; the empty Send slot is the mic while dictation is on (1 tap); every touch control keeps focus
 * in the field (a cancelled `mousedown`). The layout itself (grid, 44 px reach) is
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
		getJobs: vi.fn(async () => ok({ rows: [] })),
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
		expect(await cancelsMouseDown(q(".omp-composer-scroll > :first-child, [aria-haspopup='menu']"))).toBe(true);
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

	it("never puts the run settings in the + sheet, even with the keyboard up", async () => {
		document.documentElement.setAttribute("data-kb", "open");
		await render();
		await act(async () => plus().click());
		expect(menuItems().some(label => label.includes(translate("input.runSettings.approval")))).toBe(false);
		expect(menuItems().some(label => label.includes(translate("input.model")))).toBe(false);
	});

	it("shows every run control in the box's one row: Run chip, model chip, context ring, no ⋯ toggle", async () => {
		useSessionStore.setState({ contextUsage: { contextWindow: 200_000, percent: 30, tokens: 60_000 } });
		await render();
		expect(q("[data-run-settings-trigger]")).not.toBeNull();
		expect(q("[data-model-chip]")).not.toBeNull();
		const ring = q(".omp-context-usage-trigger");
		expect(ring).not.toBeNull();
		expect(ring?.closest(".omp-composer-send-cluster")).not.toBeNull();
		// A ring, no percentage text; the reading is its name.
		expect(ring?.textContent).toBe("");
		expect(ring?.getAttribute("aria-label")).toBe(
			translate("contextUsage.ring", { percent: 30, used: "60.0k", window: "200.0k" }),
		);
		expect(await cancelsMouseDown(ring)).toBe(true);
		expect(q("[data-run-more]")).toBeNull();
	});

	it("draws no Thinking or Delegation icon beside the Run chip: both are in its sheet and its name", async () => {
		useSessionStore.setState({ status: "ready" });
		useModelStore.setState({
			model: { provider: "acme", id: "m", name: "Model" } as never,
			availableThinkingLevels: ["low", "medium", "high"],
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
		});
		const omp = Reflect.get(window, "omp") as unknown as {
			rpc: { getDelegation: { mockResolvedValue(value: unknown): void } };
		};
		omp.rpc.getDelegation.mockResolvedValue(ok({ mode: "assisted" }));
		await render();
		await act(async () => {});
		expect(q(".lucide-brain")).toBeNull();
		expect(q(".lucide-network")).toBeNull();
		const run = q("[data-run-settings-trigger]");
		expect(run?.getAttribute("aria-label")).toContain(translate("input.delegation.mode.assisted"));
		expect(run?.getAttribute("aria-label")).toContain(
			translate("input.runSettings.summaryThinking", { level: translate("input.thinking.name.medium") }),
		);
		await act(async () => run?.click());
		expect(document.querySelector("[data-delegation-option]")).not.toBeNull();
		expect(q("[data-model-chip] [data-provider-mark]")).not.toBeNull();
	});

	it("keeps the + sheet from taking focus (its overlay cancels mousedown too)", async () => {
		await render();
		await act(async () => plus().click());
		expect(await cancelsMouseDown(document.querySelector("[data-action-sheet]"))).toBe(true);
	});
});
