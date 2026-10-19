/**
 * The Run sheet's one-line rule, on the phone and in the desktop popover alike (it is the same content): every row is
 * a label and its control on ONE line, so no row carries a visible description (`data-setting-desc`) or a paragraph;
 * each explanation sits behind an (i) glyph (`data-setting-info`, its text kept in the DOM). The switches are tiles two to
 * a row (`data-switch-grid`, two columns), the choices are segmented rows, and the compaction point is one line with its
 * value in the label. How the lines measure on a real phone is in e2e/phone-run-sheet.e2e.ts.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(window as unknown as Record<string, unknown>).innerHeight = 900;
(window as unknown as Record<string, unknown>).innerWidth = 390;
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const ok = (command: string, data: unknown): RpcResponse => ({ type: "response", command, success: true, data });
const rpc = {
	getDelegation: vi.fn(async () => ok("get_delegation", { mode: "assisted" })),
	setDelegation: vi.fn(async (mode: string) => ok("set_delegation", { mode })),
	getSettings: vi.fn(async () =>
		ok("get_settings", {
			values: { "compaction.modelThresholds": {}, extendedContext: false },
			provenance: {},
		}),
	),
	compactionLimits: vi.fn(async () => ok("compaction_limits", { models: [], roles: [] })),
};
const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { rpc, prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, events },
});

const { createRoot } = await import("react-dom/client");
const { RunChip } = await import("./RunChip");

let container: HTMLElement;
let root: Root;

async function openSheet(): Promise<Element> {
	useSessionStore.setState({ sessionId: "s1", status: "ready" });
	useModelStore.setState({
		model: { provider: "acme", id: "big" } as never,
		fastModeEnabled: true,
		ultrafastSupported: true,
		slowModeSupported: true,
		availableThinkingLevels: ["low", "medium", "high"],
		thinkingLevel: "medium",
		thinkingConfigured: "auto",
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RunChip />
			</I18nProvider>,
		);
	});
	await act(async () => (container.querySelector("[data-run-settings-trigger]") as HTMLElement).click());
	// Advanced opens by itself while a value is not the default; open it otherwise, so every row is on screen.
	const advanced = Array.from(document.querySelectorAll("button")).find(
		button => button.textContent?.trim() === translate("input.runSettings.advanced"),
	) as HTMLElement | undefined;
	if (advanced?.getAttribute("aria-expanded") !== "true") await act(async () => advanced?.click());
	// The Context rows read the settings first.
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0));
	});
	const sheet = document.querySelector('[role="dialog"]');
	if (!sheet) throw new Error("the Run sheet did not open");
	return sheet;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	vi.clearAllMocks();
});

describe("the Run sheet is one line per row", () => {
	it("shows no description under any row: no visible description, no paragraph, an (i) glyph for each explanation", async () => {
		const sheet = await openSheet();
		expect(sheet.querySelectorAll("[data-setting-desc]")).toHaveLength(0);
		expect(sheet.querySelectorAll("p")).toHaveLength(0);
		// The explanations are still there: in the (i) glyphs' text, never as a visible line.
		const text = sheet.textContent ?? "";
		for (const key of [
			"input.runSettings.fastDesc",
			"input.runSettings.slowDescSession",
			"input.runSettings.ultrafastDesc",
			"input.runSettings.extendedDesc",
			"input.more.autoCompactDesc",
			"input.more.autoRetryDesc",
			"cmd.prewalk.desc",
			"input.more.steeringAllDesc",
			"input.more.interruptImmediateDesc",
			"input.delegation.note",
			"input.approval.yolo.desc",
			"input.thinking.level.auto",
		]) {
			expect(text, key).toContain(translate(key));
		}
		expect(sheet.querySelectorAll("[data-setting-info]").length).toBeGreaterThanOrEqual(12);
	});

	it("lays the switches out as icon tiles, two to a row, each with its (i) glyph", async () => {
		const sheet = await openSheet();
		const grids = Array.from(sheet.querySelectorAll("[data-switch-grid]"));
		// Speed (Fast, Slow, Ultrafast) and Advanced (Auto-compact, Extended, Auto-retry, Prewalk, Steer, Interrupt).
		expect(grids).toHaveLength(2);
		for (const grid of grids) expect(grid.className).toContain("grid-cols-2");
		const tiles = Array.from(sheet.querySelectorAll("[data-switch-tile]"));
		expect(tiles).toHaveLength(9);
		for (const tile of tiles) {
			expect(tile.querySelector("[data-setting-icon] svg")).not.toBeNull();
			expect(tile.querySelector("[data-setting-info]")).not.toBeNull();
			expect(tile.querySelector("[role=switch]")).not.toBeNull();
			// One line: the label truncates instead of wrapping.
			expect(tile.querySelector("label span.truncate")).not.toBeNull();
		}
		expect(grids[0]?.querySelectorAll("[data-switch-tile]")).toHaveLength(3);
	});

	it("keeps thinking, approval and delegation as one segmented row each instead of a select and a caption", async () => {
		const sheet = await openSheet();
		expect(sheet.querySelectorAll("[data-choice-row]")).toHaveLength(3);
		expect(sheet.querySelector("[data-thinking-level] [role=radiogroup]")).not.toBeNull();
		expect(sheet.querySelector("[data-approval-mode] [role=radiogroup]")).not.toBeNull();
		expect(sheet.querySelector("[data-delegation-section] [role=radiogroup]")).not.toBeNull();
		// The only select left is the compaction point's, one line with its value in the label.
		const selects = sheet.querySelectorAll("select");
		expect(selects).toHaveLength(1);
		const row = sheet.querySelector("[data-context-size]");
		expect(row?.textContent).toContain(translate("input.runSettings.contextLimit"));
		expect(row?.querySelector("[data-setting-info]")).not.toBeNull();
	});
});
