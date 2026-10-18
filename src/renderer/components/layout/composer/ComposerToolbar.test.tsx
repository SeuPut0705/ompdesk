/**
 * The toolbar's own contracts: Steer/Follow-up, Stop and Send live in RESERVED slots that never unmount (a turn
 * starting or ending, or a draft appearing, moves nothing), the dictation "Stop and send" arrow takes the Send
 * slot, the model chip says `Model · Thinking`, and the tooltips carry their chords. The pixel claims (height,
 * x/y of the left controls, accent colour) are measured in e2e/composer-toolbar.e2e.ts.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../../lib/i18n";
import { composerFollowUpChord, formatShortcut } from "../../../lib/keymap";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useSettingsStore } from "../../../stores/settings";
import { useTabsStore } from "../../../stores/tabs";
import type { ComposerToolbarProps } from "./ComposerToolbar";

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
	touchInput: false,
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
	sendDisabled: false,
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

const slot = (name: string) => container.querySelector(`[data-slot="${name}"]`) as unknown as HTMLElement;
const SLOTS = ["steer", "stop", "send"] as const;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	container = undefined as never;
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useSettingsStore.setState({ sttEnabled: false });
	useTabsStore.getState().reset();
});

/** Hover the element past the tooltip delay and return the bubble's text. */
async function tooltipOf(element: Element | null | undefined): Promise<string> {
	await act(async () => {
		element?.dispatchEvent(new Event("pointerover", { bubbles: true }));
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 520);
		await promise;
	});
	return document.querySelector('[role="tooltip"]')?.textContent ?? "";
}

describe("reserved slots", () => {
	it("keeps steer, Stop and Send mounted, and the same nodes, while a turn starts and ends", async () => {
		await render();
		const before = SLOTS.map(slot);
		expect(before.every(Boolean)).toBe(true);
		// Idle: steer and Stop are off (inert and hidden), Send is on.
		expect(slot("steer").hasAttribute("data-off")).toBe(true);
		expect(slot("steer").hasAttribute("inert")).toBe(true);
		expect(slot("stop").hasAttribute("data-off")).toBe(true);
		expect(slot("stop").hasAttribute("inert")).toBe(true);
		expect(slot("send").hasAttribute("data-off")).toBe(false);

		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, showSend: false, sendDisabled: true });
		expect(SLOTS.map(slot)).toEqual(before);
		for (const name of ["steer", "stop"]) {
			expect(slot(name).hasAttribute("data-off")).toBe(false);
			expect(slot(name).hasAttribute("inert")).toBe(false);
		}

		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await render();
		expect(SLOTS.map(slot)).toEqual(before);
		expect(slot("stop").hasAttribute("data-off")).toBe(true);
	});

	it("keeps Send in its slot, disabled and secondary, while Stop shows with nothing typed", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, showSend: false, sendDisabled: true });
		const send = slot("send").querySelector("button") as unknown as HTMLButtonElement;
		expect(send.getAttribute("aria-label")).toBe(translate("input.send"));
		expect(send.disabled).toBe(true);
		const stop = slot("stop").querySelector("button") as unknown as HTMLElement;
		expect(stop.getAttribute("aria-label")).toBe(translate("input.abort"));

		// A draft appears: Send turns on and primary, Stop steps back; no node came or went.
		const nodes = [send, stop];
		await render({ stoppable: true, showSend: true, sendDisabled: false });
		expect(slot("send").querySelector("button")).toBe(nodes[0]);
		expect(slot("stop").querySelector("button")).toBe(nodes[1]);
		expect(send.disabled).toBe(false);
	});

	it("puts the dictation 'Stop and send' arrow in the Send slot", async () => {
		await render({ dictationPhase: "recording" });
		const dictation = slot("send").querySelector("[data-dictation-send]");
		expect(dictation).not.toBeNull();
		expect(slot("send").querySelectorAll("button").length).toBe(1);
	});
});

describe("model chip", () => {
	it("says Model · Thinking and spells both in its name; data-model-chip stays", async () => {
		useModelStore.setState({
			model: { provider: "acme", id: "sonnet-5-5", name: "Sonnet 5.5" },
			availableThinkingLevels: ["low", "medium", "high"],
			thinkingLevel: "medium",
			thinkingConfigured: "auto",
		});
		await render();
		const chip = container.querySelector("button[data-model-chip]") as unknown as HTMLElement;
		expect(chip.textContent).toBe(`Sonnet 5.5· ${translate("input.thinking.name.auto")}`);
		expect(chip.getAttribute("aria-label")).toBe(
			translate("input.modelLabelThinking", { model: "Sonnet 5.5", level: translate("input.thinking.name.auto") }),
		);
	});
});

describe("tooltips with chords", () => {
	it("names Steer and the follow-up chord on Send while a turn runs; the follow-up lane says so", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, showSend: true });
		const send = slot("send").querySelector("button");
		expect(await tooltipOf(send)).toContain(
			translate("input.send.tipSteer", { chord: formatShortcut(composerFollowUpChord()) }),
		);
		await act(async () => send?.dispatchEvent(new Event("pointerout", { bubbles: true })));
		await render({ followUp: true, stoppable: true, showSend: true });
		expect(await tooltipOf(slot("send").querySelector("button"))).toContain(translate("input.send.tipFollowUp"));
	});

	it("shows Stop's Esc, the model's ⌥M, and the plan and thinking-cycle chords on the Run chip", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, showSend: true });
		expect(await tooltipOf(container.querySelector("button[data-model-chip]"))).toContain(formatShortcut("⌥M"));
		await act(async () =>
			container.querySelector("button[data-model-chip]")?.dispatchEvent(new Event("pointerout", { bubbles: true })),
		);
		expect(await tooltipOf(slot("stop").querySelector("button"))).toContain(formatShortcut("Esc"));
		await act(async () =>
			slot("stop")
				.querySelector("button")
				?.dispatchEvent(new Event("pointerout", { bubbles: true })),
		);
		const run = await tooltipOf(container.querySelector("button[data-run-settings-trigger]"));
		// ⌃T hides thinking BLOCKS (thinking.toggle); the chip names the chords of what it controls.
		expect(run).not.toContain(formatShortcut("⌃T"));
		expect(run).toContain(formatShortcut("⌥⇧P"));
		expect(run).toContain(formatShortcut("⌥⇧T"));
	});
});

describe("dictation button", () => {
	it("is red through data-recording and uses a mic-off glyph while a turn runs, never a second Stop square", async () => {
		useSettingsStore.setState({ sttEnabled: true });
		await render({ dictationPhase: "recording" });
		const mic = container.querySelector(".omp-composer-mic") as unknown as HTMLElement;
		expect(mic.hasAttribute("data-recording")).toBe(true);
		// Idle: the pulsing square.
		expect(mic.querySelector(".omp-pulse-dot")).not.toBeNull();

		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ dictationPhase: "recording", stoppable: true });
		expect(mic.querySelector(".omp-pulse-dot")).toBeNull();
		expect(mic.querySelector("svg")?.getAttribute("class")).toContain("lucide-mic-off");
	});
});
