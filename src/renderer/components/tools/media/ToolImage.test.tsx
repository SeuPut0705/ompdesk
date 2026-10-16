/**
 * A read image whose bytes cannot be drawn shows as its file — basename, opening
 * the file — never as a broken-image icon with a path for alt text.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { ReadRenderer } from "../renderers/ReadRenderer";
import { ToolImage } from "./ToolImage";

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

const PATH = "/tmp/ReloadTruth-real/scenarios/ko-group-1.png";

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

/** Stock's read of a PNG, image data as the journal holds it. */
function readResult(data: string) {
	return {
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: { fileSize: 120207, meta: { source: { type: "path", value: PATH } }, mediaPath: PATH },
	};
}

describe("read tool images", () => {
	it("draws the read picture, named by its file", async () => {
		await mount(<ReadRenderer args={{ path: PATH }} result={readResult("iVBORw0KGgo=")} />);
		const image = container.querySelector("img");
		expect(image?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
		expect(image?.getAttribute("alt")).toBe("ko-group-1.png");
	});

	it("shows a picture whose blob is gone as its file, in the card and the live stage", async () => {
		for (const livePreview of [false, true]) {
			await mount(
				<ReadRenderer
					args={{ path: PATH }}
					livePreview={livePreview}
					result={readResult(`blob:sha256:${"0".repeat(64)}`)}
				/>,
			);
			expect(container.querySelector("img")).toBeNull();
			const chip = container.querySelector("[data-image-unavailable]");
			expect(chip?.textContent).toContain("ko-group-1.png");
			expect(chip?.querySelector("button")?.getAttribute("title")).toBe(PATH);
			// The model-facing note is not dumped as file text.
			expect(container.querySelector("pre")).toBeNull();
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("falls back to the file chip when the picture fails to decode", async () => {
		await mount(<ToolImage src="data:image/png;base64,broken" path={PATH} />);
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		await act(async () => image?.dispatchEvent(new Event("error")));
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("[data-image-unavailable]")?.textContent).toContain("ko-group-1.png");
	});
});
