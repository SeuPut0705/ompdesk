/**
 * Figure rows: a reply paragraph of pictures only (a before/after pair, a gallery of screenshots) shows each picture
 * large with its alt text as caption, in one row that opens zoomed and steps through that row's pictures. A picture
 * inside prose stays inline, and a paragraph holding a video or a document is left as written. Linkedom harness.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IpcFsReadImageResult } from "../../shared/ipc-types";

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

const readImage = vi.fn(
	async (path: string): Promise<IpcFsReadImageResult> =>
		path.includes("gone")
			? { ok: false, dataUrl: null, mime: null, size: 0, error: "missing" }
			: { ok: true, dataUrl: `data:image/png;base64,${btoa(path)}`, mime: "image/png", size: 8 },
);
Object.assign(window, { omp: { fs: { readImage }, system: { openPath: vi.fn(async () => ({ ok: true })) } } });

// After the linkedom globals above: react-dom and the components read `document`/`window` when they load.
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("./i18n");
const { MarkdownRenderer, preloadMarkdownPipeline } = await import("./markdown");

let container: InstanceType<typeof HTMLElement>;
let root: Root;

beforeAll(() => preloadMarkdownPipeline());

async function render(content: string): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => root.render(<I18nProvider>{<MarkdownRenderer content={content} />}</I18nProvider>));
	for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

/** Each figure row as the captions of its pictures, in order. */
function rows(): string[][] {
	return [...container.querySelectorAll("[data-figure-row]")].map(row =>
		[...row.querySelectorAll("figure")].map(figure => figure.querySelector("figcaption")?.textContent ?? ""),
	);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	readImage.mockClear();
});

describe("figure rows in a reply", () => {
	it("shows a before/after pair as one captioned row that opens zoomed and steps to its partner", async () => {
		await render(
			[
				"Here is the changed look.",
				"",
				"![Before: the projects home](/shots/before.png)",
				"![After: one project open](/shots/after.png)",
			].join("\n"),
		);
		expect(rows()).toEqual([["Before: the projects home", "After: one project open"]]);
		expect(readImage.mock.calls.map(([path]) => path).sort()).toEqual(["/shots/after.png", "/shots/before.png"]);
		const pictures = container.querySelectorAll("[data-figure-row] [data-zoomable-image] img");
		expect([...pictures].map(img => img.getAttribute("src"))).toEqual([
			`data:image/png;base64,${btoa("/shots/before.png")}`,
			`data:image/png;base64,${btoa("/shots/after.png")}`,
		]);

		await act(async () => {
			container.querySelector("[data-zoomable-image]")?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		const viewer = () => document.body.querySelector('[role="dialog"]');
		const shown = () => viewer()?.querySelector("[data-image-viewer] img")?.getAttribute("alt");
		expect(shown()).toBe("Before: the projects home");
		expect(viewer()?.textContent).toContain("1 of 2");
		await act(async () => {
			viewer()
				?.querySelector('[aria-label="Next image"]')
				?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(shown()).toBe("After: one project open");
	});

	it("makes each paragraph of pictures its own row, and a gallery one row of all its pictures", async () => {
		await render(
			[
				"![Before](/shots/before.png) ![After](/shots/after.png)",
				"",
				"![Home](/shots/home.png)",
				"![Project](/shots/project.png)",
				"![Settings](/shots/settings.png)",
			].join("\n"),
		);
		expect(rows()).toEqual([
			["Before", "After"],
			["Home", "Project", "Settings"],
		]);
	});

	it("keeps a picture inside prose inline, and holds a video or document card in a block, never inside a <p>", async () => {
		await render(
			[
				"The chart ![chart](/shots/chart.png) shows the drop.",
				"",
				"![Before](/shots/before.png)",
				"![demo](/out/demo.mp4)",
				"",
				"![Shot](/shots/shot.png)",
				"![notes](/docs/q3.xlsx)",
			].join("\n"),
		);
		expect(rows()).toEqual([]);
		expect(container.querySelector("p")?.textContent).toContain("shows the drop.");
		expect(container.querySelectorAll(".omp-md-p")).toHaveLength(2);
		expect(container.querySelector("p [data-file-card], p video, p audio")).toBeNull();
	});

	it("shows a picture that cannot be read as its caption and path, never a broken image", async () => {
		await render(["![Before](/shots/gone.png)", "![After](/shots/after.png)"].join("\n"));
		expect(rows()).toEqual([["Before", "After"]]);
		const [first, second] = container.querySelectorAll("[data-figure-row] figure");
		expect(first?.querySelector("img")).toBeNull();
		expect(first?.textContent).toContain("/shots/gone.png");
		expect(second?.querySelector("img")).not.toBeNull();
	});
});
