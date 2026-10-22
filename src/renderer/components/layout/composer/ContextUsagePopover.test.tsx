import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcContextReportResult, RpcResponse } from "../../../../shared/rpc-types";
import { OVERLAY_EXIT_MS } from "../../../hooks/use-overlay-presence";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useForkHandoffStore } from "../../../stores/fork-handoff";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";

const reportWithoutWindow: RpcContextReportResult = {
	contextWindow: 0,
	model: "mimo-v2.6-pro",
	breakdown: {
		anchored: false,
		contextWindow: 0,
		usedTokens: 16_000,
		systemPromptTokens: 1_000,
		systemContextTokens: 200,
		systemToolsTokens: 6_400,
		skillsTokens: 300,
		messagesTokens: 8_100,
	},
};

const { document, window, Event, HTMLElement, Element, Node, PointerEvent } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	PointerEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// linkedom has no focus model: record what `focus()` reached so the keyboard route can be asserted.
let focused: unknown = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: unknown) {
		focused = this;
	},
});
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
// linkedom's selector engine has no :focus-visible; every focus here is a keyboard landing (what Tooltip asks).
const nativeMatches = HTMLElement.prototype.matches;
Object.defineProperty(HTMLElement.prototype, "matches", {
	configurable: true,
	value(this: HTMLElement, selector: string) {
		return selector === ":focus-visible" || nativeMatches.call(this, selector);
	},
});

const report: RpcContextReportResult = {
	contextWindow: 1_000_000,
	model: "test-model",
	breakdown: {
		anchored: true,
		contextWindow: 1_000_000,
		usedTokens: 161_900,
		systemPromptTokens: 1_000,
		systemContextTokens: 200,
		systemToolsTokens: 6_400,
		skillsTokens: 300,
		messagesTokens: 154_000,
	},
};

const getContextReport: Mock<() => Promise<RpcResponse>> = vi.fn(async () => ({
	type: "response",
	command: "get_context_report",
	success: true,
	data: report,
}));
/** No `compaction.modelThresholds` in the live settings (no compaction point) unless a test says otherwise. */
let thresholdsKnown = false;
const getSettings = vi.fn(async () => ({
	type: "response",
	command: "get_settings",
	success: true,
	data: { values: thresholdsKnown ? { "compaction.modelThresholds": {} } : {} },
}));
const getCompactionPoints = vi.fn(async (_selector?: string) => ({
	type: "response",
	command: "get_compaction_points",
	success: true,
	data: {
		models: [{ selector: "acme/m", point: { tokens: 80_000, percent: 80, source: "default" } }],
		roles: [],
	},
}));
Object.assign(window, {
	omp: {
		rpc: { getContextReport, getSettings, getCompactionPoints },
		events: { onConfigUpdate: () => () => {} },
	},
});

const { createRoot } = await import("react-dom/client");
const { ContextUsagePopover } = await import("./ContextUsagePopover");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ContextUsagePopover />
			</I18nProvider>,
		);
	});
}

/** Past the exit-animation hold, when a closed overlay is finally unmounted. */
async function settleExit(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, OVERLAY_EXIT_MS + 20));
	});
}

afterEach(async () => {
	vi.useRealTimers();
	focused = null;
	await act(async () => root?.unmount());
	container?.remove();
	getContextReport.mockReset();
	thresholdsKnown = false;
	useModelStore.setState({ model: null });
	useSessionStore.getState().reset();
	useUiStore.getState().closeSessionOverlays();
});

