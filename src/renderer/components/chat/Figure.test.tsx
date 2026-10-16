/**
 * The figure header: one row, kind on the left, icon actions on the right.
 * Preview / Code switch the view and say which is showing (aria-pressed), every
 * icon has an English or Korean accessible name, and the buttons are plain
 * focusable <button>s in reading order.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";

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

// Loaded after linkedom's globals are installed: react-dom reads `document`/`window` at import.
const { createRoot } = await import("react-dom/client");
const { Figure } = await import("./Figure");

let root: Root | null = null;
let container: Element;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	container?.remove();
});

const picture = () => <div data-picture>the picture</div>;

function figure(extra: Partial<Parameters<typeof Figure>[0]> = {}): ReactElement {
	return (
		<Figure
			code="graph TD; A-->B"
			download={{ src: "data:image/svg+xml,x", name: "diagram.svg" }}
			kind="mermaid"
			language="mermaid"
			preview={picture}
			title="Mermaid"
			{...extra}
		/>
	);
}

const labels = () =>
	Array.from(container.querySelectorAll("[data-figure-header] button"), b => b.getAttribute("aria-label"));
const modeButton = (mode: string) => container.querySelector(`[data-figure-mode-button="${mode}"]`) as HTMLElement;

describe("Figure header", () => {
	it("is one row: the kind on the left, the actions on the right", async () => {
		await mount(figure());
		const headers = container.querySelectorAll("[data-figure-header]");
		expect(headers).toHaveLength(1);
		const header = headers[0] as Element;
		expect(header.className).toContain("justify-between");
		expect(header.className).toContain("--sc-control-sm");
		expect(header.firstElementChild?.textContent).toBe("Mermaid");
		expect(header.lastElementChild?.hasAttribute("data-figure-actions")).toBe(true);
		// No separate toggle row above the box: the header is the box's first child.
		expect(container.querySelector("[role=tab]")).toBeNull();
		expect(container.querySelector("[data-figure] > div > [data-figure-header]")).not.toBeNull();
	});

	it("names every icon, in reading order", async () => {
		await mount(figure({ zoomable: true }));
		expect(labels()).toEqual(["Preview", "Code", "Copy code", "Download as file", "Enlarge"]);
		const buttons = container.querySelectorAll("[data-figure-header] button");
		for (const button of buttons) {
			expect(button.getAttribute("type")).toBe("button");
			expect(button.getAttribute("tabindex")).not.toBe("-1");
		}
	});

	it("switches between the picture and the code, and marks the pressed view", async () => {
		await mount(figure());
		expect(container.querySelector("[data-picture]")).not.toBeNull();
		expect(modeButton("preview").getAttribute("aria-pressed")).toBe("true");
		expect(modeButton("code").getAttribute("aria-pressed")).toBe("false");

		await act(async () => {
			modeButton("code").focus();
			modeButton("code").click();
		});
		expect(container.querySelector("[data-picture]")).toBeNull();
		expect(container.textContent).toContain("A-->B");
		expect(modeButton("code").getAttribute("aria-pressed")).toBe("true");
		expect(modeButton("preview").getAttribute("aria-pressed")).toBe("false");
		// Still one header, and the toggle stays in the same place.
		expect(container.querySelectorAll("[data-figure-header]")).toHaveLength(1);
		expect(container.querySelector("[data-figure-title]")?.textContent).toBe("Mermaid");
		expect(labels().slice(0, 2)).toEqual(["Preview", "Code"]);

		await act(async () => {
			modeButton("preview").click();
		});
		expect(container.querySelector("[data-picture]")).not.toBeNull();
	});

	it("shows the enlarge button only on the picture", async () => {
		await mount(figure({ zoomable: true }));
		expect(container.querySelector("[data-figure-expand]")).not.toBeNull();
		await act(async () => {
			modeButton("code").click();
		});
		expect(container.querySelector("[data-figure-expand]")).toBeNull();
	});

	it("without a picture yet, is the plain code block with no switch", async () => {
		await mount(figure({ preview: null }));
		expect(container.querySelector("[data-figure-mode]")).toBeNull();
		expect(container.querySelector(".omp-code-block")).not.toBeNull();
		expect(container.querySelector("[data-figure-title]")?.textContent).toBe("Mermaid");
	});

	it("a custom code view replaces the code block inside the same box", async () => {
		await mount(figure({ codeView: <pre data-custom>the diff</pre> }));
		await act(async () => {
			modeButton("code").click();
		});
		expect(container.querySelector("[data-custom]")).not.toBeNull();
		expect(container.querySelector(".omp-code-block")).toBeNull();
		expect(container.querySelectorAll("[data-figure-header]")).toHaveLength(1);
	});

	it("is controlled when the caller passes the view", async () => {
		const seen: string[] = [];
		await mount(figure({ mode: "code", onModeChange: next => seen.push(next) }));
		expect(container.querySelector("[data-picture]")).toBeNull();
		await act(async () => {
			modeButton("preview").click();
		});
		expect(seen).toEqual(["preview"]);
	});
});
