/**
 * The toolbar's own contracts: Send and Stop are ONE button in one slot (send-slot.ts), whose node stays while a turn
 * starts or ends or a draft appears, and nothing waits beside it; while a turn runs with a draft its right click (a
 * long press on touch) offers a Stop that keeps the draft; the Steer/Follow-up chip shows only while a turn runs; the
 * dictation "Stop and send" arrow takes the button's place; the model chip says `Model · Thinking`; and the tooltips
 * carry their chords. The pixel claims are measured in e2e/composer-toolbar.e2e.ts.
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
import { useUiStore } from "../../../stores/ui";
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
	touchInput: false,
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
	hasDraft: true,
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
const button = () => slot("send").querySelector("button") as unknown as HTMLButtonElement;
const lane = () => container.querySelector("[data-send-mode]");

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

async function contextMenu(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
	});
}

interface Row {
	name: string;
	streaming: boolean;
	props: Partial<ComposerToolbarProps>;
	label: string;
	disabled: boolean;
	state: string;
	stopHint: boolean;
}

const STATES: Row[] = [
	{
		name: "idle, empty draft: a disabled Send",
		streaming: false,
		props: { hasDraft: false, sendDisabled: true },
		label: "input.send",
		disabled: true,
		state: "send",
		stopHint: false,
	},
	{
		name: "typing: Send",
		streaming: false,
		props: { hasDraft: true, sendDisabled: false },
		label: "input.send",
		disabled: false,
		state: "send",
		stopHint: false,
	},
	{
		name: "a turn runs, empty draft: Stop",
		streaming: true,
		props: { stoppable: true, hasDraft: false, sendDisabled: true },
		label: "input.abort",
		disabled: false,
		state: "stop",
		stopHint: false,
	},
	{
		name: "a turn runs with a draft: Send, which still offers Stop",
		streaming: true,
		props: { stoppable: true, hasDraft: true, sendDisabled: false },
		label: "input.send",
		disabled: false,
		state: "send",
		stopHint: true,
	},
];

describe("one action button", () => {
	it.each(STATES)("$name", async row => {
		await act(async () => useSessionStore.setState({ isStreaming: row.streaming }));
		await render(row.props);
		expect(button().getAttribute("aria-label")).toBe(translate(row.label));
		expect(button().disabled).toBe(row.disabled);
		expect(button().getAttribute("data-send-state")).toBe(row.state);
		expect(button().querySelector("[data-send-stop-hint]") !== null).toBe(row.stopHint);
		expect(button().hasAttribute("aria-describedby")).toBe(row.stopHint);
		// The lane chip is there only while a turn runs; no slot is held for it (or for Stop) while idle.
		expect(lane() !== null).toBe(row.streaming);
		expect(slot("send").querySelectorAll("button").length).toBe(1);
		expect(container.querySelector('[data-slot="stop"], [data-slot="steer"], .omp-composer-slot')).toBeNull();
	});

	it("is the same node through idle, typing, a running turn and typing during it", async () => {
		await render({ hasDraft: false, sendDisabled: true });
		const node = button();
		for (const row of STATES) {
			await act(async () => useSessionStore.setState({ isStreaming: row.streaming }));
			await render(row.props);
			expect(button()).toBe(node);
		}
	});

	it("runs Stop as Stop and Send as Send", async () => {
		const onStop = vi.fn();
		const onSend = vi.fn();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, hasDraft: false, sendDisabled: true, onStop, onSend });
		await act(async () => button().dispatchEvent(new Event("click", { bubbles: true })));
		expect(onStop).toHaveBeenCalledTimes(1);
		await render({ stoppable: true, hasDraft: true, sendDisabled: false, onStop, onSend });
		await act(async () => button().dispatchEvent(new Event("click", { bubbles: true })));
		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"offers Stop on a long press / right click while a turn runs with a draft, never sending (touch %s)",
		async touchInput => {
			const onStop = vi.fn();
			const onSend = vi.fn();
			await act(async () => useSessionStore.setState({ isStreaming: true }));
			await render({ stoppable: true, hasDraft: true, sendDisabled: false, onStop, onSend, touchInput });
			const hint = document.getElementById(button().getAttribute("aria-describedby") ?? "");
			expect(hint?.textContent).toBe(
				translate(touchInput ? "input.send.stopHintTouch" : "input.send.stopHintDesktop"),
			);
			await contextMenu(button());
			const items = Array.from(document.querySelectorAll("[data-menu-item]")) as unknown as HTMLElement[];
			expect(items.length).toBe(1);
			expect(items[0]?.textContent).toContain(translate("input.abort"));
			expect(items[0]?.textContent).toContain(translate("input.stopKeepsDraft"));
			await act(async () => items[0]?.dispatchEvent(new Event("click", { bubbles: true })));
			expect(onStop).toHaveBeenCalledTimes(1);
			expect(onSend).not.toHaveBeenCalled();
			expect(document.querySelector("[data-menu-item]")).toBeNull();
		},
	);

	it("has no long-press menu while it is Stop or no turn runs", async () => {
		await render({ hasDraft: true });
		await contextMenu(button());
		expect(document.querySelector("[data-menu-item]")).toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, hasDraft: false, sendDisabled: true });
		await contextMenu(button());
		expect(document.querySelector("[data-menu-item]")).toBeNull();
	});

	it("forgets an open Stop menu once the turn ends: the next turn's draft never reopens it", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, hasDraft: true });
		await contextMenu(button());
		expect(document.querySelector("[data-menu-item]")).not.toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		await render({ stoppable: false, hasDraft: true });
		expect(document.querySelector("[data-menu-item]")).toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, hasDraft: true });
		expect(document.querySelector("[data-menu-item]")).toBeNull();
	});

	it("puts the dictation 'Stop and send' arrow in the button's place", async () => {
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
		// The provider mark's fallback letter is decoration; the words are the model and the effort.
		const mark = chip.querySelector("[data-provider-mark]")?.textContent ?? "";
		expect(chip.textContent?.replace(mark, "")).toBe(`Sonnet 5.5· ${translate("input.thinking.name.auto")}`);
		expect(chip.getAttribute("aria-label")).toBe(
			translate("input.modelLabelThinking", { model: "Sonnet 5.5", level: translate("input.thinking.name.auto") }),
		);
	});

	it("drops the brand word the mark draws and shows Auto alone; name and tooltip keep both in full", async () => {
		useModelStore.setState({
			model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
			availableThinkingLevels: ["low", "medium", "high"],
			thinkingLevel: "high",
			thinkingConfigured: "auto",
			thinkingAutoResolved: "high",
		});
		await render();
		const chip = container.querySelector("button[data-model-chip]") as unknown as HTMLElement;
		expect(chip.querySelector(".omp-composer-model-label")?.textContent).toBe("Sonnet 5.5");
		expect(chip.querySelector(".omp-composer-effort")?.textContent).toBe(
			`· ${translate("input.thinking.name.auto")}`,
		);
		const resolved = translate("input.thinking.autoResolved", { level: translate("input.thinking.name.high") });
		expect(chip.getAttribute("aria-label")).toBe(
			translate("input.modelLabelThinking", { model: "Claude Sonnet 5.5", level: resolved }),
		);
		const tip = await tooltipOf(chip);
		expect(tip).toContain("Claude Sonnet 5.5");
		expect(tip).toContain(resolved);
	});
});

describe("tooltips with chords", () => {
	it("names Steer and the follow-up chord on Send while a turn runs; the follow-up lane says so", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true });
		const send = slot("send").querySelector("button");
		expect(await tooltipOf(send)).toContain(
			translate("input.send.tipSteer", { chord: formatShortcut(composerFollowUpChord()) }),
		);
		await act(async () => send?.dispatchEvent(new Event("pointerout", { bubbles: true })));
		await render({ followUp: true, stoppable: true });
		expect(await tooltipOf(slot("send").querySelector("button"))).toContain(translate("input.send.tipFollowUp"));
	});

	it("says on the desktop how to stop without losing the draft", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true });
		expect(await tooltipOf(button())).toContain(translate("input.send.stopHintDesktop"));
	});

	it("shows Stop's Esc, the model's ⌥M, and the plan and thinking-cycle chords on the Run chip", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true, hasDraft: false, sendDisabled: true });
		expect(await tooltipOf(container.querySelector("button[data-model-chip]"))).toContain(formatShortcut("⌥M"));
		await act(async () =>
			container.querySelector("button[data-model-chip]")?.dispatchEvent(new Event("pointerout", { bubbles: true })),
		);
		expect(await tooltipOf(button())).toContain(formatShortcut("Esc"));
		await act(async () => button().dispatchEvent(new Event("pointerout", { bubbles: true })));
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

describe("+ menu Dictation item", () => {
	const items = () => Array.from(document.querySelectorAll("[data-menu-item]")) as unknown as HTMLElement[];
	async function openMenu(): Promise<void> {
		const add = container.querySelector('button[aria-label="Attach and more"]') as unknown as HTMLElement;
		await act(async () => {
			add.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
	}

	it("explains where to turn dictation on while it is off, and opens Settings without writing the setting", async () => {
		await render();
		await openMenu();
		const item = items().find(entry => entry.textContent?.includes(translate("voice.menu.off")));
		expect(item?.textContent).toContain(translate("voice.menu.offDesc"));
		await act(async () => {
			item?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(useUiStore.getState().destination).toBe("settings");
		expect(useUiStore.getState().settingsTab).toBe("agent:setting-stt.enabled");
		expect(useSettingsStore.getState().sttEnabled).toBe(false);
	});

	it("is gone once dictation is on: the mic button takes over", async () => {
		useSettingsStore.setState({ sttEnabled: true });
		await render();
		await openMenu();
		expect(items().some(entry => entry.textContent?.includes(translate("voice.menu.off")))).toBe(false);
	});
});

describe("editing a queued message", () => {
	it("turns Send into a check named Save changes, in the same slot, and steps the lane chip aside", async () => {
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await render({ stoppable: true });
		const send = button();
		expect(send.getAttribute("aria-label")).toBe(translate("input.send"));
		expect(lane()).not.toBeNull();

		await render({ stoppable: true, editingQueued: true });
		expect(button()).toBe(send);
		expect(send.getAttribute("aria-label")).toBe(translate("composerQueue.editSave"));
		expect(send.querySelector("svg")?.getAttribute("class")).toContain("lucide-check");
		expect(lane()).toBeNull();
	});
});