describe("ContextUsagePopover", () => {
	it("keeps the measured reading visible when Core has no capacity for the model", async () => {
		// A host whose model list omits window metadata leaves Core with a locally
		// measured token count and no denominator. Collapsing the control to a bare
		// em dash hides the one number that is known and reads as a broken feature.
		getContextReport.mockResolvedValueOnce({
			type: "response",
			command: "get_context_report",
			success: true,
			data: reportWithoutWindow,
		} satisfies RpcResponse);
		useSessionStore.setState({
			contextUsage: { contextWindow: 0, percent: 0, tokens: 16_000 },
			sessionId: "unknown-window",
			status: "ready",
		});
		await mount();

		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		// A ring only: the reading is in the name and the breakdown, never beside the ring.
		expect(trigger.textContent).toBe("");
		expect(trigger.getAttribute("aria-label")).toBe(translate("contextUsage.ringUnknown", { used: "16.0k" }));
		expect(trigger.getAttribute("data-context-ring")).toBe("unknown");
		expect(trigger.querySelector("[data-context-arc]")).toBeNull();
		expect(container.textContent).not.toContain("0%");

		await act(async () => trigger.click());
		expect(getContextReport).toHaveBeenCalledTimes(1);
		const dialog = document.querySelector("#omp-context-usage-popover");
		expect(dialog?.textContent).toContain("Context window");
		expect(dialog?.textContent).toContain(`${translate("contextUsage.category.messages")}~8.1k`);
		// Shares of a window that does not exist would be invented numbers.
		expect(dialog?.textContent).not.toContain("%");
		// A bar filled with the used tokens alone reads as "full", so the
		// capacity-relative gauge is withheld rather than repurposed.
		expect(dialog?.querySelector('[role="progressbar"], [role="img"]')).toBeNull();
		expect(dialog?.textContent).toContain(translate("contextUsage.windowUnknown"));
	});

	it("keeps context usage to one control and reveals the native three-category breakdown", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 1_000_000, percent: 16.19, tokens: 161_900 },
			sessionId: "session-1",
			status: "ready",
		});
		await mount();

		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		expect(trigger.getAttribute("aria-label")).toBe(
			translate("contextUsage.ring", { percent: 16, used: "161.9k", window: "1.0M" }),
		);
		// The resting control is the ring alone; the share is in its name, the token counts in the popover.
		expect(trigger.textContent).toBe("");
		expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
		expect(document.querySelector("#omp-context-usage-popover")).toBeNull();

		await act(async () => trigger.click());
		expect(getContextReport).toHaveBeenCalledTimes(1);
		// A click pins it and it poses as a (non-modal) dialog like every other composer popover.
		expect(document.querySelector("#omp-context-usage-popover")?.getAttribute("role")).toBe("dialog");
		const dialog = document.querySelector("#omp-context-usage-popover");
		expect(dialog?.textContent).toContain("Context usage 16%");
		expect(dialog?.textContent).toContain("~161.9k / 1.0M");
		expect(dialog?.textContent).toContain("Context remaining838.1k");
		expect(dialog?.textContent).toContain("System context~1.5k");
		expect(dialog?.textContent).toContain("Tools~6.4k");
		expect(dialog?.textContent).toContain(`${translate("contextUsage.category.messages")}~154.0k`);
		expect(dialog?.querySelector('[role="progressbar"]')).not.toBeNull();
	});

	it("renders nothing until the session reports context usage", async () => {
		await mount();
		expect(container.childElementCount).toBe(0);
		expect(getContextReport).not.toHaveBeenCalled();
	});

	it("reveals the same breakdown on hover without pinning a modal", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 100_000, percent: 10, tokens: 10_000 },
			sessionId: "session-hover",
			status: "ready",
		});
		await mount();

		await act(async () => {
			container.querySelector("button")?.dispatchEvent(new Event("mouseover", { bubbles: true }));
		});
		expect(document.querySelector("#omp-context-usage-popover")).not.toBeNull();
		// A hover alone is no dialog: App.tsx suppresses the app chords while one is in the tree.
		expect(document.querySelector("#omp-context-usage-popover")?.getAttribute("role")).toBe("group");
		expect(getContextReport).toHaveBeenCalledTimes(1);
	});

	it("never opens on keyboard focus, and closes once focus moves on to another control", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 100_000, percent: 10, tokens: 10_000 },
			sessionId: "session-focus",
			status: "ready",
		});
		await mount();
		vi.useFakeTimers();
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		/** One Tab press: focusout on the element left, focusin on the element reached. */
		const moveFocus = async (from: unknown, to: unknown) => {
			await act(async () => {
				const out = new Event("focusout", { bubbles: true });
				Object.defineProperty(out, "relatedTarget", { value: to });
				(from as HTMLElement | null)?.dispatchEvent(out);
				const into = new Event("focusin", { bubbles: true });
				Object.defineProperty(into, "relatedTarget", { value: from });
				(to as HTMLElement).dispatchEvent(into);
			});
		};
		const popover = () => document.querySelector("#omp-context-usage-popover");

		// Landing on the ring (Tab) shows nothing: three tab stops and a popover opening by itself were DI-23.
		await act(async () => trigger.focus());
		await moveFocus(outside, trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(popover()).toBeNull();
		// Only the reading, as the tooltip: the ring's own words.
		expect(document.querySelector("[role=tooltip]")?.textContent).toBe(trigger.getAttribute("aria-label"));

		await act(async () => trigger.click());
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		// The breakdown says the same: no tooltip over it.
		expect(document.querySelector("[role=tooltip]")).toBeNull();
		const inside = [...(popover()?.querySelectorAll("button") ?? [])].at(-1);
		expect(inside).toBeDefined();
		await moveFocus(trigger, inside);
		await act(async () => vi.advanceTimersByTime(200));
		// Focus inside the breakdown keeps it open: its buttons are reachable by keyboard.
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(popover()?.getAttribute("aria-hidden")).toBeNull();

		// Focus leaving for another control closes it at once, pinned or not.
		await moveFocus(inside, outside);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		vi.useRealTimers();
		outside.remove();
	});

	it("opens with Enter or Space into the breakdown, Tab past its last control closes it, Escape returns to the ring", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 100_000, percent: 10, tokens: 10_000 },
			sessionId: "session-keyboard",
			status: "ready",
		});
		await mount();
		const next = document.createElement("button");
		container.after(next as never);
		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		trigger.focus();
		// A keyboard activation is a click with no pointer: detail 0.
		await act(async () => {
			const click = new Event("click", { bubbles: true, cancelable: true });
			Object.defineProperty(click, "detail", { value: 0 });
			trigger.dispatchEvent(click);
		});
		const popover = document.querySelector("#omp-context-usage-popover") as unknown as HTMLElement;
		const buttons = [...popover.querySelectorAll("button")] as unknown as HTMLButtonElement[];
		expect(document.activeElement).toBe(buttons[0]);

		// Tab on the last control: out to the control after the ring, popover closed.
		(buttons.at(-1) as HTMLButtonElement).focus();
		const tab = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(tab, "key", { value: "Tab" });
		await act(async () => buttons.at(-1)?.dispatchEvent(tab));
		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(next);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await settleExit();

		// Escape from inside returns focus to the ring.
		await act(async () => {
			const click = new Event("click", { bubbles: true, cancelable: true });
			Object.defineProperty(click, "detail", { value: 0 });
			trigger.dispatchEvent(click);
		});
		const reopened = document.querySelector("#omp-context-usage-popover")?.querySelector("button");
		expect(document.activeElement).toBe(reopened);
		const escapeKey = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(escapeKey, "key", { value: "Escape" });
		await act(async () => document.dispatchEvent(escapeKey));
		expect(document.activeElement).toBe(trigger);
		next.remove();
	});

	it("without a compaction point warns at 80% of the window and turns danger at 95%", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 100_000, percent: 80, tokens: 80_000 },
			sessionId: "session-ring",
			status: "ready",
		});
		await mount();
		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		expect(trigger.getAttribute("data-context-ring")).toBe("warning");
		await act(async () =>
			useSessionStore.setState({ contextUsage: { contextWindow: 100_000, percent: 95, tokens: 95_000 } }),
		);
		expect(trigger.getAttribute("data-context-ring")).toBe("danger");
		await act(async () =>
			useSessionStore.setState({ contextUsage: { contextWindow: 100_000, percent: 40, tokens: 40_000 } }),
		);
		expect(trigger.getAttribute("data-context-ring")).toBe("ok");
	});

	it("fills its arc by the used share, turns warning near the compaction point and danger at it, and names the point", async () => {
		thresholdsKnown = true;
		useModelStore.setState({ model: { provider: "acme", id: "m", name: "Model" } as never });
		useSessionStore.setState({
			contextUsage: { contextWindow: 200_000, percent: 20, tokens: 40_000 },
			sessionId: "session-compaction",
			status: "ready",
		});
		await mount();
		await act(async () => {});
		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		const arc = () => trigger.querySelector("[data-context-arc]");
		const dash = () => Number.parseFloat(arc()?.getAttribute("stroke-dasharray") ?? "0");
		expect(trigger.getAttribute("aria-label")).toBe(
			translate("contextUsage.ringCompacts", { percent: 20, used: "40.0k", window: "200.0k", point: "80.0k" }),
		);
		expect(trigger.textContent).toBe("");
		// The ring shows this model's point alone, so it asks for that one model, never the whole table.
		expect(getCompactionPoints.mock.calls).toEqual([["acme/m"]]);
		expect(arc()?.getAttribute("data-context-arc")).toBe("20");
		const quarter = dash();
		expect(trigger.getAttribute("data-context-ring")).toBe("ok");

		// 70k of a point at 80k: one more long turn may compact.
		await act(async () =>
			useSessionStore.setState({ contextUsage: { contextWindow: 200_000, percent: 35, tokens: 70_000 } }),
		);
		expect(trigger.getAttribute("data-context-ring")).toBe("warning");
		expect(arc()?.getAttribute("data-context-arc")).toBe("35");
		expect(dash()).toBeCloseTo(quarter * (35 / 20), 5);

		// At the point, though only 40% of the window is in use.
		await act(async () =>
			useSessionStore.setState({ contextUsage: { contextWindow: 200_000, percent: 40, tokens: 80_000 } }),
		);
		expect(trigger.getAttribute("data-context-ring")).toBe("danger");

		await act(async () => trigger.click());
		expect(document.querySelector("[data-context-compacts]")?.textContent).toBe(
			translate("contextUsage.compactsAt", { point: "80.0k" }),
		);
	});

	it("closes a pinned popover from its trigger, Escape, and an outside pointer", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 1_000_000, percent: 16.19, tokens: 161_900 },
			sessionId: "session-close",
			status: "ready",
		});
		await mount();
		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;

		await act(async () => trigger.click());
		expect(document.querySelector("#omp-context-usage-popover")).not.toBeNull();
		await act(async () => trigger.click());
		// The exit animation holds the element mounted for one more phase, so
		// "closed" is the honest assertion here: released ARIA state, the popover
		// hidden from assistive tech, and no unmount until the animation ends.
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector("#omp-context-usage-popover")?.getAttribute("aria-hidden")).toBe("true");
		await settleExit();
		expect(document.querySelector("#omp-context-usage-popover")).toBeNull();

		await act(async () => trigger.click());
		const escapeEvent = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(escapeEvent, "key", { value: "Escape" });
		await act(async () => document.dispatchEvent(escapeEvent));
		expect(document.querySelector("#omp-context-usage-popover")?.getAttribute("aria-hidden")).toBe("true");
		await settleExit();
		expect(document.querySelector("#omp-context-usage-popover")).toBeNull();
		// App.tsx aborts the active turn on an unclaimed Escape, so the popover has
		// to claim the keypress it consumed.
		expect(escapeEvent.defaultPrevented).toBe(true);

		await act(async () => trigger.click());
		await act(async () => document.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(document.querySelector("#omp-context-usage-popover")?.getAttribute("aria-hidden")).toBe("true");
		await settleExit();
		expect(document.querySelector("#omp-context-usage-popover")).toBeNull();
	});

	it("keeps the current total visible when the detailed report is unavailable", async () => {
		getContextReport.mockRejectedValueOnce(new Error("sidecar unavailable"));
		useSessionStore.setState({
			contextUsage: { contextWindow: 272_000, percent: 64, tokens: 173_700 },
			sessionId: "session-fallback",
			status: "ready",
		});
		await mount();

		await act(async () => (container.querySelector("button") as unknown as HTMLButtonElement).click());
		const dialog = document.querySelector("#omp-context-usage-popover");
		expect(dialog?.textContent).toContain("Context usage 64%");
		expect(dialog?.textContent).toContain("~173.7k / 272.0k");
		expect(dialog?.textContent).toContain("The detailed breakdown is temporarily unavailable.");
	});

	it("opens the full context report from the compact usage popover", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 1_000_000, percent: 16.19, tokens: 161_900 },
			sessionId: "session-report-link",
			status: "ready",
		});
		await mount();
		await act(async () => {
			(container.querySelector("button") as unknown as HTMLButtonElement).click();
			await Promise.resolve();
		});

		const reportButton = Array.from(document.querySelectorAll("button")).find(button =>
			button.textContent?.includes("See details in Stats"),
		);
		expect(reportButton).toBeDefined();
		await act(async () => reportButton?.click());
		const ui = useUiStore.getState();
		expect(ui.destination).toBe("insights");
		expect(ui.insightsTab).toBe("stats");
		expect(ui.insightsStatsScope).toBe("session");
	});

	async function openPinned(): Promise<void> {
		useSessionStore.setState({
			contextUsage: { contextWindow: 1_000_000, percent: 16.19, tokens: 161_900 },
			sessionId: "session-actions",
			status: "ready",
		});
		await mount();
		await act(async () => {
			(container.querySelector("button") as unknown as HTMLButtonElement).click();
			await Promise.resolve();
		});
	}

	function buttonNamed(label: string): HTMLButtonElement | undefined {
		return Array.from(document.querySelectorAll("button")).find(button => button.textContent?.includes(label)) as
			| HTMLButtonElement
			| undefined;
	}

	it("hands the conversation off to a new session from the popover", async () => {
		await openPinned();
		await act(async () => buttonNamed(translate("contextUsage.handoff"))?.click());
		expect(useForkHandoffStore.getState().handoffDialogOpen).toBe(true);
		useForkHandoffStore.setState({ handoffDialogOpen: false });
	});

	it("compacts through stock's compact once, and not while a compaction runs", async () => {
		const compact = vi.fn(async () => ({ type: "response", command: "compact", success: true }));
		(window.omp.rpc as unknown as Record<string, unknown>).compact = compact;
		await openPinned();
		await act(async () => useSessionStore.setState({ isCompacting: true }));
		expect(buttonNamed(translate("contextUsage.compact"))?.disabled).toBe(true);
		await act(async () => useSessionStore.setState({ isCompacting: false }));
		await act(async () => {
			buttonNamed(translate("contextUsage.compact"))?.click();
			await Promise.resolve();
		});
		expect(compact).toHaveBeenCalledTimes(1);
	});
});
