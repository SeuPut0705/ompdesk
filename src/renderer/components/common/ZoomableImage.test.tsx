import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OVERLAY_EXIT_MS } from "../../hooks/use-overlay-presence";
import { I18nProvider } from "../../lib/i18n";
import { ZoomableImage } from "./ZoomableImage";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

async function settle(ms = 0): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	await settle();
}

async function click(element: Element | null): Promise<void> {
	if (!element) throw new Error("missing element");
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await settle();
}

const viewer = () => document.body.querySelector('[role="dialog"]');

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
});

describe("ZoomableImage", () => {
	it("opens the picture full size on click, toggles actual size, and closes", async () => {
		await mount(<ZoomableImage alt="screenshot" className="max-h-48" src="data:image/png;base64,AAAA" />);
		expect(viewer()).toBeNull();

		await click(container.querySelector("[data-zoomable-image]"));
		const dialog = viewer();
		expect(dialog?.getAttribute("aria-label")).toBe("screenshot");
		expect(dialog?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");

		const toggle = dialog?.querySelector("[data-image-viewer]") ?? null;
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");
		await click(toggle);
		expect(viewer()?.querySelector("[data-image-viewer]")?.getAttribute("aria-pressed")).toBe("true");

		await click(viewer()?.querySelector('button[aria-label="Close"]') ?? null);
		await settle(OVERLAY_EXIT_MS + 20);
		expect(viewer()).toBeNull();

		// Reopening starts fitted again.
		await click(container.querySelector("[data-zoomable-image]"));
		expect(viewer()?.querySelector("[data-image-viewer]")?.getAttribute("aria-pressed")).toBe("false");
	});
});
