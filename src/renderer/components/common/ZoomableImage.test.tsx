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

	it("covers only the chat pane it sits in, not the whole window", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		const pane = document.createElement("div");
		pane.className = "omp-session-pane";
		const sidebar = document.createElement("aside");
		container.append(sidebar, pane);
		root = createRoot(pane as unknown as Element);
		await act(async () =>
			root.render(
				<I18nProvider>
					<ZoomableImage alt="chart" src="data:image/png;base64,AAAA" />
				</I18nProvider>,
			),
		);
		await settle();

		await click(pane.querySelector("[data-zoomable-image]"));
		const overlay = viewer()?.parentElement;
		expect(overlay?.parentElement).toBe(pane);
		expect(overlay?.className).toContain("absolute");
		expect(overlay?.className).not.toContain("fixed");
		expect(sidebar.contains(viewer())).toBe(false);
		// A pane sits under the title bar: no room to leave for the window's controls.
		expect(viewer()?.querySelector("[data-image-viewer-head]")?.getAttribute("style") ?? "").not.toContain(
			"--sc-caption-buttons",
		);
	});

	it("keeps its own bar, named for the file, clear of the window's controls when it covers the window", async () => {
		await mount(<ZoomableImage alt="shot" path="C:\\shots\\login.png" src="data:image/png;base64,AAAA" />);
		await click(container.querySelector("[data-zoomable-image]"));
		const bar = viewer()?.querySelector<HTMLElement>("[data-image-viewer-head]");
		expect(bar?.textContent).toContain("login.png");
		expect(bar?.querySelector('button[aria-label="Close"]')).not.toBeNull();
		// The bar is not the picture's scroller: an actual-size picture scrolls under it.
		expect(bar?.contains(viewer()?.querySelector("[data-image-viewer]") ?? null)).toBe(false);
		// Windows draws its caption buttons over the window's top right, macOS its traffic lights over the top left.
		expect(bar?.getAttribute("style")).toContain("--sc-caption-buttons");
		expect(bar?.getAttribute("style")).toContain("--sc-traffic-lights");
	});

	it("steps through a gallery with its buttons and arrow keys, opening on the clicked picture", async () => {
		const gallery = ["a", "b", "c"].map(name => ({ src: `data:image/png;base64,${name}`, alt: `Picture ${name}` }));
		const openPath = async () => ({ ok: true });
		Reflect.set(window, "omp", { system: { openPath } });
		await mount(
			<div>
				{gallery.map(image => (
					<ZoomableImage alt={image.alt} gallery={gallery} key={image.src} src={image.src} />
				))}
			</div>,
		);
		await click(container.querySelectorAll("[data-zoomable-image]")[1] ?? null);
		const shown = () => viewer()?.querySelector("[data-image-viewer] img")?.getAttribute("alt");
		expect(shown()).toBe("Picture b");
		expect(viewer()?.textContent).toContain("2 of 3");
		await click(viewer()?.querySelector('[aria-label="Next image"]') ?? null);
		expect(shown()).toBe("Picture c");
		await click(viewer()?.querySelector('[aria-label="Next image"]') ?? null);
		expect(shown()).toBe("Picture a");
		await act(async () => {
			const key = new Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(key, { key: "ArrowLeft" });
			viewer()?.querySelector("[data-image-viewer]")?.dispatchEvent(key);
		});
		expect(shown()).toBe("Picture c");
		// No file behind these pictures: no default-app button.
		expect(viewer()?.querySelector('[aria-label="Open in default app"]')).toBeNull();
	});

	it("opens a file-backed picture in the default app", async () => {
		const opened: string[] = [];
		Reflect.set(window, "omp", {
			system: {
				openPath: async (path: string) => {
					opened.push(path);
					return { ok: true };
				},
			},
		});
		await mount(<ZoomableImage alt="Shot" path="/tmp/shot.png" src="data:image/png;base64,a" />);
		await click(container.querySelector("[data-zoomable-image]"));
		await click(viewer()?.querySelector('[aria-label="Open in default app"]') ?? null);
		expect(opened).toEqual(["/tmp/shot.png"]);
	});

	it("right-click offers open, copy, save and, for an attachment, remove", async () => {
		const saved: unknown[][] = [];
		Reflect.set(window, "omp", {
			system: {
				saveImage: async (...args: unknown[]) => {
					saved.push(args);
					return { saved: true };
				},
			},
		});
		const fetched = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => ({ blob: async () => fetched })) as unknown as typeof fetch;
		let removed = 0;
		try {
			await mount(
				<ZoomableImage
					alt="Pasted"
					onRemove={() => {
						removed++;
					}}
					src="data:image/png;base64,AQI="
				/>,
			);
			const contextMenu = async () => {
				await act(async () => {
					const event = new Event("contextmenu", { bubbles: true, cancelable: true });
					Object.assign(event, { clientX: 10, clientY: 10 });
					container.querySelector("[data-zoomable-image]")?.dispatchEvent(event);
				});
			};
			await contextMenu();
			const labels = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map(item => item.textContent);
			expect(labels).toEqual(["Open", "Copy image", "Save image as…", "Remove"]);
			await click(
				Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
					item => item.textContent === "Save image as…",
				) ?? null,
			);
			expect(saved).toEqual([["Pasted", "image/png", "AQI="]]);
			await contextMenu();
			await click(
				Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
					item => item.textContent === "Remove",
				) ?? null,
			);
			expect(removed).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
