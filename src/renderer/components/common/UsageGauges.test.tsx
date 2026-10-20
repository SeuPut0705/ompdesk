import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageLimit } from "../../../shared/rpc-types";
import { I18nProvider, setLanguageOverride } from "../../lib/i18n";

const { document, window, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { UsageGauges } = await import("./UsageGauges");

const limits: UsageLimit[] = [
	{ id: "anthropic:5h", label: "5h", windowId: "5h", usedFraction: 0.64 },
	{ id: "anthropic:7d", label: "7d", windowId: "7d", usedFraction: 0.78 },
];

let root: Root | undefined;
let container: HTMLElement;

async function mount(compact: boolean): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<UsageGauges compact={compact} limits={limits} />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
	setLanguageOverride(null);
});

describe("usage gauges", () => {
	it("draws the window's name and its percent as two parts, never one glued word", async () => {
		await mount(true);
		const gauges = [...container.querySelectorAll(".omp-usage-gauge-text")];
		expect(gauges.map(text => text.querySelector("[data-usage-label]")?.textContent)).toEqual(["5H", "7D"]);
		expect(gauges.map(text => text.querySelector("[data-usage-percent]")?.textContent)).toEqual(["64%", "78%"]);
		// The stylesheet keeps a gap between them however narrow the bar (the board's head glued "5H64%").
		const css = readFileSync(new URL("../../styles/usage-gauges.css", import.meta.url), "utf8");
		expect(/\.omp-usage-gauge-text \{[^}]*\bgap: var\(--sc-space-1-5\)/.exec(css)).not.toBeNull();
		expect(/\.omp-usage-gauge-text \{[^}]*white-space: nowrap/.exec(css)).not.toBeNull();
	});

	it("names each window with its share for a screen reader, in the UI language", async () => {
		setLanguageOverride("ko");
		await mount(true);
		const bars = [...container.querySelectorAll('[role="progressbar"]')];
		expect(bars.map(bar => bar.getAttribute("aria-label"))).toEqual(["5시간 한도 64%", "주간 한도 78%"]);
		// The glyphs inside are not read on top of it.
		expect(container.querySelector(".omp-usage-gauge-text")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("is the same chip in the sidebar and on the board", async () => {
		setLanguageOverride("en");
		await mount(false);
		expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe("5-hour limit 64%");
		expect(container.querySelector("[data-usage-label]")?.textContent).toBe("5H");
	});
});
