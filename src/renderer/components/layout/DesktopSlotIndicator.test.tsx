import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useDesktopSlotStore } from "../../stores/desktop-slot";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const stopDesktopSlot = vi.fn(async () => ({ success: true }));
(window as unknown as { omp: unknown }).omp = { rpc: { stopDesktopSlot } };
// Dynamic imports: React and the component must load after the linkedom DOM globals above exist.

const { createRoot } = await import("react-dom/client");
const { DesktopSlotIndicator } = await import("./DesktopSlotIndicator");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<DesktopSlotIndicator />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	stopDesktopSlot.mockClear();
	useDesktopSlotStore.getState().reset();
});

describe("DesktopSlotIndicator", () => {
	it("is absent while the slot is free", async () => {
		await mount();
		expect(container.querySelector("[data-desktop-slot-indicator]")).toBeNull();
	});

	it("names the holder, hides the waiting part at zero and shows it otherwise", async () => {
		useDesktopSlotStore.getState().apply({ holder: { tabId: "a", title: "Alpha", since: 1 }, queue: [] });
		await mount();
		const text = () => container.querySelector("[data-desktop-slot-text]")?.textContent;
		expect(text()).toBe(translate("desktopSlot.busy", { title: "Alpha", count: 0 }));
		expect(text()).not.toContain("·");

		await act(async () =>
			useDesktopSlotStore.getState().apply({
				holder: { tabId: "a", title: "Alpha", since: 1 },
				queue: [
					{ tabId: "b", title: "Beta" },
					{ tabId: "c", title: "Gamma" },
				],
			}),
		);
		expect(text()).toBe(translate("desktopSlot.busyWaiting", { title: "Alpha", count: 2 }));
	});

	it("stops the run from the Stop button", async () => {
		useDesktopSlotStore.getState().apply({ holder: { tabId: "a", title: "Alpha", since: 1 }, queue: [] });
		await mount();
		const stop = container.querySelector("[data-desktop-slot-stop]") as HTMLElement;
		expect(stop.getAttribute("aria-label")).toBe(translate("desktopSlot.stop"));
		await act(async () => stop.click());
		expect(stopDesktopSlot).toHaveBeenCalledTimes(1);
	});

	it("disappears when the slot frees", async () => {
		useDesktopSlotStore.getState().apply({ holder: { tabId: "a", title: "Alpha", since: 1 }, queue: [] });
		await mount();
		await act(async () => useDesktopSlotStore.getState().apply({ holder: null, queue: [] }));
		expect(container.querySelector("[data-desktop-slot-indicator]")).toBeNull();
	});
});
