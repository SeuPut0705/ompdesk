import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
let focused: HTMLElement | null = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: HTMLElement) {
		focused = this;
	},
});

const { createRoot } = await import("react-dom/client");
const { HistoryExpander } = await import("./ChatStream");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	focused = null;
});

describe("HistoryExpander", () => {
	it("opens the earlier messages and hands focus to the transcript's scroller", async () => {
		const scroller = document.createElement("div");
		scroller.tabIndex = 0;
		document.body.append(scroller);
		const host = document.createElement("div");
		scroller.append(host);
		const ref = createRef<HTMLElement>() as { current: HTMLElement | null };
		ref.current = scroller;
		const onOpen = vi.fn();
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<HistoryExpander count={12} onOpen={onOpen} scroller={ref} />
				</I18nProvider>,
			),
		);
		await act(async () => (document.querySelector("button") as HTMLElement).click());
		expect(onOpen).toHaveBeenCalledOnce();
		expect(focused).toBe(scroller);
	});
});
